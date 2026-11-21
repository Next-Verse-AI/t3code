import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PullRequestBaseStatusInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
});
export type PullRequestBaseStatusInput = typeof PullRequestBaseStatusInput.Type;

export const PullRequestStackLink = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  baseBranch: TrimmedNonEmptyString,
});
export type PullRequestStackLink = typeof PullRequestStackLink.Type;

/** How a pull request's head stands against its base, and the stack around it. */
export const PullRequestBaseStatus = Schema.Struct({
  /** A protected base, such as `development`, is long-lived; anything else is another PR's branch. */
  protectedBase: Schema.Boolean,
  /** Commits on the base that the head does not have; null when the host could not compare. */
  behindBy: Schema.NullOr(NonNegativeInt),
  /** The pull request whose branch this one is based on, when it is stacked. */
  parent: Schema.NullOr(PullRequestStackLink),
  /** Open pull requests based on this one's branch. */
  children: Schema.Array(PullRequestStackLink),
});
export type PullRequestBaseStatus = typeof PullRequestBaseStatus.Type;
