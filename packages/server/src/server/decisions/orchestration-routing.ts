import {
  OrchestrationLaneIdSchema,
  type OrchestrationLaneId,
  type OrchestrationRoutingMode,
} from "@getpaseo/protocol/decision-config";

import type { DecisionOutcome, DecisionService } from "./service.js";
import {
  resolveOrchestrationLane,
  type OrchestrationProviderCatalog,
  type ResolvedOrchestrationLane,
} from "./orchestration-lanes.js";

export class OrchestrationRoutingError extends Error {
  constructor(
    readonly code:
      | "review_required"
      | "denied"
      | "invalid_lane"
      | "provider_mismatch"
      | "lane_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationRoutingError";
  }
}

export interface OrchestrationTaskRoutingResult {
  routing: OrchestrationRoutingMode;
  outcome: DecisionOutcome | null;
  recommendedLane: ResolvedOrchestrationLane | null;
  appliedLane: ResolvedOrchestrationLane | null;
  recommendationError: string | null;
}

type OrchestrationDecisionService = Pick<
  DecisionService,
  "getOrchestrationPolicy" | "assessOrchestrationTask"
>;

function laneIdFromOutcome(outcome: DecisionOutcome): OrchestrationLaneId | null {
  if (outcome.wouldDisposition.kind !== "route") {
    return null;
  }
  const parsed = OrchestrationLaneIdSchema.safeParse(outcome.wouldDisposition.target);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Orchestration lane resolution failed";
}

export async function routeOrchestrationTask(input: {
  service: OrchestrationDecisionService | null | undefined;
  providerCatalog: OrchestrationProviderCatalog;
  task: string;
  title?: string;
  requestedProvider: string;
  requestedModel: string;
  requestedThinkingOptionId?: string;
  requestedRouting?: OrchestrationRoutingMode;
  cwd?: string | null;
  agentId?: string;
  signal: AbortSignal;
}): Promise<OrchestrationTaskRoutingResult> {
  const policy = input.service?.getOrchestrationPolicy() ?? null;
  if (!policy) {
    return {
      routing: "manual",
      outcome: null,
      recommendedLane: null,
      appliedLane: null,
      recommendationError: null,
    };
  }

  const routing = input.requestedRouting ?? policy.defaultRouting;
  if (routing === "manual") {
    return {
      routing,
      outcome: null,
      recommendedLane: null,
      appliedLane: null,
      recommendationError: null,
    };
  }

  const outcome = await input.service!.assessOrchestrationTask({
    state: {
      task: input.task,
      requestedProvider: input.requestedProvider,
      requestedModel: input.requestedModel,
      requestedThinkingOptionId: input.requestedThinkingOptionId ?? null,
      ...(input.title ? { title: input.title } : {}),
    },
    context: {
      ...(input.agentId ? { agentId: input.agentId } : {}),
      tool: "orchestration.task",
    },
    signal: input.signal,
  });

  if (!outcome) {
    return {
      routing: "manual",
      outcome: null,
      recommendedLane: null,
      appliedLane: null,
      recommendationError: null,
    };
  }

  const laneId = laneIdFromOutcome(outcome);
  let recommendedLane: ResolvedOrchestrationLane | null = null;
  let recommendationError: string | null = null;

  if (laneId) {
    try {
      recommendedLane = await resolveOrchestrationLane({
        policy,
        laneId,
        providerCatalog: input.providerCatalog,
        cwd: input.cwd,
      });
    } catch (error) {
      recommendationError = errorMessage(error);
    }
  }

  if (outcome.mode === "shadow") {
    return {
      routing,
      outcome,
      recommendedLane,
      appliedLane: null,
      recommendationError,
    };
  }

  if (outcome.actualDisposition.kind === "review") {
    throw new OrchestrationRoutingError(
      "review_required",
      "Jev orchestration requires human review before managed task routing",
    );
  }
  if (outcome.actualDisposition.kind === "deny") {
    throw new OrchestrationRoutingError(
      "denied",
      "Jev orchestration denied managed task routing",
    );
  }
  if (outcome.actualDisposition.kind !== "route") {
    throw new OrchestrationRoutingError(
      "invalid_lane",
      "Enforced orchestration did not produce an execution lane",
    );
  }

  const appliedLaneId = OrchestrationLaneIdSchema.safeParse(outcome.actualDisposition.target);
  if (!appliedLaneId.success) {
    throw new OrchestrationRoutingError(
      "invalid_lane",
      `Unknown orchestration lane '${outcome.actualDisposition.target}'`,
    );
  }

  let appliedLane: ResolvedOrchestrationLane;
  try {
    appliedLane = await resolveOrchestrationLane({
      policy,
      laneId: appliedLaneId.data,
      providerCatalog: input.providerCatalog,
      cwd: input.cwd,
    });
  } catch (error) {
    throw new OrchestrationRoutingError("lane_unavailable", errorMessage(error));
  }

  if (appliedLane.provider !== input.requestedProvider) {
    throw new OrchestrationRoutingError(
      "provider_mismatch",
      `Managed routing at this boundary cannot switch provider from '${input.requestedProvider}' to '${appliedLane.provider}'`,
    );
  }

  return {
    routing,
    outcome,
    recommendedLane: appliedLane,
    appliedLane,
    recommendationError: null,
  };
}
