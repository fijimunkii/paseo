import { z } from "zod";

export const TypeSafeDecisionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.url().default("https://api.typesafe.ai"),
    model: z.string().trim().min(1).default("jev-latest"),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    maxConcurrency: z.number().int().positive().max(32).default(4),
  })
  .strict();

export const DecisionConfigSchema = z
  .object({
    typesafe: TypeSafeDecisionConfigSchema.optional(),
  })
  .strict();

export type TypeSafeDecisionConfig = z.infer<typeof TypeSafeDecisionConfigSchema>;
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;
