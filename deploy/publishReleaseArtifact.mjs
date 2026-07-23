// @ts-check

import { execFileSync } from "node:child_process";
import path from "node:path";
import { repoRoot } from "./package-registry.mjs";
import {
    assertExistingGitHubRelease,
    hashPreparedReleaseArtifact,
    readPreparedReleaseArtifact,
} from "./release-artifact.mjs";
import { resolveReleaseExecutable } from "./trusted-executable.mjs";

const args = parseArgs(process.argv.slice(2));
const { plan, tarballPath, notesMarkdown } = await readPreparedReleaseArtifact(args.artifactDirectory);
const artifactIntegrity = await hashPreparedReleaseArtifact(args.artifactDirectory, plan.changed);
if (!process.env.EXPECTED_ARTIFACT_INTEGRITY || artifactIntegrity !== process.env.EXPECTED_ARTIFACT_INTEGRITY) {
    throw new Error("Downloaded release artifact does not match the verified build output");
}
if (!plan.changed) {
    throw new Error("Prepared release contains no package changes");
}
if (!process.env.GITHUB_SHA || process.env.GITHUB_SHA !== plan.sourceCommit) {
    throw new Error(`Release artifact commit ${plan.sourceCommit} does not match GITHUB_SHA ${process.env.GITHUB_SHA ?? "<missing>"}`);
}

const metadata = await readPackageMetadata(plan.packageName);
const publishedVersion = metadata?.["dist-tags"]?.latest ?? null;
const existingVersion = metadata?.versions?.[plan.packageVersion];
let published = false;
if (existingVersion) {
    if (existingVersion.dist?.integrity !== plan.tarballIntegrity) {
        throw new Error(`${plan.packageName}@${plan.packageVersion} already exists with different integrity`);
    }
}
else {
    if (publishedVersion !== plan.publishedVersion) {
        throw new Error(
            `npm latest changed after verification: expected ${plan.publishedVersion ?? "none"}, got ${publishedVersion ?? "none"}`,
        );
    }
    const publishArgs = ["publish", tarballPath, "--access", "public"];
    if (args.provenance) {
        publishArgs.push("--provenance");
    }
    const npm = resolveReleaseExecutable(repoRoot, "RELEASE_NPM_EXECUTABLE", "npm");
    execFileSync(npm.executable, publishArgs, {
        stdio: "inherit",
        env: npm.environment,
    });
    published = true;
}

await createGitHubRelease({
    packageName: plan.packageName,
    packageVersion: plan.packageVersion,
    sourceCommit: plan.sourceCommit,
    notesMarkdown,
});
console.log(`${published ? "Published" : "Verified existing"}: ${plan.packageName}@${plan.packageVersion}`);

/**
 * @param {string} packageName
 */
async function readPackageMetadata(packageName) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`npm registry returned ${response.status} ${response.statusText}`);
    }
    return /** @type {Promise<any>} */ (response.json());
}

/**
 * @param {{ packageName: string; packageVersion: string; sourceCommit: string; notesMarkdown: string; }} options
 */
async function createGitHubRelease(options) {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repository || !token) {
        throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to create the release");
    }
    const tag = `${options.packageName}@${options.packageVersion}`;
    const response = await fetch(`https://api.github.com/repos/${repository}/releases`, {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({
            tag_name: tag,
            target_commitish: options.sourceCommit,
            name: tag,
            body: options.notesMarkdown,
        }),
    });
    if (response.ok) {
        return;
    }
    if (response.status === 422) {
        const existing = await fetch(
            `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
            { headers: githubHeaders(token) },
        );
        if (existing.ok) {
            assertExistingGitHubRelease(await existing.json(), tag, options.sourceCommit);
            return;
        }
    }
    throw new Error(`GitHub release creation failed: ${response.status} ${response.statusText}`);
}

/**
 * @param {string} token
 */
function githubHeaders(token) {
    return {
        "authorization": `Bearer ${token}`,
        "accept": "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "typescript-baseline-lib-generator",
        "x-github-api-version": "2022-11-28",
    };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const parsed = {
        artifactDirectory: path.resolve("release-artifact"),
        provenance: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        if (current === "--artifact-dir") {
            const value = argv[++index];
            if (!value) {
                throw new Error("Missing value for --artifact-dir");
            }
            parsed.artifactDirectory = path.resolve(value);
        }
        else if (current === "--provenance") {
            parsed.provenance = true;
        }
        else {
            throw new Error(`Unknown argument: ${current}`);
        }
    }
    return parsed;
}
