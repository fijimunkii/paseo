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
      timeline: [shell("npm test", 0), shell("npm run typecheck", 0), shell("npm run lint", 0)],
      turnStatus: "completed",
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

  test("does not trust verification commands with wrappers or masked exit codes", () => {
    const evidence = buildOrchestrationEvidence({
      timeline: [
        shell("echo npm test", 0),
        shell("npm test || true", 0),
        shell("npm test; echo ignored", 0),
        shell("sh -c 'npm test'", 0),
      ],
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

  test("normalizes absolute changed paths before external decision state", () => {
    const posix = buildOrchestrationEvidence({
      timeline: [
        {
          type: "tool_call",
          callId: "write-posix",
          name: "write",
          status: "completed",
          error: null,
          detail: {
            type: "write",
            filePath: "/Users/alice/repo/src/app.ts",
          },
        },
      ],
      turnStatus: "completed",
      workspaceRoot: "/Users/alice/repo",
      changedPaths: ["/Users/alice/private/secret.txt"],
    });
    expect(posix.changedPaths).toEqual(["secret.txt", "src/app.ts"]);

    const windows = buildOrchestrationEvidence({
      timeline: [
        {
          type: "tool_call",
          callId: "write-windows",
          name: "write",
          status: "completed",
          error: null,
          detail: {
            type: "write",
            filePath: "C:\\repo\\src\\app.ts",
          },
        },
      ],
      turnStatus: "completed",
      workspaceRoot: "C:\\repo",
    });
    expect(windows.changedPaths).toEqual(["src/app.ts"]);
  });

  test("deduplicates, sorts, and bounds changed paths", () => {
    const changedPaths = [
      "z.ts",
      "a.ts",
      "a.ts",
      ...Array.from({ length: 120 }, (_, index) => `file-${String(index).padStart(3, "0")}.ts`),
    ];
    const evidence = buildOrchestrationEvidence({
      timeline: [],
      turnStatus: "completed",
      changedPaths,
    });

    expect(evidence.changedPaths).toHaveLength(100);
    expect(evidence.changedPaths[0]).toBe("a.ts");
    expect(new Set(evidence.changedPaths).size).toBe(evidence.changedPaths.length);
  });
});
