import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";

import type { DecisionEntry } from "./engine.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";
import {
  resolveDeterministicOrchestrationDirective,
  resolveOrchestrationDirective,
  type OrchestrationDirective,
  type OrchestrationLoopState,
} from "./orchestration-loop-policy.js";
import {
  resolveOrchestrationLane,
  type OrchestrationProviderCatalog,
  type ResolvedOrchestrationLane,
} from "./orchestration-lanes.js";
import type { DecisionOutcome, DecisionService } from "./service.js";

type CheckpointDecisionService = Pick<
  DecisionService,
  "getDecisionMode" | "getOrchestrationPolicy" | "assessOrchestrationCheckpoint"
>;

export interface ManagedOrchestrationLoopResult {
  directive: OrchestrationDirective;
  attempts: number;
  escalations: number;
  evidence: OrchestrationEvidence;
  outcome: DecisionOutcome | null;
  shadow: boolean;
}

export interface ManagedOrchestrationCallbacks {
  runContinuation(prompt: string): Promise<OrchestrationEvidence>;
  applyLane(lane: ResolvedOrchestrationLane): Promise<void>;
}

function checkpointState(task: string, evidence: OrchestrationEvidence): DecisionEntry {
  return {
    task,
    requiresHumanReview: evidence.requiresHumanReview,
    turn: {
      status: evidence.turn.status,
      ...(evidence.turn.errorKind ? { errorKind: evidence.turn.errorKind } : {}),
    },
    verificationStatus: evidence.verificationStatus,
    checks: evidence.checks.map((check) => ({
      kind: check.kind,
      status: check.status,
    })),
    toolFailureSignatures: [...evidence.toolFailureSignatures],
    git: evidence.git
      ? {
          isGit: evidence.git.isGit,
          isDirty: evidence.git.isDirty,
          additions: evidence.git.additions,
          deletions: evidence.git.deletions,
        }
      : null,
    assistantResult: evidence.assistantResult,
  };
}

function previewOutcome(outcome: DecisionOutcome): DecisionOutcome {
  return {
    ...outcome,
    actualDisposition: outcome.wouldDisposition,
  };
}

function continuationPrompt(
  directive: Exclude<OrchestrationDirective, "complete" | "review">,
): string {
  switch (directive) {
    case "continue":
      return "<paseo-system>Continue the requested task. Inspect the current implementation and remaining requirements before making further changes.</paseo-system>";
    case "retry":
      return "<paseo-system>The previous implementation pass is not yet satisfactory. Inspect the actual failures and current diff, then make a targeted corrective pass. Do not repeat an unchanged approach.</paseo-system>";
    case "verify":
      return "<paseo-system>Run the relevant deterministic verification for the changes (tests, type checking, linting, or build checks as applicable), inspect the actual results, and fix any failures before reporting completion.</paseo-system>";
    case "escalate":
      return "<paseo-system>Paseo has escalated this task to the strongest configured reasoning lane. Reassess the current implementation, unresolved evidence, and requested scope before continuing.</paseo-system>";
  }
}

async function resolveEscalatedLane(input: {
  policy: OrchestrationDecisionPolicyConfig;
  providerCatalog: OrchestrationProviderCatalog;
  provider: string;
  cwd?: string | null;
}): Promise<ResolvedOrchestrationLane> {
  const lane = await resolveOrchestrationLane({
    policy: input.policy,
    laneId: "escalated",
    providerCatalog: input.providerCatalog,
    cwd: input.cwd,
  });
  if (lane.provider !== input.provider) {
    throw new Error(
      `Managed loop cannot switch provider from '${input.provider}' to '${lane.provider}' during escalation`,
    );
  }
  return lane;
}

async function assessCheckpoint(input: {
  service: CheckpointDecisionService;
  task: string;
  evidence: OrchestrationEvidence;
  agentId: string;
  signal: AbortSignal;
}): Promise<DecisionOutcome | null> {
  return input.service.assessOrchestrationCheckpoint({
    state: checkpointState(input.task, input.evidence),
    context: {
      agentId: input.agentId,
      tool: "orchestration.checkpoint",
    },
    signal: input.signal,
  });
}

export async function runManagedOrchestrationLoop(input: {
  service: CheckpointDecisionService;
  providerCatalog: OrchestrationProviderCatalog;
  callbacks: ManagedOrchestrationCallbacks;
  task: string;
  agentId: string;
  provider: string;
  cwd?: string | null;
  initialEvidence: OrchestrationEvidence;
  signal: AbortSignal;
}): Promise<ManagedOrchestrationLoopResult> {
  const policy = input.service.getOrchestrationPolicy();
  if (!policy) {
    return {
      directive: "review",
      attempts: 1,
      escalations: 0,
      evidence: input.initialEvidence,
      outcome: null,
      shadow: false,
    };
  }

  const state: OrchestrationLoopState = { attempts: 1, escalations: 0 };
  let evidence = input.initialEvidence;
  const maximumIterations = policy.maxAttempts + policy.maxEscalations + 2;

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Managed orchestration was canceled");
    }

    const deterministic =
      input.service.getDecisionMode() === "enforce"
        ? resolveDeterministicOrchestrationDirective({
            policy,
            evidence,
            state,
          })
        : null;
    if (deterministic === "complete" || deterministic === "review") {
      return {
        directive: deterministic,
        attempts: state.attempts,
        escalations: state.escalations,
        evidence,
        outcome: null,
        shadow: false,
      };
    }
    if (deterministic) {
      if (deterministic === "escalate") {
        const lane = await resolveEscalatedLane({
          policy,
          providerCatalog: input.providerCatalog,
          provider: input.provider,
          cwd: input.cwd,
        });
        await input.callbacks.applyLane(lane);
        state.escalations += 1;
      }
      evidence = await input.callbacks.runContinuation(continuationPrompt(deterministic));
      state.attempts += 1;
      continue;
    }

    const outcome = await assessCheckpoint({
      service: input.service,
      task: input.task,
      evidence,
      agentId: input.agentId,
      signal: input.signal,
    });
    const effectiveOutcome = outcome?.mode === "shadow" ? previewOutcome(outcome) : outcome;
    const directive = resolveOrchestrationDirective({
      policy,
      evidence,
      outcome: effectiveOutcome,
      state,
    });

    if (outcome?.mode === "shadow") {
      return {
        directive,
        attempts: state.attempts,
        escalations: state.escalations,
        evidence,
        outcome,
        shadow: true,
      };
    }
    if (directive === "complete" || directive === "review") {
      return {
        directive,
        attempts: state.attempts,
        escalations: state.escalations,
        evidence,
        outcome,
        shadow: false,
      };
    }

    if (directive === "escalate") {
      const lane = await resolveEscalatedLane({
        policy,
        providerCatalog: input.providerCatalog,
        provider: input.provider,
        cwd: input.cwd,
      });
      await input.callbacks.applyLane(lane);
      state.escalations += 1;
    }

    evidence = await input.callbacks.runContinuation(continuationPrompt(directive));
    state.attempts += 1;
  }

  return {
    directive: "review",
    attempts: state.attempts,
    escalations: state.escalations,
    evidence,
    outcome: null,
    shadow: false,
  };
}
