import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0", quit: () => undefined } }));
vi.mock("electron-updater", () => ({
  autoUpdater: {},
  AppImageUpdater: function AppImageUpdater() {},
}));

import * as SourceUpdater from "./SourceUpdater.ts";

type Message = Record<string, unknown>;

function harness(input: {
  readonly appVersion?: string;
  readonly scripts: Record<
    string,
    { readonly messages: Message[]; readonly code?: number; readonly stderr?: string[] }
  >;
}) {
  const calls: string[][] = [];
  const applied: string[][] = [];
  let quits = 0;
  const updater = SourceUpdater.makeSourceUpdater({
    appVersion: input.appVersion ?? "0.1.10-preview.20261119.100",
    runScript: async (args, onMessage) => {
      calls.push([...args]);
      const script = input.scripts[args[0] ?? ""];
      if (script === undefined) return { code: 1, stderrTail: ["error: unknown command"] };
      for (const message of script.messages) onMessage(message);
      return { code: script.code ?? 0, stderrTail: script.stderr ?? [] };
    },
    startApply: (args) => applied.push([...args]),
    quit: () => {
      quits += 1;
    },
    pid: 4242,
  });
  const events: Array<{ readonly name: string; readonly payload: unknown }> = [];
  const listen = Effect.forEach(
    [
      "checking-for-update",
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
    ],
    (name) => updater.on(name, (payload: unknown) => events.push({ name, payload })),
  );
  return { updater, calls, applied, events, listen, quits: () => quits };
}

const offer = {
  type: "check",
  version: "0.1.10-preview.20261119.105",
  date: "2026-11-19T10:00:00Z",
  releaseNotes: "- fix(web): something upstream",
};

describe("SourceUpdater", () => {
  it.effect("needs no release feed", () =>
    Effect.sync(() => {
      assert.isTrue(harness({ scripts: {} }).updater.ownsFeed);
    }),
  );

  it.effect("offers a newer source version with its commits as release notes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = harness({ scripts: { check: { messages: [offer] } } });
        yield* h.listen;
        yield* h.updater.checkForUpdates;
        assert.deepStrictEqual(
          h.events.map((event) => event.name),
          ["checking-for-update", "update-available"],
        );
        assert.deepStrictEqual(h.events[1]?.payload, {
          version: offer.version,
          releaseNotes: offer.releaseNotes,
          releaseDate: offer.date,
        });
      }),
    ),
  );

  it.effect("reports no update when the source matches the running build", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = harness({
          appVersion: offer.version,
          scripts: { check: { messages: [offer] } },
        });
        yield* h.listen;
        yield* h.updater.checkForUpdates;
        assert.strictEqual(h.events.at(-1)?.name, "update-not-available");
      }),
    ),
  );

  it.effect("fails the check with install.py's error message", () =>
    Effect.gen(function* () {
      const h = harness({
        scripts: { check: { messages: [], code: 1, stderr: ["error: git fetch failed", ""] } },
      });
      const error = yield* Effect.flip(h.updater.checkForUpdates);
      assert.strictEqual(error._tag, "ElectronUpdaterCheckForUpdatesError");
      assert.include(String((error.cause as Error).message), "git fetch failed");
    }),
  );

  it.effect("builds the update, reporting progress, then installs it after quitting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = harness({
          scripts: {
            check: { messages: [offer] },
            stage: {
              messages: [
                { type: "progress", percent: 40, message: "Building" },
                { type: "staged", version: offer.version, app: "/src/release/mac-arm64/T3.app" },
              ],
            },
          },
        });
        yield* h.listen;
        yield* h.updater.checkForUpdates;
        yield* h.updater.downloadUpdate;
        assert.deepStrictEqual(
          h.events.slice(2).map((event) => event.name),
          ["download-progress", "update-downloaded"],
        );
        assert.deepStrictEqual(h.events.at(-1), {
          name: "update-downloaded",
          payload: {
            version: offer.version,
            releaseNotes: offer.releaseNotes,
            releaseDate: offer.date,
          },
        });

        yield* h.updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        assert.deepStrictEqual(h.applied, [
          ["apply", "--pid", "4242", "--app", "/src/release/mac-arm64/T3.app"],
        ]);
        assert.strictEqual(h.quits(), 1);
      }),
    ),
  );

  it.effect("fails the download when the merge or build fails", () =>
    Effect.gen(function* () {
      const h = harness({
        scripts: {
          stage: {
            messages: [{ type: "progress", percent: 10, message: "Merging" }],
            code: 1,
            stderr: ["error: upstream/main conflicts with your changes, so nothing was merged."],
          },
        },
      });
      const error = yield* Effect.flip(h.updater.downloadUpdate);
      assert.strictEqual(error._tag, "ElectronUpdaterDownloadUpdateError");
      assert.include(String((error.cause as Error).message), "conflicts with your changes");
    }),
  );

  it.effect("refuses to install before anything was built", () =>
    Effect.gen(function* () {
      const h = harness({ scripts: {} });
      const error = yield* Effect.flip(
        h.updater.quitAndInstall({ isSilent: true, isForceRunAfter: true }),
      );
      assert.strictEqual(error._tag, "ElectronUpdaterQuitAndInstallError");
      assert.strictEqual(h.quits(), 0);
    }),
  );

  it.effect("reads the config install.py writes", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        SourceUpdater.parseSourceUpdateConfig(
          '{"script": "/x/custom-t3/install.py", "python": "/usr/bin/python3"}',
        ),
        { script: "/x/custom-t3/install.py", python: "/usr/bin/python3" },
      );
      assert.isNull(SourceUpdater.parseSourceUpdateConfig("{}"));
      assert.isNull(SourceUpdater.parseSourceUpdateConfig("not json"));
      assert.strictEqual(
        SourceUpdater.sourceUpdateConfigPath({ T3CODE_HOME: "/tmp/custom-home" }),
        "/tmp/custom-home/source-update.json",
      );
    }),
  );
});
