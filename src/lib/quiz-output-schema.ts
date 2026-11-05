import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

const fields = {
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  sourceExcerpt: z.string().trim().min(16),
};

// Shared schema for the model's tool contract and server-side validation.
// Keep accepting small batches: the API supplements them from past sessions.
export const generatedQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    ...fields,
    type: z.literal("multiple_choice"),
    options: z.array(z.string().trim().min(1)).length(4),
    correctIndex: z.number().int().min(0).max(3),
  }),
  z.object({
    ...fields,
    type: z.literal("essay"),
    referenceAnswer: z.string().trim().min(1).optional(),
  }),
]);

export const quizTool: Anthropic.Tool = {
  name: "submit_quiz",
  description: "教材の抜粋に基づく選択式・記述式の設問を提出する。",
  input_schema: z.toJSONSchema(z.object({
    questions: z.array(generatedQuestionSchema),
  })) as Anthropic.Tool.InputSchema,
};
