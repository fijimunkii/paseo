import {
  OrchestrationLaneIdSchema,
  type OrchestrationDecisionPolicyConfig,
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

type OrchestrationDecisionService = Partial<
  Pick<DecisionService, "getOrchestrationPolicy" | "assessOrchestrationTask">
>;
type ActiveOrchestrationDecisionService = Pick<
  DecisionService,
  "getOrchestrationPolicy" | "assessOrchestrationTask"
>;

interface OrchestrationTaskRoutingInput {
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
}

interface ActiveRouting {
  service: ActiveOrchestrationDecisionService;
  policy: OrchestrationDecisionPolicyConfig;
  routing: "managed";
}

interface LaneRecommendation {
  lane: ResolvedOrchestrationLane | null;
  error: string | null;
}

function inactiveResult(
  routing: OrchestrationRoutingMode = "manual",
): OrchestrationTaskRoutingResult {
  return {
    routing,
    outcome: null,
    recommendedLane: null,
    appliedLane: null,
    recommendationError: null,
  };
}

function hasActiveService(
  service: OrchestrationDecisionService | null | undefined,
): service is ActiveOrchestrationDecisionService {
  return (
    typeof service?.getOrchestrationPolicy === "function" &&
    typeof service.assessOrchestrationTask === "function"
  );
}

function resolveActiveRouting(input: OrchestrationTaskRoutingInput): ActiveRouting | null {
  if (!hasActiveService(input.service)) {
    return null;
  }
  const policy = input.service.getOrchestrationPolicy();
  if (!policy) {
    return null;
  }
  const routing = input.requestedRouting ?? policy.defaultRouting;
  if (routing !== "managed") {
    return null;
  }
  return { service: input.service, policy, routing };
}

function laneIdFromDisposition(outcome: DecisionOutcome): OrchestrationLaneId | null {
  if (outcome.wouldDisposition.kind !== "route") {
    return null;
  }
  const parsed = OrchestrationLaneIdSchema.safeParse(outcome.wouldDisposition.target);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Orchestration lane resolution failed";
}

async function resolveLaneRecommendation(input: {
  outcome: DecisionOutcome;
  policy: OrchestrationDecisionPolicyConfig;
  providerCatalog: OrchestrationProviderCatalog;
  cwd?: string | null;
}): Promise<LaneRecommendation> {
  const laneId = laneIdFromDisposition(input.outcome);
  if (!laneId) {
    return { lane: null, error: null };
  }
  try {
    const lane = await resolveOrchestrationLane({
      policy: input.policy,
      laneId,
      providerCatalog: input.providerCatalog,
      cwd: input.cwd,
    });
    return { lane, error: null };
  } catch (error) {
    return { lane: null, error: errorMessage(error) };
  }
}

function requireAppliedLaneId(outcome: DecisionOutcome): OrchestrationLaneId {
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

  const laneId = OrchestrationLaneIdSchema.safeParse(outcome.actualDisposition.target);
  if (!laneId.success) {
    throw new OrchestrationRoutingError(
      "invalid_lane",
      `Unknown orchestration lane '${outcome.actualDisposition.target}'`,
    );
  }
  return laneId.data;
}

async function resolveAppliedLane(input: {
  outcome: DecisionOutcome;
  policy: OrchestrationDecisionPolicyConfig;
  providerCatalog: OrchestrationProviderCatalog;
  requestedProvider: string;
  cwd?: string | null;
}): Promise<ResolvedOrchestrationLane> {
  const laneId = requireAppliedLaneId(input.outcome);
  let lane: ResolvedOrchestrationLane;
  try {
    lane = await resolveOrchestrationLane({
      policy: input.policy,
      laneId,
      providerCatalog: input.providerCatalog,
      cwd: input.cwd,
    });
  } catch (error) {
    throw new OrchestrationRoutingError("lane_unavailable", errorMessage(error));
  }

  if (lane.provider !== input.requestedProvider) {
    throw new OrchestrationRoutingError(
      "provider_mismatch",
      `Managed routing at this boundary cannot switch provider from '${input.requestedProvider}' to '${lane.provider}'`,
    );
  }
  return lane;
}

export async function routeOrchestrationTask(
  input: OrchestrationTaskRoutingInput,
): Promise<OrchestrationTaskRoutingResult> {
  const active = resolveActiveRouting(input);
  if (!active) {
    return inactiveResult(input.requestedRouting ?? "manual");
  }

  const outcome = await active.service.assessOrchestrationTask({
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
    return inactiveResult();
  }

  const recommendation = await resolveLaneRecommendation({
    outcome,
    policy: active.policy,
    providerCatalog: input.providerCatalog,
    cwd: input.cwd,
  });
  if (outcome.mode === "shadow") {
    return {
      routing: active.routing,
      outcome,
      recommendedLane: recommendation.lane,
      appliedLane: null,
      recommendationError: recommendation.error,
    };
  }

  const appliedLane = await resolveAppliedLane({
    outcome,
    policy: active.policy,
    providerCatalog: input.providerCatalog,
    requestedProvider: input.requestedProvider,
    cwd: input.cwd,
  });
  return {
    routing: active.routing,
    outcome,
    recommendedLane: appliedLane,
    appliedLane,
    recommendationError: null,
  };
}
