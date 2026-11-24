// The newest GitHub deployment of a pull request's head branch, and how far it has got, read
// with the `gh` CLI. A deploy started by hand (a stacked PR's, or one into a branch the PR
// environment workflow hands over) is recorded under the branch that ran it, not the PR's, so the
// PR's own "PR environment" status comment and the run it links to say how far that one has got.
import type { PullRequestDeployment, PullRequestDeploymentInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

const GH_TIMEOUT = Duration.seconds(15);
const GH_MAX_OUTPUT_BYTES = 1024 * 1024;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export interface DeploymentRecord {
  readonly id: number;
  readonly environment: string;
  readonly sha: string;
  readonly createdAt: string;
}

/** Reads the first row of `gh api repos/{repo}/deployments`. */
export function parseDeployment(text: string): DeploymentRecord | null {
  const rows = parseJson(text);
  const row: unknown = Array.isArray(rows) ? rows[0] : null;
  if (typeof row !== "object" || row === null) return null;
  const { id, environment, sha, created_at } = row as Record<string, unknown>;
  const env = nonEmpty(environment);
  const commit = nonEmpty(sha);
  const created = nonEmpty(created_at);
  if (typeof id !== "number" || env === null || commit === null || created === null) return null;
  return { id, environment: env, sha: commit, createdAt: created };
}

const RUNNING = new Set(["waiting", "queued", "pending", "in_progress"]);
const FAILED = new Set(["failure", "error"]);

/** Folds a deployment's statuses (GitHub lists them newest first) into one state. */
export function summarizeDeployment(
  deployment: DeploymentRecord,
  statusesText: string,
): PullRequestDeployment {
  const rows = parseJson(statusesText);
  const statuses = (Array.isArray(rows) ? rows : []).flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return [];
    const { state, created_at, log_url, environment_url } = row as Record<string, unknown>;
    const name = nonEmpty(state);
    const at = nonEmpty(created_at);
    if (name === null || at === null) return [];
    return [
      { state: name, at, logUrl: nonEmpty(log_url), environmentUrl: nonEmpty(environment_url) },
    ];
  });
  const latest = statuses[0];
  // A deployment without statuses has been created and is waiting to start.
  const state: PullRequestDeployment["state"] =
    latest === undefined || RUNNING.has(latest.state)
      ? "running"
      : latest.state === "success"
        ? "success"
        : FAILED.has(latest.state)
          ? "failure"
          : "inactive";
  // An inactive deployment finished when it last succeeded or failed, not when it was replaced.
  const finished =
    state === "running"
      ? null
      : state === "inactive"
        ? (statuses.find((status) => status.state === "success" || FAILED.has(status.state)) ??
          latest)
        : latest;
  return {
    environment: deployment.environment,
    sha: deployment.sha,
    state,
    createdAt: deployment.createdAt,
    finishedAt: finished?.at ?? null,
    url:
      statuses.find((status) => status.logUrl !== null)?.logUrl ??
      statuses.find((status) => status.environmentUrl !== null)?.environmentUrl ??
      null,
  };
}

/** The hidden marker on the PR environment workflow's one status comment per PR. */
const ENVIRONMENT_COMMENT_MARKER = "<!-- nv-pr-environment -->";
const ENVIRONMENT_COMMENT_AUTHOR = "github-actions[bot]";

export interface EnvironmentComment {
  readonly body: string;
  readonly updatedAt: string;
}

/** The newest status comment among `gh api --paginate` JSON lines of `{body, user, updated_at}`. */
export function parseEnvironmentComment(text: string): EnvironmentComment | null {
  let newest: EnvironmentComment | null = null;
  for (const line of text.split("\n")) {
    const row = parseJson(line);
    if (typeof row !== "object" || row === null) continue;
    const { body, user, updated_at } = row as Record<string, unknown>;
    const content = nonEmpty(body);
    const at = nonEmpty(updated_at);
    if (content === null || at === null || !content.includes(ENVIRONMENT_COMMENT_MARKER)) continue;
    if (user !== ENVIRONMENT_COMMENT_AUTHOR) continue;
    if (newest === null || Date.parse(at) >= Date.parse(newest.updatedAt)) {
      newest = { body: content, updatedAt: at };
    }
  }
  return newest;
}

export interface EnvironmentCommentState {
  readonly state: PullRequestDeployment["state"];
  readonly sha: string;
  readonly runUrl: string | null;
}

const COMMENT_STATES: ReadonlyArray<readonly [RegExp, PullRequestDeployment["state"]]> = [
  [/PR environment: building `([0-9a-f]{7,40})`/i, "running"],
  [/PR environment: Starting services for `([0-9a-f]{7,40})`/i, "running"],
  [/PR environment: Live\*\* at \S+, running `([0-9a-f]{7,40})`/i, "success"],
  [/PR environment: Failed\*\* at \*[^*]*\* for `([0-9a-f]{7,40})`/i, "failure"],
  // Idle but still serving the commit it names.
  [/No push deployed since `([0-9a-f]{7,40})`/i, "success"],
];

/** What the status comment says; null once the environment is removed or the text is unknown. */
export function readEnvironmentComment(body: string): EnvironmentCommentState | null {
  const runUrl = /\[Build log\]\((https:\/\/[^)\s]+)\)/.exec(body)?.[1] ?? null;
  for (const [pattern, state] of COMMENT_STATES) {
    const sha = pattern.exec(body)?.[1];
    if (sha !== undefined) return { state, sha, runUrl };
  }
  return null;
}

/** The Actions run id in a build log link. */
export function runIdOf(url: string | null): string | null {
  return url === null ? null : (/\/actions\/runs\/(\d+)/.exec(url)?.[1] ?? null);
}

export interface RunRecord {
  readonly startedAt: string | null;
  readonly completed: boolean;
  readonly conclusion: string | null;
}

export function parseRun(text: string): RunRecord | null {
  const row = parseJson(text);
  if (typeof row !== "object" || row === null) return null;
  const { run_started_at, status, conclusion } = row as Record<string, unknown>;
  return {
    startedAt: nonEmpty(run_started_at),
    completed: status === "completed",
    conclusion: nonEmpty(conclusion),
  };
}

/**
 * A hand-started deploy, from the PR's status comment and its run: it started when the run did and
 * finished when the comment last changed. A run that ended badly while the comment still says it
 * is running failed before it could say so.
 */
export function summarizeEnvironmentComment(
  pr: number,
  comment: EnvironmentComment,
  run: RunRecord | null,
): PullRequestDeployment | null {
  const read = readEnvironmentComment(comment.body);
  if (read === null) return null;
  const stalled =
    read.state === "running" && run?.completed === true && run.conclusion !== "success";
  const state = stalled ? "failure" : read.state;
  const createdAt = run?.startedAt ?? comment.updatedAt;
  return {
    environment: `pr-${pr}`,
    sha: read.sha,
    state,
    createdAt,
    finishedAt: state === "running" ? null : comment.updatedAt,
    url: read.runUrl,
  };
}

/** The deploy that started last, of GitHub's record for the branch and the PR's status comment. */
export function newestDeployment(
  ...candidates: ReadonlyArray<PullRequestDeployment | null>
): PullRequestDeployment | null {
  let newest: PullRequestDeployment | null = null;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    if (newest === null || Date.parse(candidate.createdAt) > Date.parse(newest.createdAt)) {
      newest = candidate;
    }
  }
  return newest;
}

class PullRequestDeploymentService extends Context.Service<
  PullRequestDeploymentService,
  {
    readonly latest: (
      input: PullRequestDeploymentInput,
    ) => Effect.Effect<PullRequestDeployment | null>;
  }
>()("t3/pullRequest/PullRequestDeploymentService") {}

export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;

  /** Stdout of a successful `gh` call, or null. */
  const gh = (args: ReadonlyArray<string>) =>
    processes
      .run({ command: "gh", args, timeout: GH_TIMEOUT, maxOutputBytes: GH_MAX_OUTPUT_BYTES })
      .pipe(
        Effect.map((result) => (result.code === 0 && !result.timedOut ? result.stdout : null)),
        Effect.orElseSucceed(() => null),
      );

  const branchDeployment = Effect.fn("PullRequestDeploymentService.branchDeployment")(function* (
    repo: string,
    headBranch: string,
  ) {
    const listed = yield* gh([
      "api",
      `repos/${repo}/deployments?ref=${encodeURIComponent(headBranch)}&per_page=1`,
      "--jq",
      "map({id, environment, sha, created_at})",
    ]);
    const deployment = listed === null ? null : parseDeployment(listed);
    if (deployment === null) return null;
    const statuses = yield* gh([
      "api",
      `repos/${repo}/deployments/${deployment.id}/statuses?per_page=100`,
      "--jq",
      "map({state, created_at, log_url, environment_url})",
    ]);
    return summarizeDeployment(deployment, statuses ?? "[]");
  });

  const commentDeployment = Effect.fn("PullRequestDeploymentService.commentDeployment")(function* (
    repo: string,
    pr: number,
  ) {
    const comments = yield* gh([
      "api",
      "--paginate",
      `repos/${repo}/issues/${pr}/comments?per_page=100`,
      "--jq",
      `.[] | select(.body | contains("${ENVIRONMENT_COMMENT_MARKER}")) | {body, user: .user.login, updated_at}`,
    ]);
    const comment = comments === null ? null : parseEnvironmentComment(comments);
    if (comment === null) return null;
    const runId = runIdOf(readEnvironmentComment(comment.body)?.runUrl ?? null);
    const run =
      runId === null
        ? null
        : yield* gh([
            "api",
            `repos/${repo}/actions/runs/${runId}`,
            "--jq",
            "{run_started_at, status, conclusion}",
          ]);
    return summarizeEnvironmentComment(pr, comment, run === null ? null : parseRun(run));
  });

  const latest: PullRequestDeploymentService["Service"]["latest"] = Effect.fn(
    "PullRequestDeploymentService.latest",
  )(function* (input) {
    const repo = input.repository;
    const [byBranch, byComment] = yield* Effect.all(
      [
        branchDeployment(repo, input.headBranch),
        input.number === undefined ? Effect.succeed(null) : commentDeployment(repo, input.number),
      ],
      { concurrency: 2 },
    );
    return newestDeployment(byBranch, byComment);
  });

  return PullRequestDeploymentService.of({ latest });
});
