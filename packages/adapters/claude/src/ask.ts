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
const otherKeyOf = (index: number) => `q${index}_other`;
/** What a person may write for "Other". A limit, so that a form cannot carry a document. */
const OTHER_MAX = 2000;

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
            items: { anyOf: options },
          }
        : {
            type: "string",
            title: q.header ?? q.question,
            description: q.question,
            oneOf: options,
          };
    // The tool always lets a person answer in their own words. A flat form cannot say "one of
    // these or free text" in one field, so the free text is its own optional field.
    properties[otherKeyOf(index)] = {
      type: "string",
      title: "Other",
      description: "Your own answer, if none of the choices fits",
      maxLength: OTHER_MAX,
    };
  }
  return {
    message:
      questions.length === 1 ? (questions[0] as Question).question : "Claude has some questions",
    requestedSchema: {
      type: "object",
      properties,
    },
  };
};

/**
 * The tool's `answers` from what the form came back with. A question left unanswered is left out.
 * A written answer replaces a single choice, and is one more label of a multiple choice.
 */
export const answersOf = (
  questions: readonly Question[],
  content: Record<string, unknown> | null | undefined,
): Record<string, string> => {
  const answers: Record<string, string> = {};
  for (const [index, q] of questions.entries()) {
    const value = content?.[keyOf(index)];
    const written = content?.[otherKeyOf(index)];
    const other = typeof written === "string" ? written.trim() : "";
    if (Array.isArray(value)) {
      const labels = [...value.map(String), ...(other === "" ? [] : [other])];
      if (labels.length > 0) answers[q.question] = labels.join(", ");
    } else if (other !== "") {
      answers[q.question] = other;
    } else if (typeof value === "string" && value !== "") {
      answers[q.question] = value;
    }
  }
  return answers;
};
