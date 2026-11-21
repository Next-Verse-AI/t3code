// How far a pull request's head is behind its base, and the stack around it, read from GitHub
// with the `gh` CLI. A base that is not a protected branch is another pull request's branch.
import type {
  PullRequestBaseStatus,
  PullRequestBaseStatusInput,
  PullRequestStackLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

const GH_TIMEOUT = Duration.seconds(15);
const GH_MAX_OUTPUT_BYTES = 1024 * 1024;
const PR_FIELDS = "number,url,state,isDraft,baseRefName";

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Reads `gh pr list --json number,url,state,isDraft,baseRefName` output. */
export function parseStackLinks(text: string): ReadonlyArray<PullRequestStackLink> {
  const rows = parseJson(text);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return [];
    const { number, url, state, isDraft, baseRefName } = row as Record<string, unknown>;
    const normalized = typeof state === "string" ? state.toLowerCase() : "";
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof url !== "string" ||
      url === "" ||
      typeof baseRefName !== "string" ||
      baseRefName === "" ||
      (normalized !== "open" && normalized !== "closed" && normalized !== "merged")
    ) {
      return [];
    }
    return [{ number, url, state: normalized, isDraft: isDraft === true, baseBranch: baseRefName }];
  });
}

/** The parent among the pull requests from a branch: the open one, else the newest. */
export function pickParent(
  links: ReadonlyArray<PullRequestStackLink>,
): PullRequestStackLink | null {
  const open = links.find((link) => link.state === "open");
  if (open !== undefined) return open;
  return links.toSorted((left, right) => right.number - left.number)[0] ?? null;
}

/** Reads `behind_by` from a compare response. */
export function parseBehindBy(text: string): number | null {
  const body = parseJson(text) as { readonly behind_by?: unknown } | null;
  const behind = body?.behind_by;
  return typeof behind === "number" && Number.isInteger(behind) && behind >= 0 ? behind : null;
}

class PullRequestBaseStatusService extends Context.Service<
  PullRequestBaseStatusService,
  {
    readonly read: (
      input: PullRequestBaseStatusInput,
    ) => Effect.Effect<PullRequestBaseStatus | null>;
  }
>()("t3/pullRequest/PullRequestBaseStatusService") {}

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

  const read: PullRequestBaseStatusService["Service"]["read"] = Effect.fn(
    "PullRequestBaseStatusService.read",
  )(function* (input) {
    const repo = input.repository;
    const branchPath = encodeURIComponent(input.baseBranch);
    const [branch, compare, children] = yield* Effect.all(
      [
        gh(["api", `repos/${repo}/branches/${branchPath}`, "--jq", ".protected"]),
        gh([
          "api",
          `repos/${repo}/compare/${branchPath}...${encodeURIComponent(input.headSha)}`,
          "--jq",
          "{behind_by: .behind_by}",
        ]),
        gh([
          "pr",
          "list",
          "-R",
          repo,
          "--base",
          input.headBranch,
          "--state",
          "open",
          "--json",
          PR_FIELDS,
          "--limit",
          "20",
        ]),
      ],
      { concurrency: "unbounded" },
    );
    // A deleted base branch reads as not protected: it was a parent PR's branch.
    if (branch === null && compare === null && children === null) return null;
    const protectedBase = branch?.trim() === "true";
    const parent = protectedBase
      ? null
      : pickParent(
          parseStackLinks(
            (yield* gh([
              "pr",
              "list",
              "-R",
              repo,
              "--head",
              input.baseBranch,
              "--state",
              "all",
              "--json",
              PR_FIELDS,
              "--limit",
              "10",
            ])) ?? "",
          ),
        );
    return {
      protectedBase,
      behindBy: compare === null ? null : parseBehindBy(compare),
      parent,
      children: parseStackLinks(children ?? "").toSorted(
        (left, right) => left.number - right.number,
      ),
    };
  });

  return PullRequestBaseStatusService.of({ read });
});
