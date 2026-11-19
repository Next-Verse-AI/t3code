import { describe, expect, it } from "vite-plus/test";

import { newestQaLedger, readQaLedger } from "./QaLedgerService.ts";

const target = { repository: "Next-Verse-AI/nv-fabric", number: 844 };
const ledger = (fields: Record<string, unknown>, modifiedAt = "2026-11-12T01:00:00.000Z") => ({
  text: JSON.stringify({
    pr_url: "https://github.com/Next-Verse-AI/nv-fabric/pull/844",
    head_sha: "7f0f51ac",
    run_id: "20261112T011800Z-d42947da",
    items: [],
    ...fields,
  }),
  modifiedAt,
});

describe("readQaLedger", () => {
  it("counts every verdict in a run of this pull request", () => {
    const statuses = ["pass", "pass", "fail", "partial", "blocked", "not_run", "out_of_scope"];
    expect(
      readQaLedger(
        ledger({ items: statuses.map((status, id) => ({ id: `${id}`, status })) }),
        target,
      ),
    ).toEqual({
      runId: "20261112T011800Z-d42947da",
      headSha: "7f0f51ac",
      updatedAt: "2026-11-12T01:00:00.000Z",
      counts: {
        not_run: 1,
        waiting: 0,
        blocked: 1,
        fail: 1,
        partial: 1,
        pass: 2,
        out_of_scope: 1,
      },
    });
  });

  it("skips ledgers for other pull requests and files that are not ledgers", () => {
    expect(
      readQaLedger(
        ledger({ pr_url: "https://github.com/Next-Verse-AI/nv-fabric/pull/8440" }),
        target,
      ),
    ).toBeNull();
    expect(
      readQaLedger(ledger({ pr_url: "https://github.com/other/nv-fabric/pull/844" }), target),
    ).toBeNull();
    expect(readQaLedger(ledger({ items: "none" }), target)).toBeNull();
    expect(readQaLedger({ text: "{", modifiedAt: "2026-11-12T01:00:00.000Z" }, target)).toBeNull();
  });

  it("matches the repository whatever its case and keeps unknown verdicts out of the counts", () => {
    expect(
      readQaLedger(
        ledger({
          pr_url: "https://github.com/next-verse-ai/NV-FABRIC/pull/844#issuecomment-1",
          items: [{ status: "pass" }, { status: "skipped" }, null],
        }),
        target,
      )?.counts.pass,
    ).toBe(1);
  });
});

describe("newestQaLedger", () => {
  it("picks the most recently written run of this pull request", () => {
    const newest = newestQaLedger(
      [
        ledger({ run_id: "old", items: [{ status: "fail" }] }, "2026-11-09T12:00:00.000Z"),
        ledger(
          { run_id: "other", pr_url: "https://github.com/Next-Verse-AI/nv-fabric/pull/1" },
          "2026-11-19T00:00:00.000Z",
        ),
        ledger({ run_id: "new", items: [{ status: "pass" }] }, "2026-11-12T01:00:00.000Z"),
      ],
      target,
    );
    expect(newest?.runId).toBe("new");
    expect(newestQaLedger([], target)).toBeNull();
  });
});
