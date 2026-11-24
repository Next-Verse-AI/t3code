import { describe, expect, it } from "vite-plus/test";

import {
  newestDeployment,
  parseDeployment,
  parseEnvironmentComment,
  parseRun,
  readEnvironmentComment,
  runIdOf,
  summarizeDeployment,
  summarizeEnvironmentComment,
} from "./PullRequestDeploymentService.ts";

const deployment = {
  id: 7,
  environment: "pr-environments",
  sha: "7f0f51acc071e32dbc8dae96410184b93036b8f2",
  createdAt: "2026-11-23T15:58:12Z",
};
const LOG = "https://github.com/o/r/actions/runs/1/job/2";
const status = (state: string, at: string, logUrl: string | null = LOG) => ({
  state,
  created_at: at,
  log_url: logUrl,
  environment_url: "",
});

describe("parseDeployment", () => {
  it("reads the newest deployment and drops malformed rows", () => {
    expect(
      parseDeployment(
        JSON.stringify([
          {
            id: 7,
            environment: "pr-environments",
            sha: deployment.sha,
            created_at: "2026-11-23T15:58:12Z",
          },
        ]),
      ),
    ).toEqual(deployment);
    expect(parseDeployment("[]")).toBeNull();
    expect(parseDeployment('[{"id":7}]')).toBeNull();
    expect(parseDeployment("not json")).toBeNull();
  });
});

describe("summarizeDeployment", () => {
  it("is running until a final status arrives", () => {
    expect(summarizeDeployment(deployment, "[]")).toMatchObject({
      state: "running",
      finishedAt: null,
      url: null,
    });
    const running = JSON.stringify([
      status("in_progress", "2026-11-23T15:58:26Z"),
      status("queued", "2026-11-23T15:58:18Z"),
    ]);
    expect(summarizeDeployment(deployment, running)).toMatchObject({
      state: "running",
      finishedAt: null,
      url: LOG,
    });
  });

  it("finishes at its success or failure", () => {
    const done = JSON.stringify([
      status("success", "2026-11-23T15:58:55Z"),
      status("in_progress", "2026-11-23T15:58:26Z"),
    ]);
    expect(summarizeDeployment(deployment, done)).toMatchObject({
      state: "success",
      finishedAt: "2026-11-23T15:58:55Z",
    });
    const failed = JSON.stringify([status("error", "2026-11-23T16:01:00Z")]);
    expect(summarizeDeployment(deployment, failed)).toMatchObject({
      state: "failure",
      finishedAt: "2026-11-23T16:01:00Z",
    });
  });

  it("keeps the original finish time once a newer deployment replaces it", () => {
    const replaced = JSON.stringify([
      status("inactive", "2026-11-23T17:00:00Z", null),
      status("success", "2026-11-23T15:58:55Z"),
    ]);
    expect(summarizeDeployment(deployment, replaced)).toMatchObject({
      state: "inactive",
      finishedAt: "2026-11-23T15:58:55Z",
      url: LOG,
    });
  });
});

const MARKER = "<!-- nv-pr-environment -->";
const RUN = "https://github.com/o/r/actions/runs/45378200165";
const LIVE = `${MARKER}\n✅ **PR environment: Live** at https://pr-1001.preview.nextverse.io, running \`1680cd3\`.\n\nThe database starts empty.\n\n[AWS Services](https://aws.example) · [Build log](${RUN})`;
const BUILDING = `${MARKER}\n⏳ **PR environment: building \`1680cd3\`.** The previous commit keeps serving. [Build log](${RUN}) · [AWS Services](https://aws.example)`;
const STARTING = `${MARKER}\n🚀 **PR environment: Starting services for \`1680cd3\`** (watch them come up in AWS). [AWS Services](https://aws.example) · [Build log](${RUN})`;
const FAILED = `${MARKER}\n❌ **PR environment: Failed** at *api image* for \`1680cd3\`. [Build log](${RUN})`;
const IDLE = `${MARKER}\n⚠️ **PR environment: idle.** No push deployed since \`1680cd3\` in 6 days. [Build log](${RUN})`;
const REMOVED = `${MARKER}\nPR environment removed: the PR is closed (reopen it to get a new, empty one).`;

const line = (body: string, at: string, user = "github-actions[bot]") =>
  JSON.stringify({ body, user, updated_at: at });

describe("parseEnvironmentComment", () => {
  it("takes the workflow's newest status comment and ignores anyone else's", () => {
    const text = [
      line(BUILDING, "2026-11-24T11:20:00Z"),
      line(`${MARKER} quoted by a person`, "2026-11-24T11:40:00Z", "someone"),
      line(LIVE, "2026-11-24T11:37:11Z"),
      "",
      "not json",
    ].join("\n");
    expect(parseEnvironmentComment(text)).toEqual({
      body: LIVE,
      updatedAt: "2026-11-24T11:37:11Z",
    });
    expect(parseEnvironmentComment(line("no marker", "2026-11-24T11:00:00Z"))).toBeNull();
    expect(parseEnvironmentComment("")).toBeNull();
  });
});

describe("readEnvironmentComment", () => {
  it("reads each state, the commit and the build log", () => {
    expect(readEnvironmentComment(LIVE)).toEqual({ state: "success", sha: "1680cd3", runUrl: RUN });
    expect(readEnvironmentComment(BUILDING)?.state).toBe("running");
    expect(readEnvironmentComment(STARTING)?.state).toBe("running");
    expect(readEnvironmentComment(FAILED)?.state).toBe("failure");
    expect(readEnvironmentComment(IDLE)?.state).toBe("success");
    expect(readEnvironmentComment(REMOVED)).toBeNull();
    expect(runIdOf(RUN)).toBe("45378200165");
    expect(runIdOf(null)).toBeNull();
  });
});

describe("summarizeEnvironmentComment", () => {
  const run = parseRun(
    JSON.stringify({
      run_started_at: "2026-11-24T11:19:30Z",
      status: "completed",
      conclusion: "success",
    }),
  );

  it("starts with its run and finishes when the comment last changed", () => {
    expect(
      summarizeEnvironmentComment(1001, { body: LIVE, updatedAt: "2026-11-24T11:37:11Z" }, run),
    ).toEqual({
      environment: "pr-1001",
      sha: "1680cd3",
      state: "success",
      createdAt: "2026-11-24T11:19:30Z",
      finishedAt: "2026-11-24T11:37:11Z",
      url: RUN,
    });
  });

  it("is running while the comment says so, and failed if its run ended badly first", () => {
    const comment = { body: STARTING, updatedAt: "2026-11-24T11:30:00Z" };
    const running = parseRun(
      JSON.stringify({
        run_started_at: "2026-11-24T11:19:30Z",
        status: "in_progress",
        conclusion: null,
      }),
    );
    expect(summarizeEnvironmentComment(1001, comment, running)).toMatchObject({
      state: "running",
      finishedAt: null,
    });
    const cancelled = parseRun(
      JSON.stringify({
        run_started_at: "2026-11-24T11:19:30Z",
        status: "completed",
        conclusion: "cancelled",
      }),
    );
    expect(summarizeEnvironmentComment(1001, comment, cancelled)?.state).toBe("failure");
    // Without its run, the comment's own time stands in for the start.
    expect(summarizeEnvironmentComment(1001, comment, null)?.createdAt).toBe(
      "2026-11-24T11:30:00Z",
    );
    expect(
      summarizeEnvironmentComment(1001, { body: REMOVED, updatedAt: "2026-11-24T11:30:00Z" }, null),
    ).toBeNull();
  });
});

describe("newestDeployment", () => {
  it("shows the deploy that started last", () => {
    const branch = summarizeDeployment(deployment, "[]");
    const comment = summarizeEnvironmentComment(
      1001,
      { body: LIVE, updatedAt: "2026-11-24T11:37:11Z" },
      null,
    );
    expect(newestDeployment(branch, comment)).toBe(comment);
    expect(newestDeployment(branch, null)).toBe(branch);
    expect(newestDeployment(null, null)).toBeNull();
  });
});
