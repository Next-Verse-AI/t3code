import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const SHOTS = (import.meta.env as Record<string, string | undefined>).VITE_PR_HAPPY_SHOTS;
const HEAD = "7f0f51acc071e32dbc8dae96410184b93036b8f2";

const data = vi.hoisted(() => ({
  base: {
    protectedBase: false,
    behindBy: 2,
    parent: {
      number: 995,
      url: "https://github.com/o/r/pull/995",
      state: "open",
      isDraft: true,
      baseBranch: "development",
    },
    children: [],
  } as unknown,
  deployment: null as unknown,
}));

vi.mock(import("~/state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  serverEnvironment: {
    qaLedger: () => ({ kind: "qa" }),
    localCiRun: () => ({ kind: "local-ci" }),
    pullRequestBaseStatus: () => ({ kind: "base" }),
    pullRequestDeployment: () => ({ kind: "deployment" }),
  } as never,
}));
vi.mock(import("~/state/pullRequests"), async (importOriginal) => ({
  ...(await importOriginal()),
  pullRequestEnvironment: { activity: () => ({ kind: "activity" }) } as never,
}));
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(
      AsyncResult.success({
        comments: [
          {
            author: { login: "nv-amd" },
            body: `Conductor started reviewing this pull request at ${HEAD.slice(0, 7)}.`,
            url: "https://github.com/o/r/pull/1001#c1",
          },
          {
            author: { login: "nv-amd" },
            body: "## Findings found\n\n- [P2] One\n- [P2] Two",
            url: "https://github.com/o/r/pull/1001#c2",
          },
        ],
      }),
    )) as never,
  useEnvironmentQueryRefresh: () => ({ refresh: vi.fn(), isPending: () => false }),
  useEnvironmentQuery: ((atom: { kind: string } | null) => ({
    data: atom?.kind === "base" ? data.base : atom?.kind === "deployment" ? data.deployment : null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

import "~/index.css";

import { render } from "../../../test/render";
import { ThreadDetailsPrHappy } from "./ThreadDetailsPrHappy";

const reference = {
  host: "github.com",
  repository: "o/r",
  number: 1001,
  projectId: ProjectId.make("project"),
} as unknown as PullRequestRef;

const detail = {
  url: "https://github.com/o/r/pull/1001",
  headSha: HEAD,
  headBranch: "t3/web-implementation-stack-966",
  baseBranch: "yash/nex-2159-home",
  isDraft: false,
  state: "open" as const,
  mergeability: "mergeable" as const,
  checks: [
    { status: "success" as const },
    ...Array.from({ length: 11 }, () => ({ status: "skipped" as const })),
  ],
};

async function setup() {
  const container = document.createElement("div");
  container.style.width = "300px";
  container.style.padding = "8px";
  document.documentElement.classList.add("dark");
  document.body.className = "bg-background text-foreground";
  document.body.append(container);
  const screen = await render(
    <ThreadDetailsPrHappy
      environmentId={EnvironmentId.make("environment")}
      reference={reference}
      detail={detail as never}
      onOpen={vi.fn()}
    />,
    { container, router: false },
  );
  return screen;
}

it("puts a stacked PR's parent and lag on one line, and the statuses in one row", async () => {
  await using screen = await setup();
  const text = screen.container.textContent ?? "";
  expect(text).toContain("#995 · 2 behind");
  expect(text).not.toContain("Stacked on #995");
  expect(text).toContain("CI/CD");
  expect(text).toContain("Passed");
  expect(text).toContain("QA");
  expect(text).toContain("Review");
  expect(text).not.toContain("Deploy");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/rest.png` });
  }
});

it("shows the details on hover", async () => {
  await using screen = await setup();
  const line = [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("#995"),
  )!;
  await userEvent.hover(line);
  await expect.element(page.getByText("2 commits behind #995")).toBeVisible();
  await expect
    .element(page.getByText("Stacked on #995 · yash/nex-2159-home · Draft"))
    .toBeVisible();
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/hover.png` });
  }
});

it("adds a Deploy tile when the branch has a deployment", async () => {
  data.deployment = {
    environment: "pr-environments",
    sha: HEAD,
    state: "success",
    createdAt: "2026-11-23T15:58:12Z",
    finishedAt: "2026-11-23T15:58:55Z",
    url: "https://github.com/o/r/actions/runs/1",
  };
  await using screen = await setup();
  expect(screen.container.textContent).toContain("Deploy0:43");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/deploy.png` });
  }
  data.deployment = null;
});
