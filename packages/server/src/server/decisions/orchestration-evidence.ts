import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

export type OrchestrationCheckKind = "test" | "typecheck" | "lint" | "build";
export type OrchestrationCheckStatus = "passed" | "failed" | "unavailable";
export type OrchestrationVerificationStatus = "passed" | "failed" | "not_run";

export interface OrchestrationCheckEvidence {
  kind: OrchestrationCheckKind;
  status: OrchestrationCheckStatus;
}

export interface OrchestrationEvidence {
  requiresHumanReview: boolean;
  turn: {
    status: "completed" | "failed" | "canceled";
    errorKind?: string;
  };
  verificationStatus: OrchestrationVerificationStatus;
  checks: OrchestrationCheckEvidence[];
  toolFailureSignatures: string[];
  git: {
    isGit: boolean;
    isDirty: boolean | null;
    additions: number | null;
    deletions: number | null;
  } | null;
  assistantResult: string | null;
}

const MAX_ASSISTANT_RESULT_CHARS = 2_000;

function classifyVerificationCommand(command: string): OrchestrationCheckKind | null {
  const normalized = command.toLowerCase();
  if (
    /\b(pytest|vitest|jest|cargo\s+test|go\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|bun\s+(run\s+)?test)\b/u.test(
      normalized,
    )
  ) {
    return "test";
  }
  if (/\b(typecheck|tsc\b|mypy\b|pyright\b)\b/u.test(normalized)) {
    return "typecheck";
  }
  if (/\b(lint|eslint\b|oxlint\b|ruff\s+check)\b/u.test(normalized)) {
    return "lint";
  }
  if (/\b(build|compile|cargo\s+check|go\s+vet)\b/u.test(normalized)) {
    return "build";
  }
  return null;
}

function shellStatus(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): OrchestrationCheckStatus {
  if (item.status === "failed") {
    return "failed";
  }
  if (item.status !== "completed") {
    return "unavailable";
  }
  if (item.detail.type !== "shell" || item.detail.exitCode == null) {
    return "unavailable";
  }
  return item.detail.exitCode === 0 ? "passed" : "failed";
}

function mergeCheckStatus(
  current: OrchestrationCheckStatus | undefined,
  next: OrchestrationCheckStatus,
): OrchestrationCheckStatus {
  if (current === "failed" || next === "failed") {
    return "failed";
  }
  if (current === "passed" || next === "passed") {
    return "passed";
  }
  return "unavailable";
}

function failureSignature(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const detailKind = item.detail.type;
  const shellExitCode = item.detail.type === "shell" ? item.detail.exitCode : null;
  const shellCommand = item.detail.type === "shell" ? item.detail.command.trim() : "";
  return createHash("sha256")
    .update(
      `${item.name}\n${detailKind}\n${item.status}\n${shellExitCode ?? "unknown"}\n${shellCommand}`,
    )
    .digest("hex")
    .slice(0, 16);
}

function collectChecks(timeline: readonly AgentTimelineItem[]): OrchestrationCheckEvidence[] {
  const checks = new Map<OrchestrationCheckKind, OrchestrationCheckStatus>();
  for (const item of timeline) {
    if (item.type !== "tool_call" || item.detail.type !== "shell") {
      continue;
    }
    const kind = classifyVerificationCommand(item.detail.command);
    if (!kind) {
      continue;
    }
    checks.set(kind, mergeCheckStatus(checks.get(kind), shellStatus(item)));
  }
  return [...checks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, status]) => ({ kind, status }));
}

function verificationStatus(
  checks: readonly OrchestrationCheckEvidence[],
): OrchestrationVerificationStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "passed")) {
    return "passed";
  }
  return "not_run";
}

function collectToolFailureSignatures(timeline: readonly AgentTimelineItem[]): string[] {
  const signatures = new Set<string>();
  for (const item of timeline) {
    if (item.type !== "tool_call") {
      continue;
    }
    const shellFailed =
      item.detail.type === "shell" && item.detail.exitCode != null && item.detail.exitCode !== 0;
    if (item.status === "failed" || shellFailed) {
      signatures.add(failureSignature(item));
    }
  }
  return [...signatures].sort();
}

function truncateAssistantResult(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, MAX_ASSISTANT_RESULT_CHARS);
}

export function buildOrchestrationEvidence(input: {
  timeline: readonly AgentTimelineItem[];
  turnStatus: "completed" | "failed" | "canceled";
  errorKind?: string;
  requiresHumanReview?: boolean;
  assistantResult?: string | null;
  git?: {
    isGit: boolean;
    isDirty: boolean | null;
    diffStat: { additions: number; deletions: number } | null;
  } | null;
}): OrchestrationEvidence {
  const checks = collectChecks(input.timeline);
  return {
    requiresHumanReview: input.requiresHumanReview ?? false,
    turn: {
      status: input.turnStatus,
      ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    },
    verificationStatus: verificationStatus(checks),
    checks,
    toolFailureSignatures: collectToolFailureSignatures(input.timeline),
    git: input.git
      ? {
          isGit: input.git.isGit,
          isDirty: input.git.isDirty,
          additions: input.git.diffStat?.additions ?? null,
          deletions: input.git.diffStat?.deletions ?? null,
        }
      : null,
    assistantResult: truncateAssistantResult(input.assistantResult),
  };
}
