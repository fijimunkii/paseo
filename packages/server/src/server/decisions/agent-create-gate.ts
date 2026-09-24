import type { JsonValue } from "@getpaseo/protocol/agent-types";

import type { DecisionPermit } from "./permit.js";
import type { DecisionAuthorization, DecisionContext } from "./service.js";

export interface AgentCreateDecisionGate {
  authorizeAgentCreate(input: {
    operation: JsonValue;
    state: Record<string, JsonValue>;
    context?: DecisionContext;
    signal: AbortSignal;
  }): Promise<DecisionAuthorization | null>;
  consumeAgentCreatePermit(permit: DecisionPermit, operation: JsonValue): void;
}

const AGENT_CREATE_STATE_KEYS = [
  "title",
  "provider",
  "initialPrompt",
  "workspaceId",
  "relationship",
  "workspace",
  "cwd",
  "worktreeName",
  "branchName",
  "baseBranch",
  "refName",
  "githubPrNumber",
] as const;

function buildAgentCreateDecisionState(request: JsonValue): Record<string, JsonValue> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("create_agent decision request must be an object");
  }

  const state: Record<string, JsonValue> = {};
  for (const key of AGENT_CREATE_STATE_KEYS) {
    const value = request[key];
    if (value !== undefined) {
      state[key] = value;
    }
  }
  return state;
}

export class AgentCreateDecisionError extends Error {
  readonly kind: "deny" | "review";
  readonly fingerprint: string;

  constructor(kind: "deny" | "review", fingerprint: string) {
    super(
      kind === "deny"
        ? `Decision policy denied create_agent (${fingerprint})`
        : `Decision policy requires human review before create_agent (${fingerprint})`,
    );
    this.name = "AgentCreateDecisionError";
    this.kind = kind;
    this.fingerprint = fingerprint;
  }
}

export async function enforceAgentCreateDecision(input: {
  service: AgentCreateDecisionGate | undefined;
  request: JsonValue;
  callerAgentId?: string;
  signal: AbortSignal;
}): Promise<void> {
  if (!input.service) {
    return;
  }

  const operation: Record<string, JsonValue> = {
    tool: "create_agent",
    callerAgentId: input.callerAgentId ?? null,
    request: input.request,
  };
  const authorization = await input.service.authorizeAgentCreate({
    operation,
    state: buildAgentCreateDecisionState(input.request),
    context: {
      ...(input.callerAgentId ? { agentId: input.callerAgentId } : {}),
      tool: "create_agent",
    },
    signal: input.signal,
  });
  if (!authorization) {
    return;
  }

  if (authorization.actualDisposition.kind === "deny") {
    throw new AgentCreateDecisionError("deny", authorization.fingerprint);
  }
  if (authorization.actualDisposition.kind !== "allow" || !authorization.permit) {
    throw new AgentCreateDecisionError("review", authorization.fingerprint);
  }

  input.service.consumeAgentCreatePermit(authorization.permit, operation);
}
