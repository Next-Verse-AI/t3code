import type { PullRequestCheck } from "@t3tools/contracts";

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
  if (resultIndex === -1) {
    return reviewing
      ? {
          findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
          total: 0,
          reviewedSha: null,
          current: null,
          reviewing,
          url: null,
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
    url: result.url,
  };
}

export interface QaLevel {
  readonly passed: number;
  readonly failed: number;
  /** Blocked, partial and not-run checks. */
  readonly open: number;
  readonly total: number;
  readonly state: "passing" | "failing" | "incomplete";
  readonly testedSha: string | null;
  /** Null when the report did not say which commit it tested. */
  readonly current: boolean | null;
  readonly url: string | null;
}

const QA_REPORT = /^#{1,6}\s*QA\s+(?:retest\s+)?results\b/i;
const QA_TESTED = /\*\*Tested:\*\*\s*commit\s+`([0-9a-f]{7,40})`/i;
// Reports put their totals on a labelled line; the overall line wins over a retest's own run.
const QA_TOTAL_LINES = [/overall now/i, /summary/i, /accepted results/i, /\d+\s+pass/i];

function countOf(line: string, pattern: RegExp) {
  return Number(pattern.exec(line)?.[1] ?? 0);
}

function readQaCounts(body: string) {
  const lines = body.split("\n");
  for (const label of QA_TOTAL_LINES) {
    const line = lines.find((candidate) => label.test(candidate) && /\d+\s+pass/i.test(candidate));
    if (line === undefined) continue;
    const passed = countOf(line, /(\d+)\s+pass(?:ed|es)?\b/i);
    const failed = countOf(line, /(\d+)\s+fail(?:ed|s|ures?)?\b/i);
    const open =
      countOf(line, /(\d+)\s+blocked\b/i) +
      countOf(line, /(\d+)\s+partial\b/i) +
      countOf(line, /(\d+)\s+not\s+run\b/i);
    return { passed, failed, open };
  }
  return null;
}

/** Reads the newest QA report that states its totals; a report split in parts states them once. */
export function summarizeQa(
  comments: ReadonlyArray<Comment>,
  headSha: string | undefined,
): QaLevel | null {
  for (const comment of comments.toReversed()) {
    if (!QA_REPORT.test(firstLine(comment.body))) continue;
    const counts = readQaCounts(comment.body);
    if (counts === null) continue;
    const total = counts.passed + counts.failed + counts.open;
    const testedSha = QA_TESTED.exec(comment.body)?.[1] ?? null;
    return {
      ...counts,
      total,
      state:
        counts.failed > 0
          ? "failing"
          : counts.open === 0 && counts.passed > 0
            ? "passing"
            : "incomplete",
      testedSha,
      current: testedSha === null ? null : sameCommit(testedSha, headSha),
      url: comment.url,
    };
  }
  return null;
}
