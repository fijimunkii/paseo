import { describe, expect, test, vi } from "vitest";

import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";
import { runManagedOrchestrationLoop } from "./orchestration-loop.js";
import type { DecisionOutcome, DecisionService } from "./service.js";

const policy: OrchestrationDecisionPolicyConfig = {
  enabled: true,
  minimumConfidence: 0.85,
  failureDisposition: "review",
  defaultRouting: "managed",
  maxAttempts: 3,
  maxEscalations: 1,
  lanes: {
    small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
    medium: { provider: "codex", model: "fast", thinkingOptionId: "medium" },
    high: { provider: "codex", model: "fast", thinkingOptionId: "high" },
    escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
  },
};

function evidence(
  verificationStatus: OrchestrationEvidence["verificationStatus"],
): OrchestrationEvidence {
  return {
    requiresHumanReview: false,
    turn: { status: "completed" },
    verificationStatus,
    checks:
      verificationStatus === "not_run"
        ? []
        : [{ kind: "test", status: verificationStatus === "passed" ? "passed" : "failed" }],
    toolFailureSignatures: verificationStatus === "failed" ? ["failure"] : [],
    git: {
      isGit: true,
      isDirty: true,
      additions: 4,
      deletions: 1,
    },
    assistantResult: "Finished the current pass.",
  };
}

function outcome(
  target: string,
  mode: "shadow" | "enforce" = "enforce",
): DecisionOutcome {
  return {
    fingerprint: target.padEnd(64, "a").slice(0, 64),
    mode,
    model: mode === "enforce" ? "jev-pinned-test" : "jev-latest",
    actualDisposition: mode === "shadow" ? { kind: "allow" } : { kind: "route", target },
    wouldDisposition: { kind: "route", target },
    reused: false,
  };
}

function service(
  outcomes: DecisionOutcome[],
): Pick<DecisionService, "getOrchestrationPolicy" | "assessOrchestrationCheckpoint"> {
  let index = 0;
  return {
    getOrchestrationPolicy: () => policy,
    assessOrchestrationCheckpoint: vi.fn(async () => outcomes[index++] ?? outcomes.at(-1) ?? null),
  };
}

function providerEntry(): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "codex",
        id: "strong",
        label: "Strong",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ],
  };
}

describe("runManagedOrchestrationLoop", () => {
  test("shadow mode assesses but never performs another turn", async () => {
    const runContinuation = vi.fn();
    const applyLane = vi.fn();

    const result = await runManagedOrchestrationLoop({
      service: service([outcome("verify", "shadow")]),
      providerCatalog: { getProvider: vi.fn(async () => providerEntry()) },
      callbacks: { runContinuation, applyLane },
      task: "Implement the feature",
      agentId: "agent-1",
      provider: "codex",
      initialEvidence: evidence("not_run"),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      directive: "verify",
      attempts: 1,
      escalations: 0,
      shadow: true,
    });
    expect(runContinuation).not.toHaveBeenCalled();
    expect(applyLane).not.toHaveBeenCalled();
  });

  test("forces deterministic verification before accepting COMPLETE", async () => {
    const runContinuation = vi.fn(async () => evidence("passed"));

    const result = await runManagedOrchestrationLoop({
      service: service([outcome("complete"), outcome("complete")]),
      providerCatalog: { getProvider: vi.fn(async () => providerEntry()) },
      callbacks: { runContinuation, applyLane: vi.fn() },
      task: "Implement the feature",
      agentId: "agent-1",
      provider: "codex",
      initialEvidence: evidence("not_run"),
      signal: new AbortController().signal,
    });

    expect(runContinuation).toHaveBeenCalledOnce();
    expect(runContinuation.mock.calls[0]?.[0]).toContain("deterministic verification");
    expect(result).toMatchObject({
      directive: "complete",
      attempts: 2,
      shadow: false,
    });
  });

  test("failed checks trigger a corrective pass even when Jev says COMPLETE", async () => {
    const runContinuation = vi.fn(async () => evidence("passed"));

    const result = await runManagedOrchestrationLoop({
      service: service([outcome("complete"), outcome("complete")]),
      providerCatalog: { getProvider: vi.fn(async () => providerEntry()) },
      callbacks: { runContinuation, applyLane: vi.fn() },
      task: "Fix the tests",
      agentId: "agent-1",
      provider: "codex",
      initialEvidence: evidence("failed"),
      signal: new AbortController().signal,
    });

    expect(runContinuation.mock.calls[0]?.[0]).toContain("corrective pass");
    expect(result.directive).toBe("complete");
  });

  test("applies the validated escalated lane before the next turn", async () => {
    const applyLane = vi.fn();
    const runContinuation = vi.fn(async () => evidence("passed"));

    const result = await runManagedOrchestrationLoop({
      service: service([outcome("escalate"), outcome("complete")]),
      providerCatalog: { getProvider: vi.fn(async () => providerEntry()) },
      callbacks: { runContinuation, applyLane },
      task: "Resolve the architecture issue",
      agentId: "agent-1",
      provider: "codex",
      initialEvidence: evidence("passed"),
      signal: new AbortController().signal,
    });

    expect(applyLane).toHaveBeenCalledWith({
      laneId: "escalated",
      provider: "codex",
      model: "strong",
      thinkingOptionId: "high",
    });
    expect(result).toMatchObject({
      directive: "complete",
      attempts: 2,
      escalations: 1,
    });
  });

  test("falls back to review when the bounded loop cannot converge", async () => {
    const failingPolicy: OrchestrationDecisionPolicyConfig = {
      ...policy,
      maxAttempts: 1,
      maxEscalations: 0,
    };
    const checkpointService: Pick<
      DecisionService,
      "getOrchestrationPolicy" | "assessOrchestrationCheckpoint"
    > = {
      getOrchestrationPolicy: () => failingPolicy,
      assessOrchestrationCheckpoint: vi.fn(async () => outcome("retry")),
    };

    const result = await runManagedOrchestrationLoop({
      service: checkpointService,
      providerCatalog: { getProvider: vi.fn(async () => providerEntry()) },
      callbacks: { runContinuation: vi.fn(), applyLane: vi.fn() },
      task: "Fix the failure",
      agentId: "agent-1",
      provider: "codex",
      initialEvidence: evidence("failed"),
      signal: new AbortController().signal,
    });

    expect(result.directive).toBe("review");
    expect(result.attempts).toBe(1);
  });
});
