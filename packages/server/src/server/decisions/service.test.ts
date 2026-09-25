import { describe, expect, test, vi } from "vitest";
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

class FaultyAuditStore implements DecisionAuditStoreLike {
  constructor(private readonly failure: "read" | "write") {}

  get(): DecisionAuditRecord | null {
    if (this.failure === "read") {
      throw new Error("audit read failed");
    }
    return null;
  }

  put(): void {
    if (this.failure === "write") {
      throw new Error("audit write failed");
    }
  }
}

class FakeEngine implements TypeSafeDecisionEngine {
  readonly id = "typesafe-jev";
  calls = 0;

  constructor(private readonly run: () => DecisionResult | Promise<DecisionResult>) {}

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
      model: input?.mode === "enforce" ? "jev-pinned-test" : "jev-latest",
      timeoutMs: 10_000,
      maxConcurrency: 4,
      apiKey: "secret",
    },
    policies: {
      createAgentTool: {
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
    model: "jev-pinned-test",
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
      model: "jev-pinned-test",
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

  test("deduplicates concurrent evaluations of the same operation", async () => {
    let resolveResult: ((value: DecisionResult) => void) | null = null;
    const pending = new Promise<DecisionResult>((resolve) => {
      resolveResult = resolve;
    });
    const engine = new FakeEngine(() => pending);
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce" }),
      logger,
      engine,
      auditStore: new MemoryAuditStore(),
      now: () => 1_000,
    });

    const first = service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });
    const second = service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(engine.calls).toBe(1);
    if (!resolveResult) {
      throw new Error("Expected pending decision resolver");
    }
    resolveResult(result("allow"));

    const [firstAuthorization, secondAuthorization] = await Promise.all([first, second]);
    expect(firstAuthorization?.fingerprint).toBe(secondAuthorization?.fingerprint);
    expect(firstAuthorization?.permit?.id).not.toBe(secondAuthorization?.permit?.id);
    expect(engine.calls).toBe(1);
  });

  test("reuses one Jev sample when only non-projected operation fields change", async () => {
    const engine = new FakeEngine(() => result("allow"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce" }),
      logger,
      engine,
      auditStore: new MemoryAuditStore(),
      now: () => 1_000,
    });
    const decisionState: JsonValue = {
      provider: "codex/gpt-5.6",
      initialPrompt: "Inspect the failing test",
    };
    const firstOperation: JsonValue = {
      ...operation,
      labels: { purpose: "first" },
      settings: { features: { hidden: "one" } },
    };
    const secondOperation: JsonValue = {
      ...operation,
      labels: { purpose: "second" },
      settings: { features: { hidden: "two" } },
    };

    const first = await service.authorizeAgentCreate({
      operation: firstOperation,
      state: decisionState,
      signal: new AbortController().signal,
    });
    const second = await service.authorizeAgentCreate({
      operation: secondOperation,
      state: decisionState,
      signal: new AbortController().signal,
    });

    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.permit?.operationFingerprint).not.toBe(second?.permit?.operationFingerprint);
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
    expect(() => service.consumeAgentCreatePermit(permit, changedOperation)).toThrow(
      "does not match",
    );

    expect(() => service.consumeAgentCreatePermit(permit, operation)).toThrow(
      "missing or already consumed",
    );
  });

  test("propagates caller cancellation before starting a semantic sample", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new FakeEngine(() => result("allow"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config(),
      logger,
      engine,
      auditStore: new MemoryAuditStore(),
      now: () => 1_000,
    });

    await expect(
      service.authorizeAgentCreate({
        operation,
        state: operation,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(engine.calls).toBe(0);
  });

  test("canceling one waiter keeps the shared semantic sample deduped until it settles", async () => {
    let resolveResult: ((value: DecisionResult) => void) | null = null;
    const pending = new Promise<DecisionResult>((resolve) => {
      resolveResult = resolve;
    });
    const engine = new FakeEngine(() => pending);
    const auditStore = new MemoryAuditStore();
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce" }),
      logger,
      engine,
      auditStore,
      now: () => 1_000,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: firstController.signal,
    });
    const second = service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: secondController.signal,
    });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ kind: "aborted" });
    expect(engine.calls).toBe(1);

    const third = service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });
    expect(engine.calls).toBe(1);

    if (!resolveResult) {
      throw new Error("Expected pending decision resolver");
    }
    resolveResult(result("allow"));

    await expect(second).resolves.toMatchObject({
      actualDisposition: { kind: "allow" },
      reused: false,
    });
    await expect(third).resolves.toMatchObject({
      actualDisposition: { kind: "allow" },
      reused: false,
    });
    expect(engine.calls).toBe(1);
    expect(auditStore.records.size).toBe(1);
  });

  test("fails closed when TypeSafe returns a different model than the pinned request", async () => {
    const mismatched = {
      ...result("allow"),
      model: "jev-other",
    };
    const auditStore = new MemoryAuditStore();
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce", failureDisposition: "deny" }),
      logger,
      engine: new FakeEngine(() => mismatched),
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
      requestedModel: "jev-pinned-test",
      model: "jev-other",
      errorKind: "model_mismatch",
    });
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
    const repeated = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(authorization).toMatchObject({
      actualDisposition: { kind: "deny" },
      wouldDisposition: { kind: "deny" },
      permit: null,
    });
    expect(repeated).toMatchObject({
      actualDisposition: { kind: "deny" },
      wouldDisposition: { kind: "deny" },
      reused: true,
      permit: null,
    });
    expect(engine.calls).toBe(1);
    expect([...auditStore.records.values()][0]).toMatchObject({
      status: "failed",
      errorKind: "network",
    });
  });

  test("keeps shadow execution permissive when audit persistence fails", async () => {
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config(),
      logger,
      engine: new FakeEngine(() => result("deny")),
      auditStore: new FaultyAuditStore("write"),
      now: () => 1_000,
    });

    const authorization = await service.authorizeAgentCreate({
      operation,
      state: operation,
      signal: new AbortController().signal,
    });

    expect(authorization).toMatchObject({
      mode: "shadow",
      actualDisposition: { kind: "allow" },
      wouldDisposition: { kind: "deny" },
    });
    expect(authorization?.permit).not.toBeNull();
  });

  test("fails closed before sampling when enforce-mode audit replay cannot be read", async () => {
    const engine = new FakeEngine(() => result("allow"));
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce", failureDisposition: "deny" }),
      logger,
      engine,
      auditStore: new FaultyAuditStore("read"),
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
    expect(engine.calls).toBe(0);
  });

  test("fails closed when an enforce-mode allow cannot be persisted", async () => {
    const service = new DecisionService({
      paseoHome: "/tmp/paseo-test",
      config: config({ mode: "enforce", failureDisposition: "review" }),
      logger,
      engine: new FakeEngine(() => result("allow")),
      auditStore: new FaultyAuditStore("write"),
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
      permit: null,
    });
  });

  test("makes zero network requests when TypeSafe is disabled", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const service = new DecisionService({
        paseoHome: "/tmp/paseo-test",
        config: {
          mode: "shadow",
          typesafe: {
            enabled: false,
            baseUrl: "https://api.typesafe.ai",
            model: "jev-latest",
            timeoutMs: 10_000,
            maxConcurrency: 4,
            apiKey: "present-but-disabled",
          },
          policies: {
            createAgentTool: {
              enabled: true,
              minimumConfidence: 0.9,
              failureDisposition: "review",
            },
          },
        },
        logger,
        auditStore: new MemoryAuditStore(),
        now: () => 1_000,
      });

      await expect(
        service.authorizeAgentCreate({
          operation,
          state: operation,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        mode: "shadow",
        actualDisposition: { kind: "allow" },
        wouldDisposition: { kind: "review" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
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
