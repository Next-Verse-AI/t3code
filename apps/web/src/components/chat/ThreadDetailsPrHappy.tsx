import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ScanSearchIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQueryRefresh, useEnvironmentQuerySelector } from "~/state/query";

import { pullRequestPanelReference } from "../pullRequest/usePullRequestDetail";
import { Spinner } from "../ui/spinner";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_STATIC_ROW_CLASS } from "./threadDetailsPanelStyles";
import {
  type ChecksSummary,
  type ConductorReview,
  type FindingPriority,
  type QaLevel,
  summarizeChecks,
  summarizeConductorReview,
  summarizeQa,
} from "./prHappy.logic";

const ACTIVITY_REFRESH_MS = 2 * 60_000;
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TONE = {
  success: "text-emerald-600 dark:text-emerald-400",
  failure: "text-destructive",
  pending: "text-amber-600 dark:text-amber-400",
  muted: "text-muted-foreground/60",
} as const;
type Tone = keyof typeof TONE;

/** Arcs drawn clockwise from the top, each a share of the full circle. */
function Ring({ arcs }: { arcs: ReadonlyArray<{ readonly share: number; readonly tone: Tone }> }) {
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
            className={cn("stroke-current", TONE[arc.tone])}
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
            { share: share(counts.successful), tone: "success" },
            { share: share(counts.failing), tone: "failure" },
            { share: share(counts.pending + counts.actionRequired), tone: "pending" },
            { share: share(counts.skipped + counts.neutral), tone: "muted" },
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

function QaRow({
  qa,
  loading,
  onOpen,
}: {
  qa: QaLevel | null;
  loading: boolean;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const gt = useGT();
  if (qa === null) {
    return (
      <StatRow
        icon={loading ? <Spinner size="md" tone="muted" /> : <Ring arcs={[]} />}
        title={gt("QA")}
        detail={loading ? gt("Loading...") : gt("No QA results yet")}
        url={null}
        onOpen={onOpen}
      />
    );
  }
  const tone: Tone =
    qa.state === "passing" ? "success" : qa.state === "failing" ? "failure" : "pending";
  const details = [
    qa.failed > 0 ? gt("{count} failed", { count: qa.failed }) : null,
    qa.open > 0 ? gt("{count} blocked or not run", { count: qa.open }) : null,
    qa.current === false ? gt("tested an older commit") : null,
  ].filter((part) => part !== null);
  return (
    <StatRow
      icon={<Ring arcs={[{ share: qa.total === 0 ? 0 : qa.passed / qa.total, tone }]} />}
      title={
        <>
          {gt("QA")}{" "}
          <span className={cn("tabular-nums", TONE[tone])}>
            {qa.passed}/{qa.total}
          </span>{" "}
          {qa.state === "passing"
            ? gt("passing", { $context: "QA level: every check passed" })
            : qa.state === "failing"
              ? gt("failing", { $context: "QA level: some checks failed" })
              : gt("incomplete", { $context: "QA level: some checks not run yet" })}
        </>
      }
      detail={details.length === 0 ? gt("All checks passed") : details.join(" · ")}
      url={qa.url}
      onOpen={onOpen}
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
  detail: Pick<PullRequestDetail, "url" | "headSha" | "checks" | "mergeability" | "state">;
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
  useLiveRefresh(
    () => {
      if (!activityQuery.isPending()) activityQuery.refresh();
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
      <ChecksRow
        checks={summarizeChecks(detail.checks, detail.mergeability === "conflicting")}
        url={`${detail.url}/checks`}
        onOpen={onOpen}
      />
      <QaRow qa={summarizeQa(comments, detail.headSha)} loading={loading} onOpen={onOpen} />
      <ConductorRow
        review={summarizeConductorReview(comments, detail.headSha)}
        loading={loading}
        onOpen={onOpen}
      />
    </div>
  );
}
