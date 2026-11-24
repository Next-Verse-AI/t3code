import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDeployment,
  PullRequestDetail,
  PullRequestRef,
  QaLedgerStatus,
  QaLedgerSummary,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  ArrowUpRightIcon,
  GitBranchIcon,
  LayersIcon,
  RocketIcon,
  ScanSearchIcon,
} from "lucide-react";
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";
import {
  type BaseSummary,
  type ChecksSummary,
  type ConductorReview,
  type FindingPriority,
  formatRunClock,
  isSameCommit,
  summarizeBase,
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

type OpenLink = (event: ReactMouseEvent<HTMLElement>, url: string) => void;

/** What one PR happy item shows at rest, and the details its hover card adds. */
interface Stat {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: ReactNode;
  readonly valueTone: Tone | null;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly url: string | null;
}

/** Counts up from `since` (ms on the environment's clock), re-rendering only itself each second. */
function RunClock({ since, until = null }: { since: number; until?: number | null }) {
  const now = useNowSecond();
  return <span className="tabular-nums">{formatRunClock(((until ?? now) - since) / 1000)}</span>;
}

// The base line matches the panel's other rows; tiles are compact two-line cells.
const STAT_CARD_LAYOUT = {
  line: `flex h-8 items-center text-[13px] ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`,
  tile: `flex items-center py-1.5 ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`,
} as const;

/** Hover or click shows the item's details; the card links out when there is somewhere to go. */
function StatCard({
  stat,
  onOpen,
  children,
  layout,
}: {
  stat: Stat;
  onOpen: OpenLink;
  children: ReactNode;
  layout: keyof typeof STAT_CARD_LAYOUT;
}) {
  const gt = useGT();
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        closeDelay={100}
        render={<button type="button" />}
        className={cn(
          "min-w-0 rounded-lg text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
          "hover:bg-black/[0.035] data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
          STAT_CARD_LAYOUT[layout],
        )}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup side="left" align="start" sideOffset={8} padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          <div className="font-medium text-foreground">{stat.title}</div>
          <div className="text-muted-foreground">{stat.detail}</div>
          {stat.url === null ? null : (
            <button
              type="button"
              className="mt-1 inline-flex w-fit items-center gap-1 rounded-md text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              onClick={(event) => onOpen(event, stat.url as string)}
              onAuxClick={(event) => onOpen(event, stat.url as string)}
            >
              {gt("Open on GitHub")}
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A compact tile in the status strip: icon, a small label, and its value. */
function StatTile({ stat, onOpen }: { stat: Stat; onOpen: OpenLink }) {
  return (
    <StatCard stat={stat} onOpen={onOpen} layout="tile">
      <span className="inline-flex size-4 shrink-0 items-center justify-center">{stat.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-muted-foreground">{stat.label}</span>
        <span
          className={cn(
            "block truncate text-xs font-medium",
            stat.valueTone === null ? "text-foreground/80" : TONE[stat.valueTone],
          )}
        >
          {stat.value}
        </span>
      </span>
    </StatCard>
  );
}

function checksStat(gt: ReturnType<typeof useGT>, checks: ChecksSummary, url: string): Stat {
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
  const value = {
    conflicting: gt("Conflict"),
    failing: gt("{count} failed", { count: counts.failing }),
    pending: gt("{count} running", { count: counts.pending + counts.actionRequired }),
    passing: gt("Passed"),
    none: "-",
  }[checks.state];
  const valueTone: Tone = {
    conflicting: "failure",
    failing: "failure",
    pending: "pending",
    passing: "success",
    none: "muted",
  }[checks.state] as Tone;
  return {
    icon: (
      <Ring
        arcs={[
          { share: share(counts.successful), className: TONE.success },
          { share: share(counts.failing), className: TONE.failure },
          { share: share(counts.pending + counts.actionRequired), className: TONE.pending },
          { share: share(counts.skipped + counts.neutral), className: TONE.muted },
        ]}
      />
    ),
    label: gt("CI/CD"),
    value,
    valueTone,
    title,
    detail:
      parts.length === 0
        ? gt("CI/CD")
        : gt("{list} {count, plural, one {check} other {checks}}", {
            list: parts.join(", "),
            count: total,
          }),
    url,
  };
}

function localCiStat(gt: ReturnType<typeof useGT>, startedAt: number): Stat {
  return {
    icon: (
      <span className={cn("inline-flex shrink-0", TONE.pending)}>
        <Spinner size="md" />
      </span>
    ),
    label: gt("CI/CD"),
    value: <RunClock since={startedAt} />,
    valueTone: "pending",
    title: gt("Local CI/CD running"),
    detail: <RunClock since={startedAt} />,
    url: null,
  };
}

function deploymentStat(
  gt: ReturnType<typeof useGT>,
  deployment: PullRequestDeployment,
  headSha: string | undefined,
): Stat {
  const { environment, state } = deployment;
  const created = Date.parse(deployment.createdAt);
  const finished = deployment.finishedAt === null ? null : Date.parse(deployment.finishedAt);
  const clock = Number.isNaN(created) ? (
    "-"
  ) : (
    <RunClock
      since={created}
      until={finished !== null && !Number.isNaN(finished) ? finished : null}
    />
  );
  const tone: Tone =
    state === "running"
      ? "pending"
      : state === "success"
        ? "success"
        : state === "failure"
          ? "failure"
          : "muted";
  const notes = [
    state === "inactive" ? gt("replaced by a newer deployment") : null,
    isSameCommit(deployment.sha, headSha) === false ? gt("older commit") : null,
  ].filter((note) => note !== null);
  return {
    icon:
      state === "running" ? (
        <span className={cn("inline-flex shrink-0", TONE.pending)}>
          <Spinner size="md" />
        </span>
      ) : (
        <RocketIcon aria-hidden className={cn("size-4 shrink-0", TONE[tone])} />
      ),
    label: gt("Deploy"),
    value: clock,
    valueTone: tone,
    title: {
      running: gt("Deploying to {environment}", { environment }),
      success: gt("Deployed to {environment}", { environment }),
      failure: gt("Deployment to {environment} failed", { environment }),
      inactive: gt("Deployed to {environment}", { environment }),
    }[state],
    detail: (
      <>
        {state === "running" ? gt("Running for") : gt("Took")} {clock}
        {notes.length > 0 ? ` · ${notes.join(" · ")}` : null}
      </>
    ),
    url: deployment.url,
  };
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

function qaStat(
  gt: ReturnType<typeof useGT>,
  ledger: QaLedgerSummary | null,
  loading: boolean,
  headSha: string | undefined,
): Stat {
  if (ledger === null) {
    return {
      icon: loading ? <Spinner size="md" tone="muted" /> : <Ring arcs={[]} />,
      label: gt("QA"),
      value: "-",
      valueTone: "muted",
      title: gt("QA"),
      detail: loading ? gt("Loading...") : gt("No QA results yet"),
      url: null,
    };
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
  const level =
    qa.state === "passing"
      ? gt("passing", { $context: "QA level: every check passed" })
      : qa.state === "failing"
        ? gt("failing", { $context: "QA level: some checks failed" })
        : qa.state === "running"
          ? gt("running", { $context: "QA level: checks are being tested now" })
          : gt("incomplete", { $context: "QA level: some checks not run yet" });
  return {
    icon: (
      <Ring
        arcs={QA_RING_ORDER.map((status) => ({
          share: qa.total === 0 ? 0 : ledger.counts[status] / qa.total,
          className: QA_STATUS_TONE[status],
        }))}
      />
    ),
    label: gt("QA"),
    value: (
      <span className={cn("tabular-nums", levelTone)}>
        {qa.passed}/{qa.total}
      </span>
    ),
    valueTone: null,
    title: (
      <>
        {gt("QA")}{" "}
        <span className={cn("tabular-nums", levelTone)}>
          {qa.passed}/{qa.total}
        </span>{" "}
        {level}
      </>
    ),
    detail: (
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
    ),
    url: null,
  };
}

const PRIORITY_TONE: Record<FindingPriority, Tone> = {
  P0: "failure",
  P1: "failure",
  P2: "pending",
  P3: "muted",
};

function reviewStat(
  gt: ReturnType<typeof useGT>,
  review: ConductorReview | null,
  loading: boolean,
): Stat {
  const priorities = (["P0", "P1", "P2", "P3"] as const).filter(
    (priority) => (review?.findings[priority] ?? 0) > 0,
  );
  const tone: Tone =
    review === null || !review.hasResult
      ? "muted"
      : review.findings.P0 + review.findings.P1 > 0
        ? "failure"
        : review.total > 0
          ? "pending"
          : "success";
  const findings =
    review === null || !review.hasResult
      ? null
      : priorities.length === 0
        ? gt("No findings")
        : priorities.map((priority) => (
            <span key={priority} className={cn("tabular-nums", TONE[PRIORITY_TONE[priority]])}>
              {review.findings[priority]} {priority}{" "}
            </span>
          ));
  const notes = [
    review?.reviewing ? gt("Reviewing...") : null,
    review?.current === false ? gt("older commit") : null,
  ].filter((note) => note !== null);
  return {
    icon:
      loading || review?.reviewing ? (
        <Spinner size="md" tone="muted" />
      ) : (
        <ScanSearchIcon aria-hidden className={cn("size-4 shrink-0", TONE[tone])} />
      ),
    label: gt("Review"),
    value: loading
      ? "-"
      : findings === null
        ? "-"
        : priorities.length === 0
          ? gt("Clean")
          : findings,
    valueTone: priorities.length === 0 ? tone : null,
    title: gt("Conductor review"),
    detail: loading ? (
      gt("Loading...")
    ) : findings === null && notes.length === 0 ? (
      gt("Not reviewed yet")
    ) : (
      <>
        {findings}
        {findings !== null && notes.length > 0 ? " · " : null}
        {notes.join(" · ")}
      </>
    ),
    url: review?.url ?? null,
  };
}

/**
 * The base on one line: the parent PR and how far behind it when stacked, else the base branch.
 * Hovering or clicking shows the comparison, the parent's state and what is stacked on this PR.
 */
function BaseLine({
  base,
  loading,
  baseBranch,
  compareUrl,
  onOpen,
}: {
  base: BaseSummary | null;
  loading: boolean;
  baseBranch: string;
  compareUrl: string;
  onOpen: OpenLink;
}) {
  const gt = useGT();
  const parent = base?.parent ?? null;
  const target = parent ? `#${parent.number}` : baseBranch;
  // A stacked PR's parent that merged or closed needs attention before the commit count does.
  const tone: Tone =
    base === null || base.state === "unknown"
      ? "muted"
      : base.stack === "closed"
        ? "failure"
        : base.stack === "merged" || base.state === "behind"
          ? "pending"
          : "success";
  const behind =
    base === null || loading
      ? null
      : base.state === "current"
        ? gt("up to date")
        : base.state === "behind"
          ? gt("{formatted} behind", { formatted: (base.behindBy ?? 0).toLocaleString() })
          : null;
  const title =
    base === null
      ? gt("Base")
      : base.state === "current"
        ? gt("Up to date with {target}", { target })
        : base.state === "behind"
          ? gt(
              "{count, plural, one {{formatted} commit behind {target}} other {{formatted} commits behind {target}}}",
              {
                count: base.behindBy ?? 0,
                formatted: (base.behindBy ?? 0).toLocaleString(),
                target,
              },
            )
          : gt("Can't compare with {target}", { target });
  const parentState =
    parent === null || base === null
      ? null
      : base.stack === "open"
        ? parent.isDraft
          ? gt("Draft", { $context: "parent pull request status" })
          : gt("Open", { $context: "parent pull request status" })
        : base.stack === "merged"
          ? gt("Merged - move this PR to {baseBranch}", { baseBranch: parent.baseBranch })
          : gt("Closed without merging");
  const detail = [
    parent ? gt("Stacked on #{number}", { number: parent.number }) : gt("Base branch"),
    parent ? baseBranch : null,
    parentState,
    base !== null && base.children.length > 0
      ? gt("{list} stacked on this", { list: stackedOnLabel(base.children) })
      : null,
  ].filter((note) => note !== null);
  const Icon = parent ? LayersIcon : GitBranchIcon;
  const stat: Stat = {
    icon: null,
    label: gt("Base"),
    value: null,
    valueTone: null,
    title,
    detail: detail.join(" · "),
    url: base?.state === "behind" ? compareUrl : (parent?.url ?? null),
  };
  return (
    <StatCard stat={stat} onOpen={onOpen} layout="line">
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {loading ? (
          <Spinner size="md" tone="muted" />
        ) : (
          <Icon aria-hidden className={cn("size-4 shrink-0", TONE[tone])} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
        {target}
        {behind === null ? null : (
          <span
            className={cn(
              "font-normal",
              base?.state === "behind" ? TONE.pending : "text-muted-foreground",
            )}
          >
            {" · "}
            {behind}
          </span>
        )}
      </span>
    </StatCard>
  );
}

function stackedOnLabel(children: BaseSummary["children"]) {
  return children.map((child) => `#${child.number}`).join(", ");
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
    | "url"
    | "headSha"
    | "headBranch"
    | "baseBranch"
    | "isDraft"
    | "checks"
    | "mergeability"
    | "state"
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
  const baseQuery = useEnvironmentQuery(
    detail.headSha === undefined
      ? null
      : serverEnvironment.pullRequestBaseStatus({
          environmentId,
          input: {
            repository: reference.repository,
            headBranch: detail.headBranch,
            headSha: detail.headSha,
            baseBranch: detail.baseBranch,
          },
        }),
  );
  const deploymentQuery = useEnvironmentQuery(
    serverEnvironment.pullRequestDeployment({
      environmentId,
      input: { repository: reference.repository, headBranch: detail.headBranch },
    }),
  );
  useLiveRefresh(
    () => {
      if (!deploymentQuery.isPending) deploymentQuery.refresh();
    },
    {
      enabled: deploymentQuery.data?.state === "running",
      key: `pr-happy-deployment:${environmentId}:${reference.repository}#${reference.number}`,
      intervalMs: LOCAL_CI_REFRESH_MS,
    },
  );
  useLiveRefresh(
    () => {
      if (!activityQuery.isPending()) activityQuery.refresh();
      if (!deploymentQuery.isPending) deploymentQuery.refresh();
      if (!ledgerQuery.isPending) ledgerQuery.refresh();
      if (!baseQuery.isPending) baseQuery.refresh();
    },
    {
      enabled: detail.state === "open",
      key: `pr-happy:${environmentId}:${reference.host}:${reference.repository}#${reference.number}`,
      intervalMs: ACTIVITY_REFRESH_MS,
    },
  );
  const comments = activity?.comments ?? [];
  const loading = activity === null;
  const base = baseQuery.data ? summarizeBase(baseQuery.data) : null;
  const repositoryUrl = detail.url.replace(/\/pull\/\d+\/?$/, "");
  const stats = [
    localCiQuery.data
      ? localCiStat(gt, localCiQuery.data.startedAt)
      : checksStat(
          gt,
          summarizeChecks(detail.checks, detail.mergeability === "conflicting"),
          `${detail.url}/checks`,
        ),
    qaStat(
      gt,
      ledgerQuery.data ?? null,
      ledgerQuery.isPending && ledgerQuery.data === null,
      detail.headSha,
    ),
    reviewStat(gt, summarizeConductorReview(comments, detail.headSha), loading),
    ...(deploymentQuery.data ? [deploymentStat(gt, deploymentQuery.data, detail.headSha)] : []),
  ];
  return (
    <div data-thread-details-pr-happy className="flex flex-col pb-1">
      <div className="px-2.5 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground select-none">
        {gt("PR happy")}
      </div>
      <BaseLine
        base={base}
        loading={baseQuery.isPending && baseQuery.data === null}
        baseBranch={detail.baseBranch}
        compareUrl={`${repositoryUrl}/compare/${detail.headBranch}...${detail.baseBranch}`}
        onOpen={onOpen}
      />
      <div className={cn("grid gap-0.5", stats.length === 4 ? "grid-cols-2" : "grid-cols-3")}>
        {stats.map((stat, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- the tiles are positional and never reorder
          <StatTile key={index} stat={stat} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
