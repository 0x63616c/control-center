import { describe, expect, it } from "vitest";

import {
  CheckError,
  changedPaths,
  changedPathsFromPorcelain,
  selectChecks,
} from "../../scripts/check";

describe("check", () => {
  it("selects the Go tree for Go-only changes", () => {
    expect(selectChecks(["apps/software-factory/internal/work/work.go"])).toEqual({
      go: true,
      typescript: false,
      reason: "changed Go files",
    });
  });

  it("selects the TypeScript tree for TypeScript, JSON, and CSS changes", () => {
    expect(selectChecks(["apps/web/src/App.tsx", "biome.json", "apps/web/src/app.css"])).toEqual({
      go: false,
      typescript: true,
      reason: "changed TypeScript files",
    });
  });

  it("selects both trees for mixed changes", () => {
    expect(selectChecks(["scripts/check.ts", "apps/software-factory/main.go"])).toEqual({
      go: true,
      typescript: true,
      reason: "changed Go and TypeScript files",
    });
  });

  it("selects both trees for unrecognised paths", () => {
    expect(selectChecks([".github/workflows/ci.yml"])).toEqual({
      go: true,
      typescript: true,
      reason: "unrecognised changed paths: .github/workflows/ci.yml",
    });
  });

  it("includes untracked and both sides of renames in porcelain output", () => {
    expect(
      changedPathsFromPorcelain(
        " M scripts/check.ts\0?? notes with spaces.md\0R  new-name.go\0old-name.ts\0",
      ),
    ).toEqual(["scripts/check.ts", "notes with spaces.md", "new-name.go", "old-name.ts"]);
  });

  it("fails loudly when no changed paths can be checked", () => {
    expect(() => selectChecks([])).toThrow(CheckError);
  });

  it("unions the committed diff with working-tree paths", () => {
    const commands: string[][] = [];
    const outputByCommand = new Map<string, string>([
      ["git symbolic-ref --quiet HEAD", "refs/heads/topic\n"],
      ["git rev-parse --verify origin/main^{commit}", "main\n"],
      ["git merge-base origin/main HEAD", "base\n"],
      ["git diff --name-only -z origin/main...HEAD", "committed.go\0"],
      ["git status --porcelain=v1 -z --untracked-files=all", "?? working.ts\0"],
    ]);

    const paths = changedPaths((command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: outputByCommand.get(command.join(" ")) ?? "" };
    });

    expect(paths).toEqual(["committed.go", "working.ts"]);
    expect(commands).toContainEqual(["git", "diff", "--name-only", "-z", "origin/main...HEAD"]);
  });

  it("fails when the branch prerequisite cannot be resolved", () => {
    expect(() =>
      changedPaths((command) => ({
        exitCode: command[1] === "rev-parse" ? 128 : 0,
        stderr: "unknown revision origin/main",
        stdout: "",
      })),
    ).toThrow("rev-parse --verify origin/main^{commit} failed");
  });
});
