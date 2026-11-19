import { describe, expect, it } from "vite-plus/test";

import { summarizeChecks, summarizeConductorReview, summarizeQa } from "./prHappy.logic";

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

describe("summarizeQa", () => {
  it("reads a QA report's summary line and tested commit", () => {
    expect(
      summarizeQa(
        [
          comment(
            "tester",
            [
              "#### QA results",
              "",
              "**Summary:** 9 passed, 3 failed, 8 blocked, 0 not run.",
              "**Tested:** commit `7f0f51acc071` on https://pr-1.preview.example.",
            ].join("\n"),
          ),
        ],
        HEAD,
      ),
    ).toMatchObject({ passed: 9, failed: 3, open: 8, total: 20, state: "failing", current: true });
  });

  it("uses a retest's overall standing over the rows it reran", () => {
    expect(
      summarizeQa(
        [
          comment(
            "tester",
            [
              "#### QA retest results",
              "",
              "**Overall now:** 50 passed, 0 failed, 2 blocked, 0 not run (all items).",
              "| 2 | Check | ❌ Fail | ✅ Pass | 1 passed in this run |",
            ].join("\n"),
          ),
        ],
        HEAD,
      ),
    ).toMatchObject({ passed: 50, open: 2, total: 52, state: "incomplete", current: null });
  });

  it("takes the totals from the part of a split report that states them", () => {
    const qa = summarizeQa(
      [
        comment(
          "me",
          "## QA results - full report, part 1\n\n**Accepted results: 52 passed; 9 checks out of scope; 0 failed, partial, blocked or not run.**",
        ),
        comment("me", "## QA results - full report, part 2\n\n### 31. A check\n\nOut of scope"),
        bot("## QA: 60 things to test"),
      ],
      HEAD,
    );
    expect(qa).toMatchObject({ passed: 52, failed: 0, open: 0, total: 52, state: "passing" });
    expect(qa?.url).toContain("issuecomment-");
  });

  it("returns nothing before anyone reports QA results", () => {
    expect(summarizeQa([bot("## QA: 52 things to test")], HEAD)).toBeNull();
  });
});
