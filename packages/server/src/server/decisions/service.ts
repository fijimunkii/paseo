import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  CreateAgentToolDecisionPolicyConfig,
  DecisionConfig,
  DecisionFailureDisposition,
  OrchestrationDecisionPolicyConfig,
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
  ORCHESTRATION_CHECKPOINT_DECISION,
  ORCHESTRATION_TASK_DECISION,
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

export interface DecisionOutcome {
  fingerprint: string;
  mode: "shadow" | "enforce";
  model: string | null;
  actualDisposition: DecisionDisposition;
  wouldDisposition: DecisionDisposition;
  reused: boolean;
}

export interface DecisionAuthorization extends DecisionOutcome {
  permit: DecisionPermit | null;
}

export interface OrchestrationDecisionInput {
  state: DecisionEntry;
  context?: DecisionContext;
  signal: AbortSignal;
}

interface RuntimeDecisionPolicy {
  minimumConfidence: number;
  failureDisposition: DecisionFailureDisposition;
  fingerprintMaterial: JsonValue;
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

const ALLOW: DecisionDisposition = { kind: "allow" };

function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Failed to serialize decision string");
    }
    return serialized;
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

function callerAbortError(): TypeSafeDecisionError {
  return new TypeSafeDecisionError("aborted", "Decision request was canceled");
}

async function awaitWithCallerAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw callerAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(callerAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        return reject(error);
      },
    );
  });
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

  async authorizeAgentCreate(
    input: AgentCreateDecisionInput,
  ): Promise<DecisionAuthorization | null> {
    const policyConfig = this.config.policies.createAgentTool;
    if (!policyConfig?.enabled) {
      return null;
    }

    const policy = this.createAgentPolicy(policyConfig);
    const outcome = await this.decide({
      definition: AGENT_CREATE_DECISION,
      policy,
      state: input.state,
      context: input.context,
      signal: input.signal,
    });
    const operationFingerprint = this.operationFingerprint(
      AGENT_CREATE_DECISION,
      policy,
      input.operation,
    );
    const permit =
      outcome.actualDisposition.kind === "allow"
        ? this.permitIssuer.issue({
            decisionFingerprint: outcome.fingerprint,
            operationFingerprint,
            model: outcome.model,
            disposition: "allow",
          })
        : null;
    return { ...outcome, permit };
  }

  async assessOrchestrationTask(
    input: OrchestrationDecisionInput,
  ): Promise<DecisionOutcome | null> {
    const policyConfig = this.config.policies.orchestration;
    if (!policyConfig?.enabled) {
      return null;
    }
    return this.decide({
      definition: ORCHESTRATION_TASK_DECISION,
      policy: this.orchestrationPolicy(policyConfig),
      state: input.state,
      context: input.context,
      signal: input.signal,
    });
  }

  async assessOrchestrationCheckpoint(
    input: OrchestrationDecisionInput,
  ): Promise<DecisionOutcome | null> {
    const policyConfig = this.config.policies.orchestration;
    if (!policyConfig?.enabled) {
      return null;
    }
    return this.decide({
      definition: ORCHESTRATION_CHECKPOINT_DECISION,
      policy: this.orchestrationPolicy(policyConfig),
      state: input.state,
      context: input.context,
      signal: input.signal,
    });
  }

  consumeAgentCreatePermit(permit: DecisionPermit, operation: JsonValue): void {
    const policyConfig = this.config.policies.createAgentTool;
    if (!policyConfig?.enabled) {
      throw new Error("Agent-create decision policy is not enabled");
    }
    const fingerprint = this.operationFingerprint(
      AGENT_CREATE_DECISION,
      this.createAgentPolicy(policyConfig),
      operation,
    );
    this.permitIssuer.consume(permit, fingerprint);
  }

  private async decide(input: {
    definition: DecisionDefinition;
    policy: RuntimeDecisionPolicy;
    state: DecisionEntry;
    context?: DecisionContext;
    signal: AbortSignal;
  }): Promise<DecisionOutcome> {
    if (input.signal.aborted) {
      throw callerAbortError();
    }
    const fingerprint = this.decisionFingerprint(input.definition, input.policy, input.state);
    let cached = this.cache.get(fingerprint) ?? null;
    if (!cached) {
      try {
        cached = this.auditStore.get(fingerprint);
      } catch (error) {
        this.logger.warn({ err: error, fingerprint }, "Failed to read decision audit record");
        if (this.config.mode === "enforce") {
          return this.failClosedOutcome(fingerprint, input.policy.failureDisposition);
        }
      }
    }
    if (cached) {
      this.cache.set(fingerprint, cached);
      return this.outcomeFromRecord(cached, true);
    }

    let pending = this.inFlight.get(fingerprint);
    if (!pending) {
      const created = this.evaluate({
        ...input,
        signal: new AbortController().signal,
        fingerprint,
      });
      pending = created;
      this.inFlight.set(fingerprint, created);
      void created.then(
        () => this.clearInFlight(fingerprint, created),
        () => this.clearInFlight(fingerprint, created),
      );
    }

    const record = await awaitWithCallerAbort(pending, input.signal);
    return this.outcomeFromRecord(record, false);
  }

  private clearInFlight(fingerprint: string, pending: Promise<DecisionAuditRecord>): boolean {
    if (this.inFlight.get(fingerprint) !== pending) {
      return false;
    }
    return this.inFlight.delete(fingerprint);
  }

  private async evaluate(input: {
    definition: DecisionDefinition;
    policy: RuntimeDecisionPolicy;
    state: DecisionEntry;
    context?: DecisionContext;
    signal: AbortSignal;
    fingerprint: string;
  }): Promise<DecisionAuditRecord> {
    const startedAt = this.now();
    const definitionHash = this.definitionHash(input.definition);
    const policyHash = this.policyHash(input.definition, input.policy);
    const requestedModel = this.config.typesafe?.model ?? "jev-latest";

    let record: DecisionAuditRecord;
    if (!this.engine) {
      const wouldDisposition = failureDisposition(input.policy.failureDisposition);
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
        if (this.config.mode === "enforce" && result.model !== requestedModel) {
          const disposition = failureDisposition(input.policy.failureDisposition);
          record = {
            fingerprint: input.fingerprint,
            createdAt: new Date(startedAt).toISOString(),
            definitionId: input.definition.id,
            definitionVersion: input.definition.version,
            definitionHash,
            policyVersion: input.definition.policyVersion,
            policyHash,
            requestedModel,
            model: result.model,
            mode: this.config.mode,
            status: "failed",
            wouldDisposition: disposition,
            actualDisposition: disposition,
            usage: result.usage,
            latencyMs: Math.max(0, this.now() - startedAt),
            errorKind: "model_mismatch",
            ...(input.context ? { context: input.context } : {}),
          };
        } else {
          const wouldDisposition = input.definition.resolve(
            result.answers,
            input.policy.minimumConfidence,
          );
          record = {
            fingerprint: input.fingerprint,
            createdAt: new Date(startedAt).toISOString(),
            definitionId: input.definition.id,
            definitionVersion: input.definition.version,
            definitionHash,
            policyVersion: input.definition.policyVersion,
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
        }
      } catch (error) {
        if (
          input.signal.aborted &&
          error instanceof TypeSafeDecisionError &&
          error.kind === "aborted"
        ) {
          throw error;
        }
        const wouldDisposition = failureDisposition(input.policy.failureDisposition);
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

    try {
      this.auditStore.put(record);
    } catch (error) {
      this.logger.warn(
        { err: error, fingerprint: record.fingerprint },
        "Failed to persist decision audit record",
      );
      if (this.config.mode === "enforce") {
        record = {
          ...record,
          status: "failed",
          wouldDisposition: failureDisposition(input.policy.failureDisposition),
          actualDisposition: failureDisposition(input.policy.failureDisposition),
          errorKind: "audit_write_failed",
        };
      }
    }
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
      policyVersion: input.definition.policyVersion,
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

  private failClosedOutcome(
    fingerprint: string,
    disposition: DecisionFailureDisposition,
  ): DecisionOutcome {
    const resolved = failureDisposition(disposition);
    return {
      fingerprint,
      mode: "enforce",
      model: null,
      actualDisposition: resolved,
      wouldDisposition: resolved,
      reused: false,
    };
  }

  private outcomeFromRecord(record: DecisionAuditRecord, reused: boolean): DecisionOutcome {
    return {
      fingerprint: record.fingerprint,
      mode: record.mode,
      model: record.model,
      actualDisposition: record.actualDisposition,
      wouldDisposition: record.wouldDisposition,
      reused,
    };
  }

  private decisionFingerprint(
    definition: DecisionDefinition,
    policy: RuntimeDecisionPolicy,
    state: DecisionEntry,
  ): string {
    return digest(this.policyHash(definition, policy) + "\nstate\n" + canonicalJson(state));
  }

  private operationFingerprint(
    definition: DecisionDefinition,
    policy: RuntimeDecisionPolicy,
    operation: JsonValue,
  ): string {
    return digest(this.policyHash(definition, policy) + "\n" + canonicalJson(operation));
  }

  private definitionHash(definition: DecisionDefinition): string {
    return digest(
      definition.id + "\n" + definition.version + "\n" + JSON.stringify(definition.questions),
    );
  }

  private policyHash(
    definition: DecisionDefinition,
    policy: RuntimeDecisionPolicy,
  ): string {
    const material: JsonValue = {
      definitionHash: this.definitionHash(definition),
      policyVersion: definition.policyVersion,
      mode: this.config.mode,
      engine: "typesafe-jev",
      engineEnabled: this.config.typesafe?.enabled ?? false,
      engineAvailable: this.engine !== null,
      baseUrl: this.config.typesafe?.baseUrl ?? "https://api.typesafe.ai",
      requestedModel: this.config.typesafe?.model ?? "jev-latest",
      policy: policy.fingerprintMaterial,
    };
    return digest(canonicalJson(material));
  }


  private createAgentPolicy(
    policy: CreateAgentToolDecisionPolicyConfig,
  ): RuntimeDecisionPolicy {
    return {
      minimumConfidence: policy.minimumConfidence,
      failureDisposition: policy.failureDisposition,
      fingerprintMaterial: {
        enabled: policy.enabled,
        minimumConfidence: policy.minimumConfidence,
        failureDisposition: policy.failureDisposition,
      },
    };
  }

  private orchestrationPolicy(
    policy: OrchestrationDecisionPolicyConfig,
  ): RuntimeDecisionPolicy {
    const lanes = policy.lanes
      ? {
          small: this.lanePolicyMaterial(policy.lanes.small),
          medium: this.lanePolicyMaterial(policy.lanes.medium),
          high: this.lanePolicyMaterial(policy.lanes.high),
          escalated: this.lanePolicyMaterial(policy.lanes.escalated),
        }
      : null;
    return {
      minimumConfidence: policy.minimumConfidence,
      failureDisposition: policy.failureDisposition,
      fingerprintMaterial: {
        enabled: policy.enabled,
        minimumConfidence: policy.minimumConfidence,
        failureDisposition: policy.failureDisposition,
        defaultRouting: policy.defaultRouting,
        maxAttempts: policy.maxAttempts,
        maxEscalations: policy.maxEscalations,
        lanes,
      },
    };
  }

  private lanePolicyMaterial(lane: {
    provider: string;
    model: string;
    thinkingOptionId?: string;
  }): JsonValue {
    return {
      provider: lane.provider,
      model: lane.model,
      ...(lane.thinkingOptionId ? { thinkingOptionId: lane.thinkingOptionId } : {}),
    };
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
