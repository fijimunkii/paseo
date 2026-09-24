import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentCreateDecisionPolicyConfig,
  DecisionConfig,
  DecisionFailureDisposition,
  TypeSafeDecisionConfig,
} from "@getpaseo/protocol/decision-config";

import type { DecisionEntry } from "./engine.js";
import {
  DecisionAuditStore,
  type DecisionAuditRecord,
  type DecisionAuditStoreLike,
} from "./audit.js";
import { DecisionPermitIssuer, type DecisionPermit } from "./permit.js";
import {
  AGENT_CREATE_DECISION,
  type DecisionDefinition,
  type DecisionDisposition,
} from "./policy.js";
import {
  createTypeSafeDecisionEngine,
  TypeSafeDecisionError,
  type TypeSafeDecisionEngine,
} from "./typesafe/client.js";

export interface DecisionRuntimeConfig extends Omit<DecisionConfig, "typesafe"> {
  typesafe?: TypeSafeDecisionConfig & { apiKey?: string };
}

export interface DecisionContext {
  agentId?: string;
  tool?: string;
}

export interface AgentCreateDecisionInput {
  operation: JsonValue;
  state: DecisionEntry;
  context?: DecisionContext;
  signal: AbortSignal;
}

export interface DecisionAuthorization {
  fingerprint: string;
  mode: "shadow" | "enforce";
  actualDisposition: DecisionDisposition;
  wouldDisposition: DecisionDisposition;
  reused: boolean;
  permit: DecisionPermit | null;
}

interface DecisionServiceOptions {
  paseoHome: string;
  config: DecisionRuntimeConfig;
  logger: Pick<Logger, "info" | "warn">;
  engine?: TypeSafeDecisionEngine | null;
  auditStore?: DecisionAuditStoreLike;
  permitIssuer?: DecisionPermitIssuer;
  now?: () => number;
}

interface ResolvedPolicy {
  definition: DecisionDefinition;
  config: AgentCreateDecisionPolicyConfig;
}

const ALLOW: DecisionDisposition = { kind: "allow" };

function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value) ?? "\"\"";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Decision operation contains a non-finite number");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failureDisposition(kind: DecisionFailureDisposition): DecisionDisposition {
  return kind === "deny" ? { kind: "deny" } : { kind: "review" };
}

function errorKind(error: unknown): string {
  if (error instanceof TypeSafeDecisionError) {
    return error.kind;
  }
  return "unknown";
}

export class DecisionService {
  private readonly config: DecisionRuntimeConfig;
  private readonly logger: Pick<Logger, "info" | "warn">;
  private readonly engine: TypeSafeDecisionEngine | null;
  private readonly auditStore: DecisionAuditStoreLike;
  private readonly permitIssuer: DecisionPermitIssuer;
  private readonly now: () => number;
  private readonly cache = new Map<string, DecisionAuditRecord>();
  private readonly inFlight = new Map<string, Promise<DecisionAuditRecord>>();

  constructor(options: DecisionServiceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.auditStore = options.auditStore ?? new DecisionAuditStore(options.paseoHome);
    this.permitIssuer = options.permitIssuer ?? new DecisionPermitIssuer();
    this.now = options.now ?? Date.now;

    if (options.engine !== undefined) {
      this.engine = options.engine;
      return;
    }

    const typesafe = options.config.typesafe;
    this.engine =
      typesafe?.enabled && typesafe.apiKey
        ? createTypeSafeDecisionEngine({
            apiKey: typesafe.apiKey,
            baseUrl: typesafe.baseUrl,
            timeoutMs: typesafe.timeoutMs,
            maxConcurrency: typesafe.maxConcurrency,
          })
        : null;
  }

  isAgentCreateEnabled(): boolean {
    return this.config.policies.agentCreate?.enabled === true;
  }

  async authorizeAgentCreate(input: AgentCreateDecisionInput): Promise<DecisionAuthorization | null> {
    const policyConfig = this.config.policies.agentCreate;
    if (!policyConfig?.enabled) {
      return null;
    }

    return this.authorize({
      definition: AGENT_CREATE_DECISION,
      policy: { definition: AGENT_CREATE_DECISION, config: policyConfig },
      operation: input.operation,
      state: input.state,
      context: input.context,
      signal: input.signal,
    });
  }

  consumeAgentCreatePermit(permit: DecisionPermit, operation: JsonValue): void {
    const policyConfig = this.config.policies.agentCreate;
    if (!policyConfig?.enabled) {
      throw new Error("Agent-create decision policy is not enabled");
    }
    const fingerprint = this.operationFingerprint(
      AGENT_CREATE_DECISION,
      policyConfig,
      operation,
    );
    this.permitIssuer.consume(permit, fingerprint);
  }

  private async authorize(input: {
    definition: DecisionDefinition;
    policy: ResolvedPolicy;
    operation: JsonValue;
    state: DecisionEntry;
    context?: DecisionContext;
    signal: AbortSignal;
  }): Promise<DecisionAuthorization> {
    const fingerprint = this.operationFingerprint(
      input.definition,
      input.policy.config,
      input.operation,
    );
    const cached = this.cache.get(fingerprint) ?? this.auditStore.get(fingerprint);
    if (cached) {
      this.cache.set(fingerprint, cached);
      return this.authorizationFromRecord(cached, true);
    }

    let pending = this.inFlight.get(fingerprint);
    if (!pending) {
      pending = this.evaluate({
        ...input,
        fingerprint,
      });
      this.inFlight.set(fingerprint, pending);
    }

    try {
      const record = await pending;
      return this.authorizationFromRecord(record, false);
    } finally {
      if (this.inFlight.get(fingerprint) === pending) {
        this.inFlight.delete(fingerprint);
      }
    }
  }

  private async evaluate(input: {
    definition: DecisionDefinition;
    policy: ResolvedPolicy;
    operation: JsonValue;
    state: DecisionEntry;
    context?: DecisionContext;
    signal: AbortSignal;
    fingerprint: string;
  }): Promise<DecisionAuditRecord> {
    const startedAt = this.now();
    const definitionHash = this.definitionHash(input.definition);
    const policyHash = this.policyHash(input.definition, input.policy.config);
    const requestedModel = this.config.typesafe?.model ?? "jev-latest";

    let record: DecisionAuditRecord;
    if (!this.engine) {
      const wouldDisposition = failureDisposition(input.policy.config.failureDisposition);
      record = this.failureRecord({
        ...input,
        startedAt,
        definitionHash,
        policyHash,
        requestedModel,
        wouldDisposition,
        errorKind: "unavailable",
      });
    } else {
      try {
        const result = await this.engine.evaluate(
          {
            state: input.state,
            questions: input.definition.questions,
            model: requestedModel,
          },
          { signal: input.signal },
        );
        const wouldDisposition = input.definition.resolve(
          result.answers,
          input.policy.config.minimumConfidence,
        );
        record = {
          fingerprint: input.fingerprint,
          createdAt: new Date(startedAt).toISOString(),
          definitionId: input.definition.id,
          definitionVersion: input.definition.version,
          definitionHash,
          policyHash,
          requestedModel,
          model: result.model,
          mode: this.config.mode,
          status: "resolved",
          wouldDisposition,
          actualDisposition: this.config.mode === "shadow" ? ALLOW : wouldDisposition,
          answers: result.answers,
          usage: result.usage,
          latencyMs: Math.max(0, this.now() - startedAt),
          ...(input.context ? { context: input.context } : {}),
        };
      } catch (error) {
        const wouldDisposition = failureDisposition(input.policy.config.failureDisposition);
        record = this.failureRecord({
          ...input,
          startedAt,
          definitionHash,
          policyHash,
          requestedModel,
          wouldDisposition,
          errorKind: errorKind(error),
        });
      }
    }

    this.auditStore.put(record);
    this.cache.set(record.fingerprint, record);
    this.logger.info(
      {
        fingerprint: record.fingerprint,
        definitionId: record.definitionId,
        model: record.model,
        requestedModel: record.requestedModel,
        mode: record.mode,
        status: record.status,
        wouldDisposition: record.wouldDisposition.kind,
        actualDisposition: record.actualDisposition.kind,
        latencyMs: record.latencyMs,
      },
      "Decision evaluated",
    );
    return record;
  }

  private failureRecord(input: {
    definition: DecisionDefinition;
    context?: DecisionContext;
    fingerprint: string;
    startedAt: number;
    definitionHash: string;
    policyHash: string;
    requestedModel: string;
    wouldDisposition: DecisionDisposition;
    errorKind: string;
  }): DecisionAuditRecord {
    return {
      fingerprint: input.fingerprint,
      createdAt: new Date(input.startedAt).toISOString(),
      definitionId: input.definition.id,
      definitionVersion: input.definition.version,
      definitionHash: input.definitionHash,
      policyHash: input.policyHash,
      requestedModel: input.requestedModel,
      model: null,
      mode: this.config.mode,
      status: "failed",
      wouldDisposition: input.wouldDisposition,
      actualDisposition: this.config.mode === "shadow" ? ALLOW : input.wouldDisposition,
      latencyMs: Math.max(0, this.now() - input.startedAt),
      errorKind: input.errorKind,
      ...(input.context ? { context: input.context } : {}),
    };
  }

  private authorizationFromRecord(
    record: DecisionAuditRecord,
    reused: boolean,
  ): DecisionAuthorization {
    const permit =
      record.actualDisposition.kind === "allow"
        ? this.permitIssuer.issue(record.fingerprint)
        : null;
    return {
      fingerprint: record.fingerprint,
      mode: record.mode,
      actualDisposition: record.actualDisposition,
      wouldDisposition: record.wouldDisposition,
      reused,
      permit,
    };
  }

  private operationFingerprint(
    definition: DecisionDefinition,
    policy: AgentCreateDecisionPolicyConfig,
    operation: JsonValue,
  ): string {
    return digest(
      this.policyHash(definition, policy) + "\n" + canonicalJson(operation),
    );
  }

  private definitionHash(definition: DecisionDefinition): string {
    return digest(
      definition.id + "\n" + definition.version + "\n" + JSON.stringify(definition.questions),
    );
  }

  private policyHash(
    definition: DecisionDefinition,
    policy: AgentCreateDecisionPolicyConfig,
  ): string {
    const material: JsonValue = {
      definitionHash: this.definitionHash(definition),
      mode: this.config.mode,
      engine: "typesafe-jev",
      engineEnabled: this.config.typesafe?.enabled ?? false,
      engineAvailable: this.engine !== null,
      baseUrl: this.config.typesafe?.baseUrl ?? "https://api.typesafe.ai",
      requestedModel: this.config.typesafe?.model ?? "jev-latest",
      minimumConfidence: policy.minimumConfidence,
      failureDisposition: policy.failureDisposition,
    };
    return digest(canonicalJson(material));
  }
}

export function createDecisionService(options: {
  paseoHome: string;
  config: DecisionRuntimeConfig | undefined;
  logger: Pick<Logger, "info" | "warn">;
}): DecisionService | null {
  if (!options.config) {
    return null;
  }
  return new DecisionService({
    paseoHome: options.paseoHome,
    config: options.config,
    logger: options.logger,
  });
}
