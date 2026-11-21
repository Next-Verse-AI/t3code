import { describe, expect, it } from "vite-plus/test";

import { parseBehindBy, parseStackLinks, pickParent } from "./PullRequestBaseStatusService.ts";

const row = (number: number, state: string, baseRefName = "development") => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  isDraft: false,
  baseRefName,
});

describe("parseStackLinks", () => {
  it("reads gh's pull request rows and drops malformed ones", () => {
    const text = JSON.stringify([
      row(765, "OPEN"),
      { ...row(901, "MERGED"), isDraft: true },
      { number: 3, state: "OPEN" },
      row(4, "WEIRD"),
    ]);
    expect(parseStackLinks(text)).toEqual([
      {
        number: 765,
        url: "https://github.com/o/r/pull/765",
        state: "open",
        isDraft: false,
        baseBranch: "development",
      },
      {
        number: 901,
        url: "https://github.com/o/r/pull/901",
        state: "merged",
        isDraft: true,
        baseBranch: "development",
      },
    ]);
    expect(parseStackLinks("not json")).toEqual([]);
  });
});

describe("pickParent", () => {
  it("prefers the open pull request, else the newest", () => {
    const links = parseStackLinks(
      JSON.stringify([row(10, "CLOSED"), row(12, "MERGED"), row(11, "OPEN")]),
    );
    expect(pickParent(links)?.number).toBe(11);
    expect(pickParent(links.filter((link) => link.state !== "open"))?.number).toBe(12);
    expect(pickParent([])).toBeNull();
  });
});

describe("parseBehindBy", () => {
  it("reads the compare count", () => {
    expect(parseBehindBy('{"behind_by":285}')).toBe(285);
    expect(parseBehindBy('{"behind_by":null}')).toBeNull();
    expect(parseBehindBy("")).toBeNull();
  });
});
