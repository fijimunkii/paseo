import { describe, expect, test } from "vitest";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

import type { DecisionResult } from "./engine.js";
import type { DecisionAuditRecord, DecisionAuditStoreLike } from "./audit.js";
import { DecisionService } from "./service.js";
import { TypeSafeDecisionError, type TypeSafeDecisionEngine } from "./typesafe/client.js";

class MemoryAuditStore implements DecisionAuditStoreLike {
  readonly records = new Map<string, DecisionAuditRecord>();

  get(fingerprint: string): DecisionAuditRecord | null {
    return this.records.get(fingerprint) ?? null;
  }

  put(record: DecisionAuditRecord): void {
    this.records.set(record.fingerprint, record);
  }
}

class FakeEngine implements TypeSafeDecisionEngine {
  readonly id = "typesafe-jev";
  calls = 0;

  constructor(
    private readonly run: () => DecisionResult | Promise<DecisionResult>,
  ) {}

  async evaluate(): Promise<DecisionResult> {
    this.calls += 1;
    return this.run();
  }

  async listModels() {
    return [];
  }
}

const logger = {
  info() {},
  warn() {},
};

function config(input?: {
  mode?: "shadow" | "enforce";
  minimumConfidence?: number;
  failureDisposition?: "review" | "deny";
}) {
  return {
    mode: input?.mode ?? "shadow",
    typesafe: {
      enabled: true,
      baseUrl: "https://api.typesafe.ai",
      model: input?.mode === "enforce" ? "jev-1.13.0" : "jev-latest",
      timeoutMs: 10_000,
      maxConcurrency: 4,
      apiKey: "secret",
    },
    policies: {
      agentCreate: {
        enabled: true,
        minimumConfidence: input?.minimumConfidence ?? 0.9,
        failureDisposition: input?.failureDisposition ?? "review",
      },
    },
  } as const;
}

function result(choice: "allow" | "review" | "deny", confidence = 0.99): DecisionResult {
  return {
    engine: "typesafe-jev",
    model: "jev-1.13.0",
    answers: {
      disposition: {
        type: "choice",
        choice,
        confidence,
        probabilities: {
          allow: choice === "allow" ? confidence : 0.01,
          review: choice === "review" ? confidence : 0.01,
          deny: choice === "deny" ? confidence : 0.01,
        },
      },
    },
    usage: {
      inputTokens: 20,
      outputTokens: 4,
    },
  };
}

const operation = {
  tool: "create_agent",
  callerAgentId: "agent_parent",
  request: {
    provider: "codex/gpt-5.6",
    initialPrompt: "Inspect the failing test",
  },
} satisfies JsonValue;

describe("DecisionService", () => {
  test("records a shadow deny without changing execution", async () => {
    const auditStore = new MemoryAuditStore();
    const engine = new FakeEngine(() => result("deny"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config(),
      logger,
      engine,
      auditStore,
      now: () => 1_000,
    });

    const authorization = await service.authorizeAgentCreate({
      operation,
      state: operation,
      context: { agentId: "agent_parent", tool: "create_agent" },
      signal: new AbortController().signal,
    });

    expect(authorization).toMatchObject({
      mode: "shadow",
      actualDisposition: { kind: "allow" },
      wouldDisposition: { kind: "deny" },
      reused: false,
    });
    expect(authorization?.permit).not.toBeNull();

    const record = [...auditStore.records.values()][0];
    expect(record).toMatchObject({
      mode: "shadow",
      status: "resolved",
      actualDisposition: { kind: "allow" },
      wouldDisposition: { kind: "deny" },
      model: "jev-1.13.0",
    });
    expect(record).not.toHaveProperty("state");
    expect(record).not.toHaveProperty("operation");
  });

  test("maps low-confidence enforcement decisions to review", async () => {
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce", minimumConfidence: 0.95 }),
      logger,
      engine: new FakeEngine(() => result("allow", 0.8)),
      auditStore: new MemoryAuditStore(),
      now: () => 1_000,
    });

    const authorization = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(authorization).toMatchObject({
      actualDisposition: { kind: "review" },
      wouldDisposition: { kind: "review" },
    });
    expect(authorization?.permit).toBeNull();
  });

  test("reuses one semantic sample for the same operation", async () => {
    const auditStore = new MemoryAuditStore();
    const engine = new FakeEngine(() => result("allow"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce" }),
      logger,
      engine,
      auditStore,
      now: () => 1_000,
    });

    const first = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });
    const second = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(first?.reused).toBe(false);
    expect(second?.reused).toBe(true);
    expect(engine.calls).toBe(1);
  });

  test("binds a single-use permit to the exact operation", async () => {
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce" }),
      logger,
      engine: new FakeEngine(() => result("allow")),
      auditStore: new MemoryAuditStore(),
      now: () => 1_000,
    });

    const authorization = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });
    expect(authorization?.permit).not.toBeNull();
    if (!authorization?.permit) {
      throw new Error("Expected an allow permit");
    }

    const changedOperation: JsonValue = {
      ...operation,
      request: {
        provider: "claude/sonnet",
        initialPrompt: "Different operation",
      },
    };
    const permit = authorization.permit;
    expect(() =>
      service.consumeAgentCreatePermit(permit, changedOperation),
    ).toThrow("does not match");

    expect(() =>
      service.consumeAgentCreatePermit(permit, operation),
    ).toThrow("missing or already consumed");
  });

  test("maps TypeSafe failure to the configured fail-closed disposition", async () => {
    const engine = new FakeEngine(() => {
      throw new TypeSafeDecisionError("network", "network unavailable");
    });
    const auditStore = new MemoryAuditStore();
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce", failureDisposition: "deny" }),
      logger,
      engine,
      auditStore,
      now: () => 1_000,
    });

    const authorization = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(authorization).toMatchObject({
      actualDisposition: { kind: "deny" },
      wouldDisposition: { kind: "deny" },
      permit: null,
    });
    expect([...auditStore.records.values()][0]).toMatchObject({
      status: "failed",
      errorKind: "network",
    });
  });

  test("does nothing when the agent-create policy is disabled", async () => {
    const engine = new FakeEngine(() => result("allow"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: {
        ...config(),
        policies: {},
      },
      logger,
      engine,
      auditStore: new MemoryAuditStore(),
    });

    await expect(
      service.authorizeAgentCreate({
        operation,
        state: operation,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(engine.calls).toBe(0);
  });
});
