import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";

import type { DecisionOutcome } from "./service.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";

export type OrchestrationDirective =
  | "continue"
  | "retry"
  | "verify"
  | "escalate"
  | "complete"
  | "review";

export interface OrchestrationLoopState {
  attempts: number;
  escalations: number;
}

function boundedRecoveryDirective(
  policy: OrchestrationDecisionPolicyConfig,
  state: OrchestrationLoopState,
): OrchestrationDirective {
  if (state.attempts < policy.maxAttempts) {
    return "retry";
  }
  if (state.escalations < policy.maxEscalations) {
    return "escalate";
  }
  return "review";
}

function boundedRequestedDirective(
  directive: Exclude<OrchestrationDirective, "complete" | "review">,
  policy: OrchestrationDecisionPolicyConfig,
  state: OrchestrationLoopState,
): OrchestrationDirective {
  if (directive === "escalate") {
    return state.escalations < policy.maxEscalations ? "escalate" : "review";
  }
  if (state.attempts < policy.maxAttempts) {
    return directive;
  }
  return state.escalations < policy.maxEscalations ? "escalate" : "review";
}

function routeTarget(outcome: DecisionOutcome | null): string | null {
  if (!outcome || outcome.actualDisposition.kind !== "route") {
    return null;
  }
  return outcome.actualDisposition.target;
}

export function resolveDeterministicOrchestrationDirective(input: {
  policy: OrchestrationDecisionPolicyConfig;
  evidence: OrchestrationEvidence;
  state: OrchestrationLoopState;
}): OrchestrationDirective | null {
  if (input.evidence.requiresHumanReview) {
    return "review";
  }
  if (
    input.evidence.turn.status !== "completed" ||
    input.evidence.verificationStatus === "failed"
  ) {
    return boundedRecoveryDirective(input.policy, input.state);
  }
  if (input.evidence.verificationStatus === "not_run") {
    return boundedRequestedDirective("verify", input.policy, input.state);
  }
  return null;
}

export function resolveOrchestrationDirective(input: {
  policy: OrchestrationDecisionPolicyConfig;
  evidence: OrchestrationEvidence;
  outcome: DecisionOutcome | null;
  state: OrchestrationLoopState;
}): OrchestrationDirective {
  const deterministic = resolveDeterministicOrchestrationDirective({
    policy: input.policy,
    evidence: input.evidence,
    state: input.state,
  });
  if (deterministic) {
    return deterministic;
  }

  if (
    !input.outcome ||
    input.outcome.actualDisposition.kind === "review" ||
    input.outcome.actualDisposition.kind === "deny"
  ) {
    return "review";
  }

  const target = routeTarget(input.outcome);
  if (target === "complete") {
    if (input.evidence.verificationStatus !== "passed") {
      return boundedRequestedDirective("verify", input.policy, input.state);
    }
    return "complete";
  }
  if (target === "continue" || target === "retry" || target === "verify" || target === "escalate") {
    return boundedRequestedDirective(target, input.policy, input.state);
  }
  return "review";
}
