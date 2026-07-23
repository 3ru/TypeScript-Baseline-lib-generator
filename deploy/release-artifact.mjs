// @ts-check

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    readFileSync,
    readlinkSync,
} from "node:fs";
import {
    copyFile,
    mkdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./package-registry.mjs";
import { resolveReleaseExecutable } from "./trusted-executable.mjs";

const PLAN_FILE_NAME = "release-plan.json";
const NOTES_FILE_NAME = "release-notes.md";
const TARBALL_FILE_NAME = "package.tgz";

/**
 * @param {string} repoRoot
 */
export function assertCleanWorktree(repoRoot) {
    const worktreeStatus = getGitStatus(repoRoot, ["--untracked-files=all"]);
    const ignoredGeneratedStatus = getGitStatus(repoRoot, [
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        "generated/current",
    ]);
    const trackedFileState = runGit(repoRoot, ["ls-files", "-v"]);
    const hasHiddenIndexState = trackedFileState
        .split("\n")
        .some(line => line && line[0] !== "H");
    if (worktreeStatus || ignoredGeneratedStatus || hasHiddenIndexState || hasRawTrackedChanges(repoRoot)) {
        throw new Error("Release artifacts require a clean worktree");
    }
}

/** @param {string} repoRoot */
export function readHeadCommit(repoRoot) {
    return runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/**
 * Compare raw bytes instead of Git's filtered worktree view.
 *
 * @param {string} repoRoot
 */
function hasRawTrackedChanges(repoRoot) {
    const objectFormat = runGit(repoRoot, ["rev-parse", "--show-object-format"]).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
        throw new Error(`Unsupported Git object format: ${objectFormat}`);
    }

    const entries = runGit(repoRoot, ["ls-tree", "-r", "-z", "HEAD"])
        .split("\0")
        .filter(Boolean);
    for (const entry of entries) {
        const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(entry);
        if (!match) {
            throw new Error(`Unsupported tracked Git entry: ${entry}`);
        }
        const [, mode, expectedHash, relativePath] = match;
        const filePath = path.join(repoRoot, relativePath);
        if (!existsSync(filePath) && mode !== "120000") {
            return true;
        }
        const fileStats = lstatSync(filePath, { throwIfNoEntry: false });
        if (!fileStats) {
            return true;
        }
        if (
            (mode === "120000" && !fileStats.isSymbolicLink())
            || (mode !== "120000" && !fileStats.isFile())
        ) {
            return true;
        }
        const contents = mode === "120000"
            ? Buffer.from(readlinkSync(filePath))
            : readFileSync(filePath);
        const actualHash = createHash(objectFormat)
            .update(`blob ${contents.length}\0`)
            .update(contents)
            .digest("hex");
        if (actualHash !== expectedHash) {
            return true;
        }
    }
    return false;
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 */
function getGitStatus(repoRoot, args) {
    return runGit(repoRoot, ["status", "--porcelain=v1", ...args]).trim();
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 */
function runGit(repoRoot, args) {
    const git = resolveReleaseExecutable(repoRoot, "RELEASE_GIT_EXECUTABLE", "git");
    const result = spawnSync(git.executable, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...git.environment,
            GIT_NO_REPLACE_OBJECTS: "1",
        },
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed with exit code ${result.status}`);
    }
    return result.stdout;
}

/**
 * @param {unknown} release
 * @param {string} tag
 * @param {string} sourceCommit
 */
export function assertExistingGitHubRelease(release, tag, sourceCommit) {
    if (
        !release
        || typeof release !== "object"
        || !("tag_name" in release)
        || release.tag_name !== tag
        || !("target_commitish" in release)
        || release.target_commitish !== sourceCommit
    ) {
        throw new Error(`Existing GitHub release ${tag} does not match source commit ${sourceCommit}`);
    }
}

/**
 * @param {NodeJS.ProcessEnv} environment
 */
export function assertReleaseWorkflowContext(environment) {
    if (
        environment.GITHUB_ACTIONS !== "true"
        || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
        || environment.GITHUB_REF !== "refs/heads/main"
        || environment.GITHUB_JOB !== "publish"
        || !/^[^/]+\/[^/]+\/\.github\/workflows\/release\.yml@refs\/heads\/main$/u.test(environment.GITHUB_WORKFLOW_REF ?? "")
    ) {
        throw new Error("Publishing is restricted to the Release workflow dispatch on main");
    }
}

/**
 * @param {{
 *   outputDirectory: string;
 *   sourceCommit: string;
 *   releasePlan: {
 *     changed: boolean;
 *     packageConfig: { name: string; };
 *     packageVersion: string;
 *     publishedVersion?: string;
 *     notesMarkdown: string;
 *   };
 *   tarballPath?: string;
 * }} options
 */
export async function writePreparedReleaseArtifact(options) {
    const { releasePlan } = options;
    if (releasePlan.changed !== Boolean(options.tarballPath)) {
        throw new Error("A changed release plan must have exactly one package tarball");
    }
    await rm(options.outputDirectory, { recursive: true, force: true });
    await mkdir(options.outputDirectory, { recursive: true });

    const targetTarballPath = path.join(options.outputDirectory, TARBALL_FILE_NAME);
    const tarballIntegrity = options.tarballPath
        ? await copyAndHashTarball(options.tarballPath, targetTarballPath)
        : null;
    const plan = {
        schemaVersion: 2,
        sourceCommit: options.sourceCommit,
        changed: releasePlan.changed,
        packageName: releasePlan.packageConfig.name,
        packageVersion: releasePlan.packageVersion,
        publishedVersion: releasePlan.publishedVersion ?? null,
        tarballIntegrity,
    };
    validateReleasePlan(plan);
    await writeFile(
        path.join(options.outputDirectory, PLAN_FILE_NAME),
        `${JSON.stringify(plan, undefined, 2)}\n`,
    );
    await writeFile(path.join(options.outputDirectory, NOTES_FILE_NAME), releasePlan.notesMarkdown);
    return plan;
}

/**
 * @param {string} artifactDirectory
 */
export async function readPreparedReleaseArtifact(artifactDirectory) {
    const plan = JSON.parse(await readFile(path.join(artifactDirectory, PLAN_FILE_NAME), "utf8"));
    validateReleasePlan(plan);
    const tarballPath = path.join(artifactDirectory, TARBALL_FILE_NAME);
    if (plan.changed) {
        const integrity = await hashFile(tarballPath);
        if (integrity !== plan.tarballIntegrity) {
            throw new Error(`Release tarball integrity mismatch: expected ${plan.tarballIntegrity}, got ${integrity}`);
        }
        const tar = resolveReleaseExecutable(repoRoot, "RELEASE_TAR_EXECUTABLE", "tar");
        const packageJson = JSON.parse(execFileSync(tar.executable, ["-xOf", tarballPath, "package/package.json"], {
            encoding: "utf8",
            env: tar.environment,
        }));
        if (packageJson.name !== plan.packageName || packageJson.version !== plan.packageVersion) {
            throw new Error(
                `Release tarball contains ${String(packageJson.name)}@${String(packageJson.version)}; `
                    + `expected ${plan.packageName}@${plan.packageVersion}`,
            );
        }
    }
    return {
        plan,
        tarballPath,
        notesMarkdown: await readFile(path.join(artifactDirectory, NOTES_FILE_NAME), "utf8"),
    };
}

/**
 * @param {string} artifactDirectory
 * @param {boolean} changed
 */
export async function hashPreparedReleaseArtifact(artifactDirectory, changed) {
    const hash = createHash("sha512");
    const fileNames = [PLAN_FILE_NAME, NOTES_FILE_NAME];
    if (changed) {
        fileNames.push(TARBALL_FILE_NAME);
    }
    for (const fileName of fileNames) {
        const contents = await readFile(path.join(artifactDirectory, fileName));
        hash.update(`${fileName}\0${contents.length}\0`).update(contents);
    }
    return `sha512-${hash.digest("base64")}`;
}

/**
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
async function copyAndHashTarball(sourcePath, destinationPath) {
    await copyFile(sourcePath, destinationPath);
    return hashFile(destinationPath);
}

/**
 * @param {string} filePath
 */
async function hashFile(filePath) {
    return `sha512-${createHash("sha512").update(await readFile(filePath)).digest("base64")}`;
}

/**
 * @param {any} plan
 */
function validateReleasePlan(plan) {
    const expectedKeys = [
        "changed",
        "packageName",
        "packageVersion",
        "publishedVersion",
        "schemaVersion",
        "sourceCommit",
        "tarballIntegrity",
    ];
    if (
        !plan
        || typeof plan !== "object"
        || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(expectedKeys)
        || plan.schemaVersion !== 2
        || typeof plan.changed !== "boolean"
        || typeof plan.packageName !== "string"
        || typeof plan.packageVersion !== "string"
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(plan.packageVersion)
        || (plan.publishedVersion !== null && typeof plan.publishedVersion !== "string")
        || !/^[0-9a-f]{40}$/u.test(plan.sourceCommit)
        || (plan.changed !== (typeof plan.tarballIntegrity === "string"))
        || (typeof plan.tarballIntegrity === "string" && !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(plan.tarballIntegrity))
    ) {
        throw new Error("Invalid prepared release plan");
    }
}
