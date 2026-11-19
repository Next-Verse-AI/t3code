import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Item verdicts in a qa-mine or qa-theirs `results.json` ledger, worst to best. */
export const QA_LEDGER_STATUSES = [
  "not_run",
  "waiting",
  "blocked",
  "fail",
  "partial",
  "pass",
  "out_of_scope",
] as const;
export const QaLedgerStatus = Schema.Literals(QA_LEDGER_STATUSES);
export type QaLedgerStatus = typeof QaLedgerStatus.Type;

export const QaLedgerInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type QaLedgerInput = typeof QaLedgerInput.Type;

/** The newest QA run ledger for a pull request, found in the project's worktrees. */
export const QaLedgerSummary = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  counts: Schema.Record(QaLedgerStatus, NonNegativeInt),
});
export type QaLedgerSummary = typeof QaLedgerSummary.Type;
