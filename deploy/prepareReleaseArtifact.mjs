// @ts-check

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    collectReleasePlans,
    createPackageTarball,
} from "./package-lib.mjs";
import {
    assertCleanWorktree,
    hashPreparedReleaseArtifact,
    readHeadCommit,
    writePreparedReleaseArtifact,
} from "./release-artifact.mjs";

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deployDirectory, "..");
const args = parseArgs(process.argv.slice(2));
assertCleanWorktree(repoRoot);
const sourceCommit = readHeadCommit(repoRoot);
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) {
    throw new Error(`Checked-out commit ${sourceCommit} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`);
}

const releasePlans = await collectReleasePlans({
    packageId: "baseline",
    versionOverride: args.version,
    preview: true,
});
if (releasePlans.length !== 1) {
    throw new Error(`Expected one release plan, got ${releasePlans.length}`);
}
const [releasePlan] = releasePlans;
if (releasePlan.requiredVersionBump && !args.version && !args.preview) {
    throw new Error(
        `Release requires a reviewed ${releasePlan.requiredVersionBump} version; rerun with --version after inspecting the package diff`,
    );
}
const tarballPath = releasePlan.changed
    ? await createPackageTarball(releasePlan.stageDirectory)
    : undefined;
const plan = await writePreparedReleaseArtifact({
    outputDirectory: args.outputDirectory,
    sourceCommit,
    releasePlan,
    tarballPath,
});
const artifactIntegrity = await hashPreparedReleaseArtifact(args.outputDirectory, plan.changed);
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `artifact-integrity=${artifactIntegrity}\n`);
}

console.log(`Prepared: ${plan.changed ? `${plan.packageName}@${plan.packageVersion}` : "no package changes"}`);
console.log(`Artifact: ${args.outputDirectory}`);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ version?: string; outputDirectory: string; preview: boolean; }} */
    const parsed = {
        outputDirectory: path.join(repoRoot, "release-artifact"),
        preview: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        if (current === "--version") {
            parsed.version = requireValue(argv[++index], current);
        }
        else if (current === "--preview") {
            parsed.preview = true;
        }
        else {
            throw new Error(`Unknown argument: ${current}`);
        }
    }
    return parsed;
}

/**
 * @param {string | undefined} value
 * @param {string} flag
 */
function requireValue(value, flag) {
    if (!value) {
        throw new Error(`Missing value for ${flag}`);
    }
    return value;
}
