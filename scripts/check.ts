type CheckSelection = {
  readonly typescript: boolean;
  readonly reason: string;
};

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

type CommandRunner = (command: readonly string[]) => CommandResult;

export class CheckError extends Error {}

const repositoryRoot = new URL("..", import.meta.url).pathname;

export function changedPathsFromPorcelain(output: string): string[] {
  const records = output.split("\0").filter(Boolean);
  const paths: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const path = record.slice(3);
    paths.push(path);

    // With -z, Git writes rename/copy destinations first, then the source as a
    // separate NUL-delimited record. Both paths can independently select a tree.
    if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
      const sourcePath = records[index + 1];
      if (!sourcePath)
        throw new CheckError("git status reported a rename or copy without its source path");
      paths.push(sourcePath);
      index += 1;
    }
  }

  return paths;
}

export function selectChecks(paths: readonly string[]): CheckSelection {
  if (paths.length === 0) {
    throw new CheckError(
      "could not determine changed files: origin/main...HEAD and the working tree are empty",
    );
  }

  const hasTypeScript = paths.some((path) => /\.(?:ts|tsx|json|css)$/.test(path));
  const unrecognised = paths.filter((path) => !/\.(?:ts|tsx|json|css)$/.test(path));

  if (unrecognised.length > 0) {
    return {
      typescript: true,
      reason: `unrecognised changed paths: ${unrecognised.join(", ")}`,
    };
  }
  return {
    typescript: hasTypeScript,
    reason: hasTypeScript ? "changed TypeScript files" : "no TypeScript files changed",
  };
}

function runGit(runner: CommandRunner, args: readonly string[]): string {
  const result = runner(["git", ...args]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new CheckError(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

export function changedPaths(runner: CommandRunner): string[] {
  runGit(runner, ["symbolic-ref", "--quiet", "HEAD"]);
  runGit(runner, ["rev-parse", "--verify", "origin/main^{commit}"]);
  runGit(runner, ["merge-base", "origin/main", "HEAD"]);

  const committed = runGit(runner, ["diff", "--name-only", "-z", "origin/main...HEAD"])
    .split("\0")
    .filter(Boolean);
  const workingTree = changedPathsFromPorcelain(
    runGit(runner, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );

  return [...new Set([...committed, ...workingTree])];
}

function shellRunner(command: readonly string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function run(command: readonly string[], cwd = repositoryRoot): void {
  console.error(`$ ${command.join(" ")}`);
  const result = Bun.spawnSync({ cmd: [...command], cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

export function runCheck(runner: CommandRunner = shellRunner): void {
  const selection = selectChecks(changedPaths(runner));
  console.error(`check selection: ${selection.reason}`);

  if (selection.typescript) {
    run(["bunx", "biome", "check", "."]);
    run(["bun", "run", "typecheck"]);
  } else {
    console.error("skipped biome check: no TypeScript changed");
    console.error("skipped typecheck: no TypeScript changed");
  }
}

if (import.meta.main) {
  try {
    runCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
