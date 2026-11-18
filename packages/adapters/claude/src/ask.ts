/**
 * Claude's `AskUserQuestion` tool as an ACP form, and the answer back (decision 0011). The tool
 * takes 1 to 4 questions, each with 2 to 4 options and a flag for choosing several; its result is
 * `answers`: the question's text to the chosen label, several joined by commas.
 */
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

const keyOf = (index: number) => `q${index}`;

export const questionsOf = (input: Record<string, unknown>): Question[] | undefined => {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  for (const q of questions as Question[]) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options) || q.options.length === 0) {
      return undefined;
    }
  }
  return questions as Question[];
};

export const formOf = (questions: readonly Question[]) => {
  const properties: Record<string, unknown> = {};
  for (const [index, q] of questions.entries()) {
    const options = q.options.map((o) => ({
      const: o.label,
      title: o.label,
      ...(o.description ? { description: o.description } : {}),
    }));
    properties[keyOf(index)] =
      q.multiSelect === true
        ? {
            type: "array",
            title: q.header ?? q.question,
            description: q.question,
            minItems: 1,
            items: { anyOf: options },
          }
        : {
            type: "string",
            title: q.header ?? q.question,
            description: q.question,
            oneOf: options,
          };
  }
  return {
    message:
      questions.length === 1 ? (questions[0] as Question).question : "Claude has some questions",
    requestedSchema: {
      type: "object",
      properties,
      required: questions.map((_, index) => keyOf(index)),
    },
  };
};

/** The tool's `answers` from what the form came back with. A question left unanswered is left out. */
export const answersOf = (
  questions: readonly Question[],
  content: Record<string, unknown> | null | undefined,
): Record<string, string> => {
  const answers: Record<string, string> = {};
  for (const [index, q] of questions.entries()) {
    const value = content?.[keyOf(index)];
    if (Array.isArray(value) && value.length > 0) answers[q.question] = value.join(", ");
    else if (typeof value === "string" && value !== "") answers[q.question] = value;
  }
  return answers;
};
