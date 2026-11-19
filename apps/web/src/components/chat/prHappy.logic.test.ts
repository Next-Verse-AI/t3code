import type { QaLedgerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatRunClock,
  summarizeChecks,
  summarizeConductorReview,
  summarizeQaLedger,
} from "./prHappy.logic";

const HEAD = "7f0f51acc071e32dbc8dae96410184b93036b8f2";
let minute = 0;
const comment = (login: string, body: string) => ({
  author: { login },
  body,
  createdAt: `2026-11-18T12:${String(minute++).padStart(2, "0")}:00Z`,
  url: `https://github.com/o/r/pull/1#issuecomment-${minute}`,
});
const bot = (body: string) => comment("nv-amd", body);
const started = (sha: string) =>
  bot(`Conductor started reviewing https://github.com/o/r/pull/1 at ${sha}: conductor://x`);

describe("summarizeChecks", () => {
  it("counts checks by status the way GitHub's merge box does", () => {
    const checks = [
      ...Array.from({ length: 11 }, () => ({ status: "skipped" as const })),
      { status: "success" as const },
      { status: "success" as const },
    ];
    expect(summarizeChecks(checks, false)).toMatchObject({
      state: "passing",
      counts: { skipped: 11, successful: 2, failing: 0 },
      total: 13,
    });
    expect(summarizeChecks(checks, true).state).toBe("conflicting");
    expect(summarizeChecks([{ status: "cancelled" }, { status: "pending" }], false).state).toBe(
      "failing",
    );
    expect(summarizeChecks([{ status: "action-required" }], false).state).toBe("pending");
    expect(summarizeChecks([], false).state).toBe("none");
  });
});

describe("summarizeConductorReview", () => {
  it("counts only this round's findings, not the rechecked earlier ones", () => {
    const review = summarizeConductorReview(
      [
        comment("me", "/nv review"),
        started("7f0f51acc071"),
        bot(
          [
            "## Findings found",
            "",
            "### [P1] Not verified on the PR environment",
            "### [P2] Bind replacement authority to the request being corrected",
            "### 3. [P2] Numbered findings count too",
            "## Prior findings rechecked",
            "### [P1] An earlier finding, now resolved",
            "## Checks and coverage",
          ].join("\n"),
        ),
      ],
      HEAD,
    );
    expect(review).toMatchObject({
      findings: { P0: 0, P1: 1, P2: 2, P3: 0 },
      total: 3,
      reviewedSha: "7f0f51acc071",
      current: true,
      reviewing: false,
    });
  });

  it("reads a clean review and marks one on an older commit", () => {
    const review = summarizeConductorReview(
      [started("0337ba513681"), bot("## No findings found\n\n## Prior findings rechecked")],
      HEAD,
    );
    expect(review).toMatchObject({ total: 0, current: false, reviewing: false });
  });

  it("shows a started or queued review until it ends", () => {
    const earlier = [started("0337ba513681"), bot("## Findings found\n\n### [P3] Nit")];
    expect(summarizeConductorReview([...earlier, started(HEAD.slice(0, 12))], HEAD)).toMatchObject({
      total: 1,
      reviewing: true,
    });
    expect(
      summarizeConductorReview([bot("Conductor review is queued. It will start soon.")], HEAD),
    ).toMatchObject({ total: 0, reviewing: true, url: null });
    expect(
      summarizeConductorReview(
        [...earlier, started(HEAD.slice(0, 12)), bot("Conductor paused after repeated failures.")],
        HEAD,
      )?.reviewing,
    ).toBe(false);
  });

  it("ignores other people's comments and bot messages that are not results", () => {
    expect(
      summarizeConductorReview(
        [
          comment("someone", "## Findings found\n\n### [P0] Not from the bot"),
          bot("The review on these exact commits is not clean yet, so QA cannot start."),
        ],
        HEAD,
      ),
    ).toBeNull();
  });
});

describe("summarizeQaLedger", () => {
  const counts = (fields: Partial<Record<QaLedgerStatus, number>>) => ({
    not_run: 0,
    waiting: 0,
    blocked: 0,
    fail: 0,
    partial: 0,
    pass: 0,
    out_of_scope: 0,
    ...fields,
  });

  it("leaves out-of-scope checks out of the level", () => {
    expect(summarizeQaLedger(counts({ pass: 49, out_of_scope: 7 }))).toEqual({
      passed: 49,
      total: 49,
      state: "passing",
    });
  });

  it("fails on any failure, shows a run in progress, and is otherwise incomplete", () => {
    expect(summarizeQaLedger(counts({ pass: 32, fail: 11, partial: 1 }))).toMatchObject({
      total: 44,
      state: "failing",
    });
    expect(summarizeQaLedger(counts({ pass: 6, waiting: 2, blocked: 2 })).state).toBe("running");
    expect(summarizeQaLedger(counts({ pass: 6, blocked: 4 })).state).toBe("incomplete");
    expect(summarizeQaLedger(counts({ out_of_scope: 3 })).state).toBe("empty");
  });
});

describe("formatRunClock", () => {
  it("counts minutes and seconds, adding hours past the first", () => {
    expect(formatRunClock(0)).toBe("0:00");
    expect(formatRunClock(247.9)).toBe("4:07");
    expect(formatRunClock(3723)).toBe("1:02:03");
  });
});
