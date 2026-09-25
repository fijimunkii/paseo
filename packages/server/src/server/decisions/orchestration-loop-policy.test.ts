import { describe, expect, test } from "vitest";

import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";
import type { DecisionOutcome } from "./service.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";
import { resolveOrchestrationDirective } from "./orchestration-loop-policy.js";

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
  turnStatus: OrchestrationEvidence["turn"]["status"] = "completed",
): OrchestrationEvidence {
  return {
    requiresHumanReview: false,
    turn: { status: turnStatus },
    verificationStatus,
    checks: [],
    toolFailureSignatures: [],
    git: null,
    assistantResult: null,
  };
}

function outcome(target: string): DecisionOutcome {
  return {
    fingerprint: "a".repeat(64),
    mode: "enforce",
    model: "jev-pinned-test",
    actualDisposition: { kind: "route", target },
    wouldDisposition: { kind: "route", target },
    reused: false,
  };
}

describe("resolveOrchestrationDirective", () => {
  test("never completes while deterministic verification is failing", () => {
    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("failed"),
        outcome: outcome("complete"),
        state: { attempts: 1, escalations: 0 },
      }),
    ).toBe("retry");
  });

  test("turns an unverified complete judgment into VERIFY", () => {
    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("not_run"),
        outcome: outcome("complete"),
        state: { attempts: 1, escalations: 0 },
      }),
    ).toBe("verify");
  });

  test("allows COMPLETE only when deterministic verification passed", () => {
    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("passed"),
        outcome: outcome("complete"),
        state: { attempts: 1, escalations: 0 },
      }),
    ).toBe("complete");
  });

  test("bounds repeated failures by escalating and then requiring review", () => {
    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("failed"),
        outcome: outcome("retry"),
        state: { attempts: 3, escalations: 0 },
      }),
    ).toBe("escalate");

    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("failed"),
        outcome: outcome("retry"),
        state: { attempts: 3, escalations: 1 },
      }),
    ).toBe("review");
  });

  test("treats failed turns as deterministic recovery regardless of Jev complete", () => {
    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("not_run", "failed"),
        outcome: outcome("complete"),
        state: { attempts: 1, escalations: 0 },
      }),
    ).toBe("retry");
  });

  test("fails closed when checkpoint evaluation does not produce a route", () => {
    const review: DecisionOutcome = {
      ...outcome("complete"),
      actualDisposition: { kind: "review" },
      wouldDisposition: { kind: "review" },
    };

    expect(
      resolveOrchestrationDirective({
        policy,
        evidence: evidence("passed"),
        outcome: review,
        state: { attempts: 1, escalations: 0 },
      }),
    ).toBe("review");
  });
});
