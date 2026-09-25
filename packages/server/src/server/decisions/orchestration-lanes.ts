import type {
  OrchestrationDecisionPolicyConfig,
  OrchestrationExecutionLane,
  OrchestrationLaneId,
} from "@getpaseo/protocol/decision-config";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";

export interface OrchestrationProviderCatalog {
  getProvider(input: {
    provider: string;
    cwd?: string | null;
    wait?: boolean;
  }): Promise<ProviderSnapshotEntry>;
}

export interface ResolvedOrchestrationLane extends OrchestrationExecutionLane {
  laneId: OrchestrationLaneId;
}

function requireConfiguredLane(
  policy: OrchestrationDecisionPolicyConfig,
  laneId: OrchestrationLaneId,
): OrchestrationExecutionLane {
  if (!policy.enabled) {
    throw new Error("Orchestration decision policy is not enabled");
  }
  const lane = policy.lanes?.[laneId];
  if (!lane) {
    throw new Error(`Orchestration lane '${laneId}' is not configured`);
  }
  return lane;
}

export async function resolveOrchestrationLane(input: {
  policy: OrchestrationDecisionPolicyConfig;
  laneId: OrchestrationLaneId;
  providerCatalog: OrchestrationProviderCatalog;
  cwd?: string | null;
}): Promise<ResolvedOrchestrationLane> {
  const lane = requireConfiguredLane(input.policy, input.laneId);
  const provider = await input.providerCatalog.getProvider({
    provider: lane.provider,
    cwd: input.cwd,
    wait: true,
  });

  if (!provider.enabled) {
    throw new Error(
      `Orchestration lane '${input.laneId}' targets disabled provider '${lane.provider}'`,
    );
  }
  if (provider.status !== "ready") {
    throw new Error(
      `Orchestration lane '${input.laneId}' targets unavailable provider '${lane.provider}'`,
    );
  }

  const model = provider.models?.find(
    (candidate) => candidate.id === lane.model && candidate.isSelectable !== false,
  );
  if (!model) {
    throw new Error(
      `Orchestration lane '${input.laneId}' targets unavailable model '${lane.model}' for provider '${lane.provider}'`,
    );
  }

  if (
    lane.thinkingOptionId &&
    !model.thinkingOptions?.some((option) => option.id === lane.thinkingOptionId)
  ) {
    throw new Error(
      `Orchestration lane '${input.laneId}' targets unavailable thinking option '${lane.thinkingOptionId}' for model '${lane.model}'`,
    );
  }

  return {
    laneId: input.laneId,
    provider: lane.provider,
    model: lane.model,
    ...(lane.thinkingOptionId ? { thinkingOptionId: lane.thinkingOptionId } : {}),
  };
}
