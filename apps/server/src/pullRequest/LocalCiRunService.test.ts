import { describe, expect, it } from "vite-plus/test";

import { findCdLocalProcesses, parseElapsedSeconds, parseHead } from "./LocalCiRunService.ts";

describe("parseElapsedSeconds", () => {
  it("reads every ps etime form", () => {
    expect(parseElapsedSeconds("04:07")).toBe(247);
    expect(parseElapsedSeconds("1:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-01:00:00")).toBe(176_400);
    expect(parseElapsedSeconds("soon")).toBeNull();
  });
});

describe("findCdLocalProcesses", () => {
  it("finds cd:local runs, oldest first, and skips the teardown and lookalikes", () => {
    const listing = [
      "  101      04:07 node /opt/pnpm/bin/pnpm run cd:local",
      "  102      10:00 pnpm cd:local",
      "  103      00:05 pnpm run cd:local:down",
      "  104      00:09 grep cd:local",
      "  105      00:02 /usr/local/bin/npm run cd:local -- --fast",
    ].join("\n");
    expect(findCdLocalProcesses(listing)).toEqual([
      { pid: 102, elapsedSeconds: 600 },
      { pid: 101, elapsedSeconds: 247 },
      { pid: 105, elapsedSeconds: 2 },
    ]);
  });
});

describe("parseHead", () => {
  it("reads a branch or a detached commit", () => {
    expect(parseHead("ref: refs/heads/abdullah/nex-1884-chat-voice\n")).toEqual({
      branch: "abdullah/nex-1884-chat-voice",
      sha: null,
    });
    expect(parseHead("7F0F51ACC071E32DBC8DAE96410184B93036B8F2\n")).toEqual({
      branch: null,
      sha: "7f0f51acc071e32dbc8dae96410184b93036b8f2",
    });
  });
});
