import { z } from "zod";

export const DecisionModeSchema = z.enum(["shadow", "enforce"]);
export const DecisionFailureDispositionSchema = z.enum(["review", "deny"]);

export const TypeSafeDecisionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.url().default("https://api.typesafe.ai"),
    model: z.string().trim().min(1).default("jev-latest"),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    maxConcurrency: z.number().int().positive().max(32).default(4),
  })
  .strict();

export const AgentCreateDecisionPolicyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    minimumConfidence: z.number().min(0).max(1).default(0.9),
    failureDisposition: DecisionFailureDispositionSchema.default("review"),
  })
  .strict();

export const DecisionPoliciesConfigSchema = z
  .object({
    agentCreate: AgentCreateDecisionPolicyConfigSchema.optional(),
  })
  .strict();

export const DecisionConfigSchema = z
  .object({
    mode: DecisionModeSchema.default("shadow"),
    typesafe: TypeSafeDecisionConfigSchema.optional(),
    policies: DecisionPoliciesConfigSchema.default({}),
  })
  .strict();

export type DecisionMode = z.infer<typeof DecisionModeSchema>;
export type DecisionFailureDisposition = z.infer<typeof DecisionFailureDispositionSchema>;
export type TypeSafeDecisionConfig = z.infer<typeof TypeSafeDecisionConfigSchema>;
export type AgentCreateDecisionPolicyConfig = z.infer<
  typeof AgentCreateDecisionPolicyConfigSchema
>;
export type DecisionPoliciesConfig = z.infer<typeof DecisionPoliciesConfigSchema>;
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;
