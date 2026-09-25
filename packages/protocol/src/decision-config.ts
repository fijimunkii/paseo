import { z } from "zod";

export const DecisionModeSchema = z.enum(["shadow", "enforce"]);
export const DecisionFailureDispositionSchema = z.enum(["review", "deny"]);

export const OrchestrationLaneIdSchema = z.enum(["small", "medium", "high", "escalated"]);
export const OrchestrationRoutingModeSchema = z.enum(["manual", "managed"]);

export const OrchestrationExecutionLaneSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    thinkingOptionId: z.string().trim().min(1).optional(),
  })
  .strict();

export const OrchestrationDecisionPolicyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    minimumConfidence: z.number().min(0).max(1).default(0.85),
    failureDisposition: DecisionFailureDispositionSchema.default("review"),
    defaultRouting: OrchestrationRoutingModeSchema.default("manual"),
    maxAttempts: z.number().int().positive().max(10).default(3),
    maxEscalations: z.number().int().nonnegative().max(3).default(1),
    lanes: z
      .object({
        small: OrchestrationExecutionLaneSchema,
        medium: OrchestrationExecutionLaneSchema,
        high: OrchestrationExecutionLaneSchema,
        escalated: OrchestrationExecutionLaneSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && !value.lanes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lanes"],
        message: "Enabled orchestration requires all execution lanes",
      });
    }
  });

export const TypeSafeDecisionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.url().default("https://api.typesafe.ai"),
    model: z.string().trim().min(1).default("jev-latest"),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    maxConcurrency: z.number().int().positive().max(32).default(4),
  })
  .strict();

export const CreateAgentToolDecisionPolicyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    minimumConfidence: z.number().min(0).max(1).default(0.9),
    failureDisposition: DecisionFailureDispositionSchema.default("review"),
  })
  .strict();

export const DecisionPoliciesConfigSchema = z
  .object({
    createAgentTool: CreateAgentToolDecisionPolicyConfigSchema.optional(),
    orchestration: OrchestrationDecisionPolicyConfigSchema.optional(),
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
export type OrchestrationLaneId = z.infer<typeof OrchestrationLaneIdSchema>;
export type OrchestrationRoutingMode = z.infer<typeof OrchestrationRoutingModeSchema>;
export type OrchestrationExecutionLane = z.infer<typeof OrchestrationExecutionLaneSchema>;
export type OrchestrationDecisionPolicyConfig = z.infer<
  typeof OrchestrationDecisionPolicyConfigSchema
>;
export type DecisionFailureDisposition = z.infer<typeof DecisionFailureDispositionSchema>;
export type TypeSafeDecisionConfig = z.infer<typeof TypeSafeDecisionConfigSchema>;
export type CreateAgentToolDecisionPolicyConfig = z.infer<
  typeof CreateAgentToolDecisionPolicyConfigSchema
>;
export type DecisionPoliciesConfig = z.infer<typeof DecisionPoliciesConfigSchema>;
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;
