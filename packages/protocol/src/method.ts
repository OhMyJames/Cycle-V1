import type { z } from "zod";

/**
 * A request or notification only Cycle defines, named `_cycle/...` (ACP reserves the `_` prefix for
 * extensions). The name and the schemas of what it takes and answers live in one definition, so the
 * daemon routes and checks by it and a client sends and checks from the same place.
 */
export type CycleMethod<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> = {
  readonly name: `_cycle/${string}`;
  readonly params: P;
  readonly result: R;
};

export const cycleMethod = <P extends z.ZodType, R extends z.ZodType>(
  name: `_cycle/${string}`,
  params: P,
  result: R,
): CycleMethod<P, R> => ({ name, params, result });

/** What a method takes, as a caller writes it. */
export type ParamsOf<M extends CycleMethod> = z.input<M["params"]>;
/** What a method answers, as it arrives. */
export type ResultOf<M extends CycleMethod> = z.output<M["result"]>;
