import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PullRequestDeploymentInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
});
export type PullRequestDeploymentInput = typeof PullRequestDeploymentInput.Type;

/** The newest GitHub deployment of a pull request's head branch. */
export const PullRequestDeployment = Schema.Struct({
  environment: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  /** Running covers waiting, queued, pending and in progress. Inactive was replaced by a newer one. */
  state: Schema.Literals(["running", "success", "failure", "inactive"]),
  createdAt: IsoDateTime,
  /** When it reached its final state; null while it is still running. */
  finishedAt: Schema.NullOr(IsoDateTime),
  /** The deploy job's log, else the deployed environment. */
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestDeployment = typeof PullRequestDeployment.Type;
