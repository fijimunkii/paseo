import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export const DecisionDispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow") }).strict(),
  z.object({ kind: z.literal("deny") }).strict(),
  z.object({ kind: z.literal("review") }).strict(),
  z.object({ kind: z.literal("route"), target: z.string().min(1) }).strict(),
]);

const DecisionUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const DecisionContextSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
  })
  .strict();

export const DecisionAuditRecordSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime({ offset: true }),
    definitionId: z.string().min(1),
    definitionVersion: z.string().min(1),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedModel: z.string().min(1),
    model: z.string().min(1).nullable(),
    mode: z.enum(["shadow", "enforce"]),
    status: z.enum(["resolved", "failed"]),
    wouldDisposition: DecisionDispositionSchema,
    actualDisposition: DecisionDispositionSchema,
    answers: z.record(z.string(), z.unknown()).optional(),
    usage: DecisionUsageSchema.optional(),
    latencyMs: z.number().int().nonnegative(),
    errorKind: z.string().min(1).optional(),
    context: DecisionContextSchema.optional(),
  })
  .strict();

export type DecisionAuditRecord = z.infer<typeof DecisionAuditRecordSchema>;

export interface DecisionAuditStoreLike {
  get(fingerprint: string): DecisionAuditRecord | null;
  put(record: DecisionAuditRecord): void;
}

export class DecisionAuditStore implements DecisionAuditStoreLike {
  private readonly directory: string;

  constructor(paseoHome: string) {
    this.directory = path.join(paseoHome, "decisions");
  }

  get(fingerprint: string): DecisionAuditRecord | null {
    const filePath = this.pathFor(fingerprint);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
    ensurePrivateFile(filePath);
    return DecisionAuditRecordSchema.parse(JSON.parse(raw));
  }

  put(record: DecisionAuditRecord): void {
    const parsed = DecisionAuditRecordSchema.parse(record);
    writePrivateFileAtomicSync(
      this.pathFor(parsed.fingerprint),
      JSON.stringify(parsed, null, 2) + "\n",
    );
  }

  private pathFor(fingerprint: string): string {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new Error("Invalid decision fingerprint");
    }
    return path.join(this.directory, fingerprint + ".json");
  }
}
