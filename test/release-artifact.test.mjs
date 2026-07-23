// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    assertCleanWorktree,
    assertExistingGitHubRelease,
    hashPreparedReleaseArtifact,
    readPreparedReleaseArtifact,
    writePreparedReleaseArtifact,
} from "../deploy/release-artifact.mjs";
import { resolveReleaseExecutable } from "../deploy/trusted-executable.mjs";
import {
    cleanupTempDirectories,
    createTempDirectory,
    writeJsonFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("existing GitHub releases must target the prepared commit", () => {
    const tag = "typescript-baseline-lib@0.1.0";
    const sourceCommit = "a".repeat(40);
    assert.doesNotThrow(() => assertExistingGitHubRelease({
        tag_name: tag,
        target_commitish: sourceCommit,
    }, tag, sourceCommit));
    assert.throws(
        () => assertExistingGitHubRelease({
            tag_name: tag,
            target_commitish: "b".repeat(40),
        }, tag, sourceCommit),
        /does not match source commit/u,
    );
});

test("release executables cannot resolve through repository or npm shim paths", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const shimDirectory = path.join(tempDirectory, "node_modules", ".bin");
    const originalPath = process.env.PATH;
    process.env.PATH = [shimDirectory, originalPath].filter(Boolean).join(path.delimiter);
    try {
        const resolved = resolveReleaseExecutable(tempDirectory, "UNSET_RELEASE_EXECUTABLE", "git");
        assert.ok(!resolved.environment.PATH?.split(path.delimiter).includes(shimDirectory));
        process.env.TEST_RELEASE_EXECUTABLE = path.join(shimDirectory, "git");
        assert.throws(
            () => resolveReleaseExecutable(tempDirectory, "TEST_RELEASE_EXECUTABLE", "git"),
            /absolute path outside the repository/u,
        );
    }
    finally {
        if (originalPath === undefined) {
            delete process.env.PATH;
        }
        else {
            process.env.PATH = originalPath;
        }
        delete process.env.TEST_RELEASE_EXECUTABLE;
    }
});

test("release artifacts reject tracked and untracked worktree changes", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    execFileSync("git", ["init", "--quiet"], { cwd: tempDirectory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDirectory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "clean\n");
    fs.writeFileSync(path.join(tempDirectory, "filtered.txt"), "reviewed\n");
    fs.writeFileSync(path.join(tempDirectory, ".gitignore"), ".tmp\n");
    execFileSync("git", ["add", "tracked.txt", "filtered.txt", ".gitignore"], { cwd: tempDirectory });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: tempDirectory });

    assert.doesNotThrow(() => assertCleanWorktree(tempDirectory));

    const untrackedPath = path.join(tempDirectory, "untracked.d.ts");
    fs.writeFileSync(untrackedPath, "export declare const Surprise: number;\n");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
    fs.unlinkSync(untrackedPath);

    const ignoredGeneratedPath = path.join(tempDirectory, "generated", "current", "allow", ".tmp", "index.d.ts");
    fs.mkdirSync(path.dirname(ignoredGeneratedPath), { recursive: true });
    fs.writeFileSync(ignoredGeneratedPath, "export declare const Surprise: number;\n");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
    fs.rmSync(path.join(tempDirectory, "generated"), { recursive: true });

    execFileSync("git", ["update-index", "--assume-unchanged", "tracked.txt"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "hidden dirty\n");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
    execFileSync("git", ["update-index", "--no-assume-unchanged", "tracked.txt"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "clean\n");

    execFileSync("git", ["update-index", "--skip-worktree", "tracked.txt"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "hidden dirty\n");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
    execFileSync("git", ["update-index", "--no-skip-worktree", "tracked.txt"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "clean\n");

    const filterScriptPath = path.join(tempDirectory, ".git", "clean-filter.cjs");
    fs.writeFileSync(filterScriptPath, [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => process.stdout.write(input.replaceAll('injected', 'reviewed')));",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(tempDirectory, ".git", "info", "attributes"), "filtered.txt filter=hide\n");
    execFileSync("git", ["config", "filter.hide.clean", `\"${process.execPath}\" \"${filterScriptPath}\"`], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "filtered.txt"), "injected\n");
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: tempDirectory, encoding: "utf8" }), "");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
    fs.writeFileSync(path.join(tempDirectory, "filtered.txt"), "reviewed\n");

    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "dirty\n");
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
});

test("prepared release artifact binds package identity, commit, and tarball integrity", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const packageDirectory = path.join(tempDirectory, "tar-source", "package");
    const tarballPath = path.join(tempDirectory, "source.tgz");
    const artifactDirectory = path.join(tempDirectory, "artifact");
    writeJsonFile(path.join(packageDirectory, "package.json"), {
        name: "typescript-baseline-lib",
        version: "0.1.0",
    });
    execFileSync("tar", ["-czf", tarballPath, "package"], {
        cwd: path.dirname(packageDirectory),
    });

    const plan = await writePreparedReleaseArtifact({
        outputDirectory: artifactDirectory,
        sourceCommit: "a".repeat(40),
        releasePlan: {
            changed: true,
            packageConfig: { name: "typescript-baseline-lib" },
            packageVersion: "0.1.0",
            publishedVersion: "0.0.1",
            requiredVersionBump: "major",
            notesMarkdown: "release notes\n",
        },
        tarballPath,
    });
    const artifact = await readPreparedReleaseArtifact(artifactDirectory);
    assert.deepEqual(artifact.plan, plan);
    assert.equal(artifact.notesMarkdown, "release notes\n");
    const artifactIntegrity = await hashPreparedReleaseArtifact(artifactDirectory, plan.changed);

    fs.appendFileSync(artifact.tarballPath, "tampered");
    assert.notEqual(await hashPreparedReleaseArtifact(artifactDirectory, plan.changed), artifactIntegrity);
    await assert.rejects(
        readPreparedReleaseArtifact(artifactDirectory),
        /Release tarball integrity mismatch/u,
    );
});

test("release worktree verification ignores Git replacement objects", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    execFileSync("git", ["init", "--quiet"], { cwd: tempDirectory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDirectory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDirectory });
    fs.writeFileSync(path.join(tempDirectory, "generated.d.ts"), "declare const Reviewed: unique symbol;\n");
    execFileSync("git", ["add", "generated.d.ts"], { cwd: tempDirectory });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: tempDirectory });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tempDirectory,
        encoding: "utf8",
    }).trim();

    fs.writeFileSync(path.join(tempDirectory, "generated.d.ts"), "declare const Injected: unique symbol;\n");
    execFileSync("git", ["add", "generated.d.ts"], { cwd: tempDirectory });
    const replacementTree = execFileSync("git", ["write-tree"], {
        cwd: tempDirectory,
        encoding: "utf8",
    }).trim();
    const replacementCommit = execFileSync(
        "git",
        ["commit-tree", replacementTree, "-p", sourceCommit, "-m", "replacement"],
        { cwd: tempDirectory, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["replace", sourceCommit, replacementCommit], { cwd: tempDirectory });

    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: tempDirectory, encoding: "utf8" }), "");
    assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDirectory, encoding: "utf8" }).trim(),
        sourceCommit,
    );
    assert.throws(
        () => assertCleanWorktree(tempDirectory),
        /clean worktree/u,
    );
});
