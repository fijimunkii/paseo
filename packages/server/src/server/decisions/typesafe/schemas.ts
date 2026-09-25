import { z } from "zod";

const ProbabilitySchema = z.number().min(0).max(1);

const NoulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: ProbabilitySchema,
  })
  .strict();

const ChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: ProbabilitySchema,
    probabilities: z.record(z.string(), ProbabilitySchema),
  })
  .strict();

const ScoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number(),
    confidence: ProbabilitySchema,
    legend: z.record(z.string(), z.unknown()),
    probabilities: z.record(z.string(), ProbabilitySchema),
  })
  .strict();

export const TypeSafeAnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

export const TypeSafeSystemOneResponseSchema = z
  .object({
    model: z.string().min(1),
    answers: z.record(z.string(), TypeSafeAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const TypeSafeModelsResponseSchema = z
  .object({
    models: z.array(
      z
        .object({
          name: z.string().min(1),
          description: z.string(),
          release_date: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .strict();

export type TypeSafeSystemOneResponse = z.infer<typeof TypeSafeSystemOneResponseSchema>;
export type TypeSafeModel = z.infer<typeof TypeSafeModelsResponseSchema>["models"][number];
