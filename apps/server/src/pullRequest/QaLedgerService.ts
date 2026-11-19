// qa-mine and qa-theirs keep each run's ledger at `<worktree>/.context/qa/runs/<run>/results.json`
// (older runs at `.context/qa/<name>/results.json`) in whichever worktree ran QA, so every
// worktree of each project on the pull request's repository is searched.
import {
  QA_LEDGER_STATUSES,
  type QaLedgerInput,
  type QaLedgerStatus,
  type QaLedgerSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const STATUSES: ReadonlySet<string> = new Set(QA_LEDGER_STATUSES);

export interface QaLedgerCandidate {
  readonly text: string;
  /** ISO time the ledger was last written. */
  readonly modifiedAt: string;
}

const pullRequestOf = (url: unknown) => {
  if (typeof url !== "string") return null;
  const match = /\/([^/\s]+\/[^/\s]+)\/(?:pull|merge_requests)\/(\d+)(?:\D|$)/.exec(url);
  return match === null ? null : { repository: match[1]!.toLowerCase(), number: Number(match[2]) };
};

/** Counts a ledger's item verdicts when it records a QA run of this pull request. */
export function readQaLedger(
  candidate: QaLedgerCandidate,
  target: Pick<QaLedgerInput, "repository" | "number">,
): QaLedgerSummary | null {
  let ledger: unknown;
  try {
    ledger = JSON.parse(candidate.text);
  } catch {
    return null;
  }
  if (typeof ledger !== "object" || ledger === null) return null;
  const record = ledger as Record<string, unknown>;
  const pullRequest = pullRequestOf(record.pr_url);
  if (
    pullRequest === null ||
    pullRequest.repository !== target.repository.toLowerCase() ||
    pullRequest.number !== target.number ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  const counts = Object.fromEntries(QA_LEDGER_STATUSES.map((status) => [status, 0])) as Record<
    QaLedgerStatus,
    number
  >;
  for (const item of record.items as ReadonlyArray<unknown>) {
    const status = (item as { readonly status?: unknown } | null)?.status;
    if (typeof status === "string" && STATUSES.has(status)) counts[status as QaLedgerStatus] += 1;
  }
  return {
    runId: typeof record.run_id === "string" ? record.run_id : null,
    headSha: typeof record.head_sha === "string" && record.head_sha !== "" ? record.head_sha : null,
    updatedAt: candidate.modifiedAt,
    counts,
  };
}

/** The most recently written ledger of this pull request's QA runs. */
export function newestQaLedger(
  candidates: ReadonlyArray<QaLedgerCandidate>,
  target: Pick<QaLedgerInput, "repository" | "number">,
): QaLedgerSummary | null {
  let newest: QaLedgerSummary | null = null;
  for (const candidate of candidates) {
    const summary = readQaLedger(candidate, target);
    if (summary !== null && (newest === null || summary.updatedAt > newest.updatedAt)) {
      newest = summary;
    }
  }
  return newest;
}

class QaLedgerService extends Context.Service<
  QaLedgerService,
  {
    readonly latest: (input: QaLedgerInput) => Effect.Effect<QaLedgerSummary | null>;
  }
>()("t3/pullRequest/QaLedgerService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const listNames = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): string[] => []));

  // Untraced: one read per ledger file across hundreds of worktrees; `latest` carries the span.
  const readCandidate = Effect.fnUntraced(
    function* (file: string) {
      const info = yield* fileSystem.stat(file);
      if (Option.isNone(info.mtime)) return Option.none<QaLedgerCandidate>();
      const text = yield* fileSystem.readFileString(file);
      return Option.some({ text, modifiedAt: info.mtime.value.toISOString() });
    },
    Effect.orElseSucceed(() => Option.none<QaLedgerCandidate>()),
  );

  // Git records each linked worktree's `.git` file path in `<repo>/.git/worktrees/<name>/gitdir`.
  const linkedWorktrees = Effect.fnUntraced(function* (root: string) {
    const registry = path.join(root, ".git", "worktrees");
    const names = yield* listNames(registry);
    const paths = yield* Effect.forEach(
      names,
      (name) =>
        fileSystem.readFileString(path.join(registry, name, "gitdir")).pipe(
          Effect.map((gitdir) => path.dirname(gitdir.trim())),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 16 },
    );
    return paths.filter((worktree) => worktree !== null);
  });

  const ledgersIn = Effect.fnUntraced(function* (worktree: string) {
    const qaRoot = path.join(worktree, ".context", "qa");
    const runsRoot = path.join(qaRoot, "runs");
    const files = [
      ...(yield* listNames(runsRoot)).map((name) => path.join(runsRoot, name, "results.json")),
      ...(yield* listNames(qaRoot))
        .filter((name) => name !== "runs")
        .map((name) => path.join(qaRoot, name, "results.json")),
    ];
    const read = yield* Effect.forEach(files, readCandidate, { concurrency: 8 });
    return read.flatMap((candidate) => (Option.isSome(candidate) ? [candidate.value] : []));
  });

  const latest: QaLedgerService["Service"]["latest"] = Effect.fn("QaLedgerService.latest")(
    function* (input) {
      const repository = input.repository.toLowerCase();
      const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
      const roots = projects
        .filter((project) => {
          const identity = project.repositoryIdentity;
          const name =
            identity?.owner !== undefined && identity.name !== undefined
              ? `${identity.owner}/${identity.name}`
              : identity?.displayName;
          return project.id === input.projectId || name?.toLowerCase() === repository;
        })
        .map((project) => project.workspaceRoot);
      const worktrees = new Set<string>();
      for (const root of roots) {
        worktrees.add(root);
        for (const worktree of yield* linkedWorktrees(root)) worktrees.add(worktree);
      }
      const candidates = yield* Effect.forEach(worktrees, ledgersIn, { concurrency: 8 });
      return newestQaLedger(candidates.flat(), input);
    },
  );

  return QaLedgerService.of({ latest });
});
