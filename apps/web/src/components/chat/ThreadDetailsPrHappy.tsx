import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestRef,
  QaLedgerStatus,
  QaLedgerSummary,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ScanSearchIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useNowSecond } from "~/hooks/useNowSecond";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { serverEnvironment } from "~/state/server";
import {
  useEnvironmentQuery,
  useEnvironmentQueryRefresh,
  useEnvironmentQuerySelector,
} from "~/state/query";

import { pullRequestPanelReference } from "../pullRequest/usePullRequestDetail";
import { Spinner } from "../ui/spinner";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_STATIC_ROW_CLASS } from "./threadDetailsPanelStyles";
import {
  type ChecksSummary,
  type ConductorReview,
  type FindingPriority,
  formatRunClock,
  isSameCommit,
  summarizeChecks,
  summarizeConductorReview,
  summarizeQaLedger,
} from "./prHappy.logic";

const ACTIVITY_REFRESH_MS = 2 * 60_000;
const LOCAL_CI_REFRESH_MS = LIVE_REFRESH_MIN_INTERVAL_MS;
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TONE = {
  success: "text-success-foreground",
  failure: "text-destructive",
  pending: "text-warning-foreground",
  muted: "text-muted-foreground/60",
} as const;
type Tone = keyof typeof TONE;

/** Arcs drawn clockwise from the top, each a share of the full circle. */
function Ring({
  arcs,
}: {
  arcs: ReadonlyArray<{ readonly share: number; readonly className: string }>;
}) {
  const starts = arcs.map((_, index) =>
    arcs.slice(0, index).reduce((sum, arc) => sum + arc.share * RING_CIRCUMFERENCE, 0),
  );
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="size-4.5 shrink-0 -rotate-90">
      <circle
        cx="9"
        cy="9"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.25"
        className="stroke-current text-muted-foreground/20"
      />
      {arcs.map((arc, index) => {
        if (arc.share <= 0) return null;
        const length = arc.share * RING_CIRCUMFERENCE;
        return (
          <circle
            // oxlint-disable-next-line react/no-array-index-key -- arcs are positional and never reorder
            key={index}
            cx="9"
            cy="9"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2.25"
            strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
            strokeDashoffset={-(starts[index] ?? 0)}
            className={cn("stroke-current", arc.className)}
          />
        );
      })}
    </svg>
  );
}

function StatRow({
  icon,
  title,
  detail,
  url,
  onOpen,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  url: string | null;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-2xs font-normal text-muted-foreground">{detail}</span>
      </span>
    </>
  );
  return url === null ? (
    <div className={THREAD_DETAILS_PANEL_STATIC_ROW_CLASS}>{content}</div>
  ) : (
    <ThreadDetailsControl
      variant="ghost"
      size="sm"
      part="row"
      multiline
      onClick={(event) => onOpen(event, url)}
      onAuxClick={(event) => onOpen(event, url)}
    >
      {content}
    </ThreadDetailsControl>
  );
}

function LocalCiRow({ startedAt }: { startedAt: number }) {
  const gt = useGT();
  const now = useNowSecond();
  return (
    <StatRow
      icon={
        <span className={cn("inline-flex shrink-0", TONE.pending)}>
          <Spinner size="md" />
        </span>
      }
      title={gt("Local CI/CD running")}
      detail={<span className="tabular-nums">{formatRunClock((now - startedAt) / 1000)}</span>}
      url={null}
      onOpen={() => undefined}
    />
  );
}

function ChecksRow({
  checks,
  url,
  onOpen,
}: {
  checks: ChecksSummary;
  url: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const gt = useGT();
  const { counts, total } = checks;
  const share = (count: number) => (total === 0 ? 0 : count / total);
  const parts = [
    counts.failing > 0 ? gt("{count} failing", { count: counts.failing }) : null,
    counts.pending > 0 ? gt("{count} in progress", { count: counts.pending }) : null,
    counts.actionRequired > 0
      ? gt("{count} awaiting action", { count: counts.actionRequired })
      : null,
    counts.skipped > 0 ? gt("{count} skipped", { count: counts.skipped }) : null,
    counts.neutral > 0 ? gt("{count} neutral", { count: counts.neutral }) : null,
    counts.successful > 0 ? gt("{count} successful", { count: counts.successful }) : null,
  ].filter((part) => part !== null);
  const title = {
    conflicting: gt("Checks awaiting conflict resolution"),
    failing: gt("Some checks were not successful"),
    pending: gt("Some checks haven't completed yet"),
    passing: gt("All checks have passed"),
    none: gt("No checks reported"),
  }[checks.state];
  return (
    <StatRow
      icon={
        <Ring
          arcs={[
            { share: share(counts.successful), className: TONE.success },
            { share: share(counts.failing), className: TONE.failure },
            { share: share(counts.pending + counts.actionRequired), className: TONE.pending },
            { share: share(counts.skipped + counts.neutral), className: TONE.muted },
          ]}
        />
      }
      title={title}
      detail={
        parts.length === 0
          ? gt("CI/CD")
          : gt("{list} {count, plural, one {check} other {checks}}", {
              list: parts.join(", "),
              count: total,
            })
      }
      url={url}
      onOpen={onOpen}
    />
  );
}

// The QA report's status colours, in its worst-to-best order.
const QA_STATUS_TONE = {
  not_run: "text-qa-not-run",
  waiting: "text-qa-waiting",
  blocked: "text-qa-blocked",
  fail: "text-qa-fail",
  partial: "text-qa-partial",
  pass: "text-qa-pass",
  out_of_scope: "text-qa-out-of-scope",
} as const satisfies Record<QaLedgerStatus, string>;
const QA_RING_ORDER = ["pass", "partial", "fail", "blocked", "waiting", "not_run"] as const;

function QaRow({
  ledger,
  loading,
  headSha,
}: {
  ledger: QaLedgerSummary | null;
  loading: boolean;
  headSha: string | undefined;
}) {
  const gt = useGT();
  const noop = () => undefined;
  if (ledger === null) {
    return (
      <StatRow
        icon={loading ? <Spinner size="md" tone="muted" /> : <Ring arcs={[]} />}
        title={gt("QA")}
        detail={loading ? gt("Loading...") : gt("No QA results yet")}
        url={null}
        onOpen={noop}
      />
    );
  }
  const qa = summarizeQaLedger(ledger.counts);
  const labels: Record<QaLedgerStatus, string> = {
    pass: gt("{count} passed", { count: ledger.counts.pass }),
    partial: gt("{count} partial", { count: ledger.counts.partial }),
    fail: gt("{count} failed", { count: ledger.counts.fail }),
    blocked: gt("{count} blocked", { count: ledger.counts.blocked }),
    waiting: gt("{count} running", { count: ledger.counts.waiting }),
    not_run: gt("{count} not run", { count: ledger.counts.not_run }),
    out_of_scope: gt("{count} out of scope", { count: ledger.counts.out_of_scope }),
  };
  const shown = ([...QA_RING_ORDER, "out_of_scope"] as const).filter(
    (status) => ledger.counts[status] > 0,
  );
  const stale = isSameCommit(ledger.headSha, headSha) === false;
  const levelTone =
    qa.state === "passing"
      ? QA_STATUS_TONE.pass
      : qa.state === "failing"
        ? QA_STATUS_TONE.fail
        : qa.state === "running"
          ? QA_STATUS_TONE.waiting
          : QA_STATUS_TONE.partial;
  return (
    <StatRow
      icon={
        <Ring
          arcs={QA_RING_ORDER.map((status) => ({
            share: qa.total === 0 ? 0 : ledger.counts[status] / qa.total,
            className: QA_STATUS_TONE[status],
          }))}
        />
      }
      title={
        <>
          {gt("QA")}{" "}
          <span className={cn("tabular-nums", levelTone)}>
            {qa.passed}/{qa.total}
          </span>{" "}
          {qa.state === "passing"
            ? gt("passing", { $context: "QA level: every check passed" })
            : qa.state === "failing"
              ? gt("failing", { $context: "QA level: some checks failed" })
              : qa.state === "running"
                ? gt("running", { $context: "QA level: checks are being tested now" })
                : gt("incomplete", { $context: "QA level: some checks not run yet" })}
        </>
      }
      detail={
        <>
          {shown.map((status, index) => (
            <span key={status}>
              {index > 0 ? " · " : null}
              <span className={cn("tabular-nums", QA_STATUS_TONE[status])}>{labels[status]}</span>
            </span>
          ))}
          {stale ? (
            <>
              {shown.length > 0 ? " · " : null}
              {gt("older commit")}
            </>
          ) : null}
        </>
      }
      url={null}
      onOpen={noop}
    />
  );
}

const PRIORITY_TONE: Record<FindingPriority, Tone> = {
  P0: "failure",
  P1: "failure",
  P2: "pending",
  P3: "muted",
};

function ConductorRow({
  review,
  loading,
  onOpen,
}: {
  review: ConductorReview | null;
  loading: boolean;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const gt = useGT();
  const priorities = (["P0", "P1", "P2", "P3"] as const).filter(
    (priority) => (review?.findings[priority] ?? 0) > 0,
  );
  const tone: Tone =
    review === null || review.url === null
      ? "muted"
      : review.findings.P0 + review.findings.P1 > 0
        ? "failure"
        : review.total > 0
          ? "pending"
          : "success";
  const icon =
    loading || review?.reviewing ? (
      <Spinner size="md" tone="muted" />
    ) : (
      <ScanSearchIcon aria-hidden className={cn("size-4 shrink-0", TONE[tone])} />
    );
  const findings =
    review === null || review.url === null ? null : priorities.length === 0 ? (
      gt("No findings")
    ) : (
      <>
        {priorities.map((priority, index) => (
          <span key={priority}>
            {index > 0 ? " · " : null}
            <span className={cn("tabular-nums", TONE[PRIORITY_TONE[priority]])}>
              {review.findings[priority]} {priority}
            </span>
          </span>
        ))}
      </>
    );
  const notes = [
    review?.reviewing ? gt("Reviewing...") : null,
    review?.current === false ? gt("older commit") : null,
  ].filter((note) => note !== null);
  return (
    <StatRow
      icon={icon}
      title={gt("Conductor review")}
      detail={
        loading ? (
          gt("Loading...")
        ) : findings === null && notes.length === 0 ? (
          gt("Not reviewed yet")
        ) : (
          <>
            {findings}
            {findings !== null && notes.length > 0 ? " · " : null}
            {notes.join(" · ")}
          </>
        )
      }
      url={review?.url ?? null}
      onOpen={onOpen}
    />
  );
}

/** PR happy: CI/CD checks, the QA level and Conductor's findings for the current pull request. */
export function ThreadDetailsPrHappy({
  environmentId,
  reference,
  detail,
  onOpen,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: Pick<
    PullRequestDetail,
    "url" | "headSha" | "headBranch" | "isDraft" | "checks" | "mergeability" | "state"
  >;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const gt = useGT();
  // The panel's key order, so the pull request panel and this share one activity read.
  const activityAtom = pullRequestEnvironment.activity({
    environmentId,
    input: pullRequestPanelReference(reference),
  });
  const activity = useEnvironmentQuerySelector(activityAtom, selectEnvironmentQueryData);
  const activityQuery = useEnvironmentQueryRefresh(activityAtom);
  const ledgerQuery = useEnvironmentQuery(
    serverEnvironment.qaLedger({
      environmentId,
      input: {
        projectId: reference.projectId,
        repository: reference.repository,
        number: reference.number,
      },
    }),
  );
  // A draft is checked locally with cd:local before GitHub's CI runs on it.
  const localCiQuery = useEnvironmentQuery(
    detail.isDraft
      ? serverEnvironment.localCiRun({
          environmentId,
          input: {
            headBranch: detail.headBranch,
            ...(detail.headSha === undefined ? {} : { headSha: detail.headSha }),
          },
        })
      : null,
  );
  useLiveRefresh(
    () => {
      if (!localCiQuery.isPending) localCiQuery.refresh();
    },
    {
      enabled: detail.isDraft && detail.state === "open",
      key: `pr-happy-local-ci:${environmentId}:${reference.repository}#${reference.number}`,
      intervalMs: LOCAL_CI_REFRESH_MS,
    },
  );
  useLiveRefresh(
    () => {
      if (!activityQuery.isPending()) activityQuery.refresh();
      if (!ledgerQuery.isPending) ledgerQuery.refresh();
    },
    {
      enabled: detail.state === "open",
      key: `pr-happy:${environmentId}:${reference.host}:${reference.repository}#${reference.number}`,
      intervalMs: ACTIVITY_REFRESH_MS,
    },
  );
  const comments = activity?.comments ?? [];
  const loading = activity === null;
  return (
    <div data-thread-details-pr-happy className="flex flex-col pb-1">
      <div className="px-2.5 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground select-none">
        {gt("PR happy")}
      </div>
      {localCiQuery.data ? (
        <LocalCiRow startedAt={localCiQuery.data.startedAt} />
      ) : (
        <ChecksRow
          checks={summarizeChecks(detail.checks, detail.mergeability === "conflicting")}
          url={`${detail.url}/checks`}
          onOpen={onOpen}
        />
      )}
      <QaRow
        ledger={ledgerQuery.data ?? null}
        loading={ledgerQuery.isPending && ledgerQuery.data === null}
        headSha={detail.headSha}
      />
      <ConductorRow
        review={summarizeConductorReview(comments, detail.headSha)}
        loading={loading}
        onOpen={onOpen}
      />
    </div>
  );
}
