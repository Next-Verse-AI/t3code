import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalCiRunInput = Schema.Struct({
  headBranch: TrimmedNonEmptyString,
  headSha: Schema.optional(TrimmedNonEmptyString),
});
export type LocalCiRunInput = typeof LocalCiRunInput.Type;

/** A `cd:local` run in progress on this environment, in a checkout of the pull request. */
export const LocalCiRun = Schema.Struct({
  /** Milliseconds since the epoch, on the environment's clock. */
  startedAt: NonNegativeInt,
  cwd: TrimmedNonEmptyString,
});
export type LocalCiRun = typeof LocalCiRun.Type;
