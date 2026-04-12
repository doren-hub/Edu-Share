export type UserRole =
  | "school_student"
  | "expert"
  | "certification"
  | "general";

export type SourceType = "school" | "expert";

export type DocumentType = "past_exam" | "paper";

export type MultipleChoiceQuestion = {
  id: string;
  type: "multiple_choice";
  prompt: string;
  options: string[];
  correctIndex: number;
};

export type EssayQuestion = {
  id: string;
  type: "essay";
  prompt: string;
  referenceAnswer?: string;
};

export type StoredQuestion = MultipleChoiceQuestion | EssayQuestion;

export type ClientQuestion =
  | Omit<MultipleChoiceQuestion, "correctIndex">
  | Pick<EssayQuestion, "id" | "type" | "prompt">;

export type QuizGeneration = {
  questions: StoredQuestion[];
};

export type AnswerMap = Record<string, number | string>;
