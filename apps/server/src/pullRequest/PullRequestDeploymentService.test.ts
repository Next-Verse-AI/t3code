import { describe, expect, it } from "vite-plus/test";

import { parseDeployment, summarizeDeployment } from "./PullRequestDeploymentService.ts";

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
