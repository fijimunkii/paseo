import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { buildOrchestrationEvidence } from "./orchestration-evidence.js";

function shell(
  command: string,
  exitCode: number,
  status: "completed" | "failed" = exitCode === 0 ? "completed" : "failed",
): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: command,
    name: "shell",
    status,
    error: status === "failed" ? "failed" : null,
    detail: {
      type: "shell",
      command,
      exitCode,
    },
  };
}

describe("buildOrchestrationEvidence", () => {
  test("derives verification from observed deterministic tool results", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [
        shell("npm test", 0),
        shell("npm run typecheck", 0),
        shell("npm run lint", 0),
      ],
      turnStatus: "completed",
      assistantResult: "Implemented and verified.",
      git: {
        isGit: true,
        isDirty: true,
        diffStat: { additions: 12, deletions: 3 },
      },
    });

    expect(evidence.verificationStatus).toBe("passed");
    expect(evidence.checks).toEqual([
      { kind: "lint", status: "passed" },
      { kind: "test", status: "passed" },
      { kind: "typecheck", status: "passed" },
    ]);
    expect(evidence.git).toEqual({
      isGit: true,
      isDirty: true,
      additions: 12,
      deletions: 3,
    });
  });

  test("failed deterministic verification wins over successful checks", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [shell("npm test", 0), shell("npm test", 1)],
      turnStatus: "completed",
    });

    expect(evidence.verificationStatus).toBe("failed");
    expect(evidence.checks).toEqual([{ kind: "test", status: "failed" }]);
    expect(evidence.toolFailureSignatures).toHaveLength(1);
  });

  test("does not treat ordinary shell commands as verification", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [shell("git diff --stat", 0), shell("sed -n '1,20p' file.ts", 0)],
      turnStatus: "completed",
    });

    expect(evidence.verificationStatus).toBe("not_run");
    expect(evidence.checks).toEqual([]);
  });

  test("deduplicates failure signatures so repeated identical failures do not create lottery tickets", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [shell("npm test", 1), shell("npm test", 1), shell("npm run lint", 1)],
      turnStatus: "failed",
      errorKind: "verification",
    });

    expect(evidence.toolFailureSignatures).toHaveLength(2);
    expect(new Set(evidence.toolFailureSignatures).size).toBe(2);
  });

  test("bounds assistant output before it becomes external decision state", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [],
      turnStatus: "completed",
      assistantResult: "x".repeat(3_000),
    });

    expect(evidence.assistantResult).toHaveLength(2_000);
  });
});
