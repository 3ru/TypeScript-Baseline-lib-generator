// @ts-check

import { appendFile } from "node:fs/promises";
import path from "node:path";
import {
    hashPreparedReleaseArtifact,
    readPreparedReleaseArtifact,
} from "./release-artifact.mjs";

const artifactDirectory = parseArtifactDirectory(process.argv.slice(2));
const { plan } = await readPreparedReleaseArtifact(artifactDirectory);
const artifactIntegrity = await hashPreparedReleaseArtifact(artifactDirectory, plan.changed);
if (!process.env.EXPECTED_ARTIFACT_INTEGRITY || artifactIntegrity !== process.env.EXPECTED_ARTIFACT_INTEGRITY) {
    throw new Error("Release artifact does not match the integrity recorded during preparation");
}
if (process.env.GITHUB_SHA && plan.sourceCommit !== process.env.GITHUB_SHA) {
    throw new Error(`Release artifact commit ${plan.sourceCommit} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`);
}
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\n`);
}
console.log(`Verified release artifact for ${plan.packageName}@${plan.packageVersion}`);

/** @param {string[]} argv */
function parseArtifactDirectory(argv) {
    if (argv.length !== 2 || argv[0] !== "--artifact-dir" || !argv[1]) {
        throw new Error("Usage: node deploy/verifyReleaseArtifact.mjs --artifact-dir <path>");
    }
    return path.resolve(argv[1]);
}
