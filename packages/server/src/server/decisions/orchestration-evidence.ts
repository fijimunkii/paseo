import { createHash } from "node:crypto";
import path from "node:path";

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
  changedPaths: string[];
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
}

function classifyVerificationCommand(command: string): OrchestrationCheckKind | null {
  if (/[\r\n]/u.test(command)) {
    return null;
  }
  const normalized = command.trim().replace(/\s+/gu, " ").toLowerCase();
  if (!normalized || /[;&|<>`]|\$\(/u.test(normalized)) {
    return null;
  }

  if (
    /^(?:(?:npm|pnpm|yarn|bun)(?: run)? test\b|npx (?:vitest|jest)\b|(?:vitest|jest|pytest)\b|python(?:3)? -m pytest\b|cargo test\b|go test\b)/u.test(
      normalized,
    )
  ) {
    return "test";
  }
  if (
    /^(?:(?:npm|pnpm|yarn|bun)(?: run)? typecheck\b|npx (?:tsc|mypy|pyright)\b|(?:tsc|mypy|pyright)\b)/u.test(
      normalized,
    )
  ) {
    return "typecheck";
  }
  if (
    /^(?:(?:npm|pnpm|yarn|bun)(?: run)? lint\b|npx (?:eslint|oxlint)\b|(?:eslint|oxlint)\b|ruff check\b)/u.test(
      normalized,
    )
  ) {
    return "lint";
  }
  if (
    /^(?:(?:npm|pnpm|yarn)(?: run)? build\b|bun run build\b|cargo (?:build|check)\b|go (?:build|vet)\b)/u.test(
      normalized,
    )
  ) {
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

function boundedChangedPath(filePath: string, workspaceRoot: string | undefined): string {
  const pathApi = path.win32.isAbsolute(filePath) ? path.win32 : path;
  if (!pathApi.isAbsolute(filePath)) {
    return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  }

  if (workspaceRoot && pathApi.isAbsolute(workspaceRoot)) {
    const relative = pathApi.relative(workspaceRoot, filePath);
    const outsideWorkspace =
      relative === ".." ||
      relative.startsWith(".." + pathApi.sep) ||
      pathApi.isAbsolute(relative);
    if (!outsideWorkspace) {
      return relative.split(pathApi.sep).join("/");
    }
  }
  return pathApi.basename(filePath);
}

export function buildOrchestrationEvidence(input: {
  timeline: readonly AgentTimelineItem[];
  turnStatus: "completed" | "failed" | "canceled";
  errorKind?: string;
  requiresHumanReview?: boolean;
  changedPaths?: readonly string[];
  workspaceRoot?: string;
  git?: {
    isGit: boolean;
    isDirty: boolean | null;
    diffStat: { additions: number; deletions: number } | null;
  } | null;
}): OrchestrationEvidence {
  const checks = collectChecks(input.timeline);
  const timelineChangedPaths = input.timeline.flatMap((item) => {
    if (item.type !== "tool_call") {
      return [];
    }
    if (item.detail.type === "edit" || item.detail.type === "write") {
      return [boundedChangedPath(item.detail.filePath, input.workspaceRoot)];
    }
    return [];
  });
  const configuredChangedPaths = (input.changedPaths ?? []).map((filePath) =>
    boundedChangedPath(filePath, input.workspaceRoot),
  );
  const changedPaths = [...new Set([...configuredChangedPaths, ...timelineChangedPaths])]
    .sort()
    .slice(0, 100);

  return {
    requiresHumanReview: input.requiresHumanReview ?? false,
    changedPaths,
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
  };
}
