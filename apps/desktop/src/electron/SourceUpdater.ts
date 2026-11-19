// @effect-diagnostics nodeBuiltinImport:off -- Runs the custom build's local install.py and the detached helper that swaps the app.
/**
 * Updates T3 Code Custom from source in place of electron-updater, so the update UI keeps working:
 * nv-dev-tools' custom-t3/install.py checks upstream and the fork, merges and builds, then swaps
 * the app. It records itself in `<T3CODE_HOME>/source-update.json`; without that file, no change.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir } from "../app/DesktopStatePaths.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

const SOURCE_UPDATE_CONFIG_FILE = "source-update.json";
const STDERR_TAIL_LINES = 20;

export interface SourceUpdateConfig {
  /** Absolute path to nv-dev-tools' custom-t3/install.py. */
  readonly script: string;
  /** The Python that ran install.py. */
  readonly python: string;
}

export interface ScriptResult {
  readonly code: number;
  /** The last lines the script wrote to stderr, which end with its error message. */
  readonly stderrTail: ReadonlyArray<string>;
}

/** Runs install.py with these arguments, handing each JSON line it prints to `onMessage`. */
export type RunScript = (
  args: ReadonlyArray<string>,
  onMessage: (message: Record<string, unknown>) => void,
) => Promise<ScriptResult>;

export interface SourceUpdaterDeps {
  readonly appVersion: string;
  readonly runScript: RunScript;
  /** Starts `install.py apply` detached, so it outlives this process. */
  readonly startApply: (args: ReadonlyArray<string>) => void;
  readonly quit: () => void;
  readonly pid: number;
}

interface Staged {
  readonly version: string;
  readonly app: string;
}

export function parseSourceUpdateConfig(text: string): SourceUpdateConfig | null {
  try {
    const value = JSON.parse(text) as { readonly script?: unknown; readonly python?: unknown };
    if (typeof value.script !== "string" || value.script.length === 0) return null;
    const python =
      typeof value.python === "string" && value.python.length > 0 ? value.python : "python3";
    return { script: value.script, python };
  } catch {
    return null;
  }
}

export function sourceUpdateConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: NodeOS.homedir(),
    joinPath: NodePath.join,
    t3Home: Option.fromNullishOr(env.T3CODE_HOME),
  });
  return NodePath.join(baseDir, SOURCE_UPDATE_CONFIG_FILE);
}

function scriptFailure(action: string, result: ScriptResult): Error {
  const last = result.stderrTail.findLast((line) => line.trim().length > 0)?.trim();
  const message = last?.replace(/^error:\s*/, "") ?? `install.py exited with code ${result.code}`;
  return new Error(`Could not ${action}: ${message}`);
}

const stringField = (message: Record<string, unknown>, key: string): string | undefined => {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
};

export function makeSourceUpdater(
  deps: SourceUpdaterDeps,
): ElectronUpdater.ElectronUpdater["Service"] {
  const events = new NodeEvents.EventEmitter();
  let allowDowngrade = false;
  let lastOffer: Record<string, unknown> | null = null;
  let staged: Staged | null = null;
  let staging: Promise<void> | null = null;

  const check = async () => {
    events.emit("checking-for-update");
    let found: Record<string, unknown> | null = null;
    const result = await deps.runScript(["check"], (message) => {
      if (message.type === "check") found = message;
    });
    const offer = found as Record<string, unknown> | null;
    const version = offer === null ? undefined : stringField(offer, "version");
    if (result.code !== 0 || offer === null || version === undefined) {
      throw scriptFailure("check for updates", result);
    }
    const info = {
      version,
      releaseNotes: stringField(offer, "releaseNotes") ?? null,
      releaseDate: stringField(offer, "date"),
    };
    const newer = compareSemverVersions(version, deps.appVersion) > 0;
    if (newer || (allowDowngrade && version !== deps.appVersion)) {
      lastOffer = info;
      events.emit("update-available", info);
    } else {
      events.emit("update-not-available", { ...info, version: deps.appVersion });
    }
  };

  const stage = async () => {
    let built: Staged | null = null;
    const result = await deps.runScript(["stage"], (message) => {
      if (message.type === "progress" && typeof message.percent === "number") {
        events.emit("download-progress", {
          percent: message.percent,
          bytesPerSecond: 0,
          total: 100,
          transferred: message.percent,
        });
      } else if (message.type === "staged") {
        const version = stringField(message, "version");
        const app = stringField(message, "app");
        if (version !== undefined && app !== undefined) built = { version, app };
      }
    });
    const done = built as Staged | null;
    if (result.code !== 0 || done === null) throw scriptFailure("build the update", result);
    staged = done;
    events.emit("update-downloaded", {
      ...lastOffer,
      version: done.version,
    });
  };

  return ElectronUpdater.ElectronUpdater.of({
    ownsFeed: true,
    setFeedURL: Effect.fn("SourceUpdater.setFeedURL")(function* () {}),
    setAutoDownload: Effect.fn("SourceUpdater.setAutoDownload")(function* () {}),
    setAutoInstallOnAppQuit: Effect.fn("SourceUpdater.setAutoInstallOnAppQuit")(function* () {}),
    setChannel: Effect.fn("SourceUpdater.setChannel")(function* () {}),
    setAllowPrerelease: Effect.fn("SourceUpdater.setAllowPrerelease")(function* () {}),
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: Effect.fn("SourceUpdater.setAllowDowngrade")(function (value) {
      return Effect.sync(() => {
        allowDowngrade = value;
      });
    }),
    setFullChangelog: Effect.fn("SourceUpdater.setFullChangelog")(function* () {}),
    setDisableDifferentialDownload: Effect.fn("SourceUpdater.setDisableDifferentialDownload")(
      function* () {},
    ),
    checkForUpdates: Effect.tryPromise({
      try: check,
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: () => {
        staging ??= stage().finally(() => {
          staging = null;
        });
        return staging;
      },
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
    }),
    quitAndInstall: Effect.fn("SourceUpdater.quitAndInstall")(function* ({
      isSilent,
      isForceRunAfter,
    }) {
      yield* Effect.try({
        try: () => {
          if (staged === null) throw new Error("No update has been built yet.");
          deps.startApply(["apply", "--pid", String(deps.pid), "--app", staged.app]);
          deps.quit();
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
    on: Effect.fn("SourceUpdater.on")(function (eventName, listener) {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    }),
  });
}

function updateLogPath(): string {
  return NodePath.join(NodeOS.homedir(), "Library", "Logs", "T3CodeCustom", "update.log");
}

function openUpdateLog(args: ReadonlyArray<string>): number | "ignore" {
  try {
    const path = updateLogPath();
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    const fd = NodeFS.openSync(path, "a");
    NodeFS.writeSync(fd, `\n--- install.py ${args.join(" ")} ---\n`);
    return fd;
  } catch {
    return "ignore";
  }
}

function closeQuietly(fd: number | "ignore") {
  if (fd === "ignore") return;
  try {
    NodeFS.closeSync(fd);
  } catch {
    // Already closed.
  }
}

function makeRunScript(config: SourceUpdateConfig): RunScript {
  return (args, onMessage) =>
    new Promise((resolve) => {
      const log = openUpdateLog(args);
      const child = NodeChildProcess.spawn(config.python, [config.script, ...args], {
        cwd: NodePath.dirname(config.script),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderrTail: Array<string> = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const writeLog = (text: string) => {
        if (log !== "ignore") NodeFS.writeSync(log, text);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          writeLog(`${line}\n`);
          try {
            const message: unknown = JSON.parse(line);
            if (typeof message === "object" && message !== null) {
              onMessage(message as Record<string, unknown>);
            }
          } catch {
            // Not a message for the app.
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        writeLog(chunk);
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        stderrTail.push(...lines);
        stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_TAIL_LINES));
      });
      const finish = (code: number, extra?: string) => {
        if (stderrBuffer.length > 0) stderrTail.push(stderrBuffer);
        if (extra !== undefined) stderrTail.push(extra);
        closeQuietly(log);
        resolve({ code, stderrTail });
      };
      child.on("error", (error) => finish(1, `error: ${error.message}`));
      child.on("close", (code) => finish(code ?? 1));
    });
}

function makeStartApply(config: SourceUpdateConfig) {
  return (args: ReadonlyArray<string>) => {
    const log = openUpdateLog(args);
    const child = NodeChildProcess.spawn(config.python, [config.script, ...args], {
      cwd: NodePath.dirname(config.script),
      env: process.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    closeQuietly(log);
  };
}

function readSourceUpdateConfig(path = sourceUpdateConfigPath()): SourceUpdateConfig | null {
  try {
    return parseSourceUpdateConfig(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The source updater when install.py set this build up for it, otherwise electron-updater. */
export const layer = Layer.sync(ElectronUpdater.ElectronUpdater, () => {
  const config = readSourceUpdateConfig();
  if (config === null) return ElectronUpdater.make;
  return makeSourceUpdater({
    appVersion: Electron.app.getVersion(),
    runScript: makeRunScript(config),
    startApply: makeStartApply(config),
    quit: () => Electron.app.quit(),
    pid: process.pid,
  });
});
