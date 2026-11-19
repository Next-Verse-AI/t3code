import type { PullRequestCheck, QaLedgerStatus } from "@t3tools/contracts";

/** The GitHub account the Conductor review bot posts as. */
const CONDUCTOR_BOT_LOGIN = "nv-amd";

interface Comment {
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly url: string | null;
}

const firstLine = (body: string) => body.trimStart().split("\n", 1)[0]?.trim() ?? "";
const isConductor = (comment: Comment) =>
  comment.author?.login.toLowerCase() === CONDUCTOR_BOT_LOGIN;
const sameCommit = (sha: string, headSha: string | undefined) =>
  headSha !== undefined && sha.length >= 7 && headSha.toLowerCase().startsWith(sha.toLowerCase());

export type CheckCounts = Readonly<
  Record<"failing" | "pending" | "actionRequired" | "skipped" | "neutral" | "successful", number>
>;

export interface ChecksSummary {
  readonly state: "conflicting" | "failing" | "pending" | "passing" | "none";
  readonly counts: CheckCounts;
  readonly total: number;
}

export function summarizeChecks(
  checks: ReadonlyArray<Pick<PullRequestCheck, "status">>,
  conflicting: boolean,
): ChecksSummary {
  const count = (...statuses: ReadonlyArray<PullRequestCheck["status"]>) =>
    checks.filter((check) => statuses.includes(check.status)).length;
  const counts = {
    failing: count("failure", "cancelled"),
    pending: count("pending"),
    actionRequired: count("action-required"),
    skipped: count("skipped"),
    neutral: count("neutral"),
    successful: count("success"),
  };
  const state = conflicting
    ? "conflicting"
    : checks.length === 0
      ? "none"
      : counts.failing > 0
        ? "failing"
        : counts.pending + counts.actionRequired > 0
          ? "pending"
          : "passing";
  return { state, counts, total: checks.length };
}

export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface ConductorReview {
  readonly findings: Readonly<Record<FindingPriority, number>>;
  readonly total: number;
  /** The short SHA Conductor said it was reviewing, when it said. */
  readonly reviewedSha: string | null;
  /** Null when the review did not say which commit it covered. */
  readonly current: boolean | null;
  /** A newer review has started and not ended yet. */
  readonly reviewing: boolean;
  /** Whether any review finished; the findings come from the latest one that did. */
  readonly hasResult: boolean;
  /** Conductor's newest review comment: a result, or a run started, queued or ended since. */
  readonly url: string | null;
}

const REVIEW_RESULT = /^##\s+(?:no\s+)?findings\s+found\b/i;
const REVIEW_STARTED = /^Conductor started reviewing\b.*?\bat\s+([0-9a-f]{7,40})\b/i;
const REVIEW_QUEUED = /^Conductor review is queued\b/i;
const REVIEW_ENDED =
  /^(?:Review stopped|Conductor turn timed out|Conductor could not finish|Conductor paused)\b/i;
const FINDING_HEADING = /^#{2,4}\s+(?:\d+\.\s+)?\[(P[0-3])\]/;
// Findings a review rechecked from earlier rounds are listed under their own heading.
const EARLIER_FINDINGS_SECTION = /\b(?:prior|previous|earlier)\b/i;

function countFindings(body: string) {
  const findings: Record<FindingPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let inFindings = false;
  for (const line of body.split("\n")) {
    if (/^##\s/.test(line)) {
      inFindings = /finding/i.test(line) && !EARLIER_FINDINGS_SECTION.test(line);
      continue;
    }
    const priority = inFindings ? FINDING_HEADING.exec(line)?.[1] : undefined;
    if (priority !== undefined) findings[priority as FindingPriority] += 1;
  }
  return findings;
}

/** Reads the latest Conductor review result from the PR's comments, oldest first. */
export function summarizeConductorReview(
  comments: ReadonlyArray<Comment>,
  headSha: string | undefined,
): ConductorReview | null {
  const bot = comments.filter(isConductor);
  const resultIndex = bot.findLastIndex((comment) => REVIEW_RESULT.test(firstLine(comment.body)));
  const startedIndex = bot.findLastIndex((comment) => {
    const line = firstLine(comment.body);
    return REVIEW_STARTED.test(line) || REVIEW_QUEUED.test(line);
  });
  const endedIndex = bot.findLastIndex((comment) => REVIEW_ENDED.test(firstLine(comment.body)));
  const reviewing = startedIndex > resultIndex && startedIndex > endedIndex;
  const url = bot[Math.max(resultIndex, startedIndex, endedIndex)]?.url ?? null;
  if (resultIndex === -1) {
    return reviewing
      ? {
          findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
          total: 0,
          reviewedSha: null,
          current: null,
          reviewing,
          hasResult: false,
          url,
        }
      : null;
  }
  const result = bot[resultIndex]!;
  const reviewedSha =
    bot
      .slice(0, resultIndex)
      .findLast((comment) => REVIEW_STARTED.test(firstLine(comment.body)))
      ?.body.trimStart()
      .match(REVIEW_STARTED)?.[1] ?? null;
  const findings = countFindings(result.body);
  return {
    findings,
    total: findings.P0 + findings.P1 + findings.P2 + findings.P3,
    reviewedSha,
    current: reviewedSha === null ? null : sameCommit(reviewedSha, headSha),
    reviewing,
    hasResult: true,
    url,
  };
}

/** Verdicts that count toward the QA level; out-of-scope checks are left out, as the report does. */
const QA_COUNTED = ["pass", "partial", "fail", "blocked", "waiting", "not_run"] as const;

export interface QaLevel {
  readonly passed: number;
  readonly total: number;
  readonly state: "passing" | "failing" | "running" | "incomplete" | "empty";
}

export function summarizeQaLedger(counts: Readonly<Record<QaLedgerStatus, number>>): QaLevel {
  const total = QA_COUNTED.reduce((sum, status) => sum + counts[status], 0);
  const state =
    total === 0
      ? "empty"
      : counts.fail > 0
        ? "failing"
        : counts.pass === total
          ? "passing"
          : counts.waiting > 0
            ? "running"
            : "incomplete";
  return { passed: counts.pass, total, state };
}

export function isSameCommit(sha: string | null, headSha: string | undefined): boolean | null {
  return sha === null || headSha === undefined ? null : sameCommit(sha, headSha);
}

/** A running timer: `m:ss`, or `h:mm:ss` past an hour. */
export function formatRunClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}
