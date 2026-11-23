// The newest GitHub deployment of a pull request's head branch, and how far it has got, read
// with the `gh` CLI.
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

  const latest: PullRequestDeploymentService["Service"]["latest"] = Effect.fn(
    "PullRequestDeploymentService.latest",
  )(function* (input) {
    const repo = input.repository;
    const listed = yield* gh([
      "api",
      `repos/${repo}/deployments?ref=${encodeURIComponent(input.headBranch)}&per_page=1`,
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

  return PullRequestDeploymentService.of({ latest });
});
