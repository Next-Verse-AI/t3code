// Finds a `cd:local` run (nv-fabric's full local CI/CD) in progress from the process table, and
// ties it to a pull request by the git branch or commit checked out where it runs.
import type { LocalCiRun, LocalCiRunInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const PROBE_TIMEOUT = Duration.seconds(5);
const PS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CD_LOCAL_COMMAND = /(?:^|[\s/])(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?cd:local(?:\s|$)/;

/** `ps -o etime` reads `[[dd-]hh:]mm:ss`. */
export function parseElapsedSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** The `cd:local` runs in a `ps -Ao pid=,etime=,command=` listing, oldest first. */
export function findCdLocalProcesses(
  listing: string,
): ReadonlyArray<{ readonly pid: number; readonly elapsedSeconds: number }> {
  const found: Array<{ readonly pid: number; readonly elapsedSeconds: number }> = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null || !CD_LOCAL_COMMAND.test(match[3]!)) continue;
    const elapsedSeconds = parseElapsedSeconds(match[2]!);
    if (elapsedSeconds !== null) found.push({ pid: Number(match[1]), elapsedSeconds });
  }
  return found.toSorted((left, right) => right.elapsedSeconds - left.elapsedSeconds);
}

/** Reads a checkout's HEAD: `ref: refs/heads/<branch>` or a detached commit. */
export function parseHead(head: string): {
  readonly branch: string | null;
  readonly sha: string | null;
} {
  const text = head.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (ref !== null) return { branch: ref[1]!, sha: null };
  return /^[0-9a-f]{40,64}$/i.test(text)
    ? { branch: null, sha: text.toLowerCase() }
    : { branch: null, sha: null };
}

class LocalCiRunService extends Context.Service<
  LocalCiRunService,
  { readonly current: (input: LocalCiRunInput) => Effect.Effect<LocalCiRun | null> }
>()("t3/pullRequest/LocalCiRunService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;

  const runText = (command: string, args: ReadonlyArray<string>) =>
    processes
      .run({ command, args, timeout: PROBE_TIMEOUT, maxOutputBytes: PS_MAX_OUTPUT_BYTES })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => ""),
      );

  const cwdOf = (pid: number) =>
    platform === "linux"
      ? fileSystem.readLink(`/proc/${pid}/cwd`).pipe(Effect.orElseSucceed(() => null))
      : runText("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).pipe(
          Effect.map(
            (out) =>
              out
                .split("\n")
                .find((line) => line.startsWith("n"))
                ?.slice(1) ?? null,
          ),
        );

  // A linked worktree's `.git` is a file naming its git directory.
  const headOf = Effect.fnUntraced(
    function* (cwd: string) {
      const dotGit = path.join(cwd, ".git");
      const info = yield* fileSystem.stat(dotGit);
      const gitDir =
        info.type === "Directory"
          ? dotGit
          : path.resolve(
              cwd,
              (yield* fileSystem.readFileString(dotGit)).replace(/^gitdir:\s*/, "").trim(),
            );
      return parseHead(yield* fileSystem.readFileString(path.join(gitDir, "HEAD")));
    },
    Effect.orElseSucceed(() => ({ branch: null, sha: null })),
  );

  const current: LocalCiRunService["Service"]["current"] = Effect.fn("LocalCiRunService.current")(
    function* (input) {
      if (platform === "win32") return null;
      const runs = findCdLocalProcesses(yield* runText("ps", ["-Ao", "pid=,etime=,command="]));
      const headSha = input.headSha?.toLowerCase();
      for (const run of runs) {
        const cwd = yield* cwdOf(run.pid);
        if (cwd === null || cwd === "") continue;
        const head = yield* headOf(cwd);
        const matches =
          head.branch === input.headBranch ||
          (head.sha !== null && headSha !== undefined && head.sha.startsWith(headSha));
        if (!matches) continue;
        const now = yield* Clock.currentTimeMillis;
        return { startedAt: Math.max(0, now - run.elapsedSeconds * 1000), cwd };
      }
      return null;
    },
  );

  return LocalCiRunService.of({ current });
});
