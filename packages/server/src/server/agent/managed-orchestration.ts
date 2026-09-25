import type { Logger } from "pino";

import type { OrchestrationRoutingMode } from "@getpaseo/protocol/decision-config";
import type { AgentManager, ManagedAgent, WaitForAgentResult } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { waitForAgentWithTimeout } from "./mcp-shared.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  buildOrchestrationEvidence,
  type OrchestrationEvidence,
} from "../decisions/orchestration-evidence.js";
import {
  runManagedOrchestrationLoop,
  type ManagedOrchestrationLoopResult,
} from "../decisions/orchestration-loop.js";
import {
  recordOrchestrationTaskApplication,
  routeOrchestrationTask,
  type OrchestrationTaskRoutingResult,
} from "../decisions/orchestration-routing.js";
import type { DecisionService } from "../decisions/service.js";

export type ManagedAgentDecisionService = Pick<
  DecisionService,
  | "getDecisionMode"
  | "getOrchestrationPolicy"
  | "assessOrchestrationTask"
  | "assessOrchestrationCheckpoint"
>;

export interface ManagedAgentLoopResult {
  loop: ManagedOrchestrationLoopResult;
  waitResult: WaitForAgentResult;
}

function turnStatus(result: WaitForAgentResult): OrchestrationEvidence["turn"]["status"] {
  if (result.status === "idle") {
    return "completed";
  }
  if (result.status === "error") {
    return "failed";
  }
  return "canceled";
}

function requiresHumanReview(result: WaitForAgentResult): boolean {
  return (
    result.permission !== null || result.status === "running" || result.status === "initializing"
  );
}

async function readWorkspaceEvidence(
  workspaceGitService:
    | (Pick<WorkspaceGitService, "getSnapshot"> &
        Partial<Pick<WorkspaceGitService, "getCheckoutDiff">>)
    | null
    | undefined,
  cwd: string,
  agentId: string,
  logger: Pick<Logger, "warn">,
): Promise<{
  git: {
    isGit: boolean;
    isDirty: boolean | null;
    diffStat: { additions: number; deletions: number } | null;
  };
  changedPaths: string[];
} | null> {
  if (!workspaceGitService) {
    return null;
  }
  try {
    const snapshot = await workspaceGitService.getSnapshot(cwd);
    let changedPaths: string[] = [];
    if (snapshot.git.isGit && workspaceGitService.getCheckoutDiff) {
      try {
        const diff = await workspaceGitService.getCheckoutDiff(cwd, {
          mode: "base",
          includeStructured: true,
        });
        changedPaths = (diff.structured ?? [])
          .map((file) => file.path)
          .sort()
          .slice(0, 100);
      } catch (error) {
        logger.warn({ err: error, agentId }, "Failed to collect changed paths for orchestration");
      }
    }
    return {
      git: {
        isGit: snapshot.git.isGit,
        isDirty: snapshot.git.isDirty,
        diffStat: snapshot.git.diffStat,
      },
      changedPaths,
    };
  } catch (error) {
    logger.warn({ err: error, agentId }, "Failed to collect git evidence for orchestration");
    return null;
  }
}

async function collectTurnEvidence(input: {
  agentManager: AgentManager;
  workspaceGitService?:
    | (Pick<WorkspaceGitService, "getSnapshot"> &
        Partial<Pick<WorkspaceGitService, "getCheckoutDiff">>)
    | null;
  logger: Pick<Logger, "warn">;
  agentId: string;
  timelineStart: number;
  result: WaitForAgentResult;
}): Promise<OrchestrationEvidence> {
  const snapshot = input.agentManager.getAgent(input.agentId);
  const timeline = input.agentManager.getTimeline(input.agentId).slice(input.timelineStart);
  const workspace = snapshot
    ? await readWorkspaceEvidence(
        input.workspaceGitService,
        snapshot.cwd,
        input.agentId,
        input.logger,
      )
    : null;

  return buildOrchestrationEvidence({
    timeline,
    turnStatus: turnStatus(input.result),
    ...(input.result.status === "error" ? { errorKind: "agent_error" } : {}),
    requiresHumanReview: requiresHumanReview(input.result),
    changedPaths: workspace?.changedPaths,
    git: workspace?.git ?? null,
  });
}

interface ManagedTaskRoutingInput {
  decisionService: Partial<ManagedAgentDecisionService> | null | undefined;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  logger: Logger;
  agentId: string;
  task: string;
  routing?: OrchestrationRoutingMode;
  signal: AbortSignal;
}

function manualTaskRoutingResult(): OrchestrationTaskRoutingResult {
  return {
    routing: "manual",
    outcome: null,
    recommendedLane: null,
    appliedLane: null,
    recommendationError: null,
  };
}

function shouldManageTask(input: ManagedTaskRoutingInput): boolean {
  const policy = input.decisionService?.getOrchestrationPolicy?.() ?? null;
  const effectiveRouting = input.routing ?? policy?.defaultRouting ?? "manual";
  return (
    effectiveRouting === "managed" &&
    typeof input.decisionService?.assessOrchestrationTask === "function"
  );
}

async function resolveManagedTaskAgent(input: ManagedTaskRoutingInput): Promise<{
  agent: ManagedAgent;
  requestedModel: string;
  requestedThinkingOptionId: string | undefined;
}> {
  await ensureAgentLoaded(input.agentId, {
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    logger: input.logger,
  });
  const agent = input.agentManager.getAgent(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not found`);
  }

  const requestedModel =
    agent.runtimeInfo?.model ??
    agent.config.model ??
    (await input.providerSnapshotManager.resolveDefaultModel({
      provider: agent.provider,
      cwd: agent.cwd,
    }));
  if (!requestedModel) {
    throw new Error(`Cannot determine the current model for managed agent ${input.agentId}`);
  }

  return {
    agent,
    requestedModel,
    requestedThinkingOptionId:
      agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId,
  };
}

async function applyManagedTaskRouting(input: {
  request: ManagedTaskRoutingInput;
  agent: ManagedAgent;
  requestedModel: string;
  requestedThinkingOptionId: string | undefined;
  routing: OrchestrationTaskRoutingResult;
}): Promise<void> {
  if (input.routing.appliedLane) {
    await input.request.agentManager.applyAgentExecutionLane(
      input.request.agentId,
      input.routing.appliedLane,
    );
  }
  recordOrchestrationTaskApplication({
    service: input.request.decisionService,
    outcome: input.routing.outcome,
    requestedProvider: input.agent.provider,
    requestedModel: input.requestedModel,
    requestedThinkingOptionId: input.requestedThinkingOptionId,
    applied:
      input.routing.outcome?.mode === "shadow"
        ? "manual"
        : (input.routing.appliedLane?.laneId ?? null),
  });
}

export async function routeManagedAgentTask(
  input: ManagedTaskRoutingInput,
): Promise<OrchestrationTaskRoutingResult> {
  if (!shouldManageTask(input)) {
    return manualTaskRoutingResult();
  }

  const resolved = await resolveManagedTaskAgent(input);
  const routing = await routeOrchestrationTask({
    service: input.decisionService,
    providerCatalog: input.providerSnapshotManager,
    task: input.task,
    requestedProvider: resolved.agent.provider,
    requestedModel: resolved.requestedModel,
    requestedThinkingOptionId: resolved.requestedThinkingOptionId,
    requestedRouting: input.routing,
    cwd: resolved.agent.cwd,
    agentId: input.agentId,
    signal: input.signal,
  });
  await applyManagedTaskRouting({
    request: input,
    agent: resolved.agent,
    requestedModel: resolved.requestedModel,
    requestedThinkingOptionId: resolved.requestedThinkingOptionId,
    routing,
  });
  return routing;
}

function hasCheckpointService(
  service: Partial<ManagedAgentDecisionService> | null | undefined,
): service is ManagedAgentDecisionService {
  return (
    typeof service?.getDecisionMode === "function" &&
    typeof service.getOrchestrationPolicy === "function" &&
    typeof service.assessOrchestrationCheckpoint === "function"
  );
}

export async function runManagedAgentLoop(input: {
  decisionService: Partial<ManagedAgentDecisionService> | null | undefined;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceGitService?: Pick<WorkspaceGitService, "getSnapshot"> | null;
  logger: Logger;
  agentId: string;
  task: string;
  initialTimelineStart: number;
  initialWaitResult: WaitForAgentResult;
  signal: AbortSignal;
}): Promise<ManagedAgentLoopResult | null> {
  const service = input.decisionService;
  if (!hasCheckpointService(service)) {
    return null;
  }
  const policy = service.getOrchestrationPolicy();
  if (!policy) {
    return null;
  }

  const agent = input.agentManager.getAgent(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not found`);
  }

  let latestWaitResult = input.initialWaitResult;
  const initialEvidence = await collectTurnEvidence({
    agentManager: input.agentManager,
    workspaceGitService: input.workspaceGitService,
    logger: input.logger,
    agentId: input.agentId,
    timelineStart: input.initialTimelineStart,
    result: latestWaitResult,
  });

  const loop = await runManagedOrchestrationLoop({
    service,
    providerCatalog: input.providerSnapshotManager,
    task: input.task,
    agentId: input.agentId,
    provider: agent.provider,
    cwd: agent.cwd,
    initialEvidence,
    signal: input.signal,
    callbacks: {
      applyLane: async (lane) => input.agentManager.applyAgentExecutionLane(input.agentId, lane),
      runContinuation: async (prompt) => {
        const timelineStart = input.agentManager.getTimeline(input.agentId).length;
        await sendPromptToAgent({
          agentManager: input.agentManager,
          agentStorage: input.agentStorage,
          agentId: input.agentId,
          prompt,
          logger: input.logger,
        });
        latestWaitResult = await waitForAgentWithTimeout(input.agentManager, input.agentId, {
          signal: input.signal,
          waitForActive: true,
        });
        return collectTurnEvidence({
          agentManager: input.agentManager,
          workspaceGitService: input.workspaceGitService,
          logger: input.logger,
          agentId: input.agentId,
          timelineStart,
          result: latestWaitResult,
        });
      },
    },
  });

  return { loop, waitResult: latestWaitResult };
}
