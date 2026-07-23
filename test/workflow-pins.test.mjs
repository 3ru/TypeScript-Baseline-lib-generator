import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "./helpers.mjs";

const workflowsDirectory = path.join(repoRoot, ".github", "workflows");

// Allow only a 40-hex commit SHA pin plus a human-readable tag comment.
// Floating tags (like "@v4") and short SHAs are banned: they carry supply-chain
// risk and irresolvable references when an upstream action is tampered with, deleted, or force-pushed.
const PINNED_USES_PATTERN = /^[^@\s]+@[0-9a-f]{40}\s+#\s*v?\S+/u;

/**
 * @param {string} fileName
 * @returns {{ fileName: string, line: number, reference: string }[]}
 */
function collectActionReferences(fileName) {
    const source = readFileSync(path.join(workflowsDirectory, fileName), "utf8");
    const references = [];
    for (const [index, line] of source.split("\n").entries()) {
        const match = line.match(/^\s*(?:-\s+)?uses:\s*(?<reference>\S.*)$/u);
        if (match?.groups?.reference === undefined) {
            continue;
        }
        references.push({
            fileName,
            line: index + 1,
            reference: match.groups.reference.trim(),
        });
    }
    return references;
}

test("every workflow action is pinned to a full commit SHA with a version comment", () => {
    const workflowFiles = readdirSync(workflowsDirectory)
        .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
        .sort();

    assert.ok(workflowFiles.length > 0, "expected at least one workflow file");

    const violations = [];
    let referenceCount = 0;
    for (const fileName of workflowFiles) {
        for (const entry of collectActionReferences(fileName)) {
            referenceCount += 1;
            // Local actions in the repo (./...) are exempt from SHA pinning.
            if (entry.reference.startsWith("./")) {
                continue;
            }
            if (!PINNED_USES_PATTERN.test(entry.reference)) {
                violations.push(`${entry.fileName}:${entry.line} -> ${entry.reference}`);
            }
        }
    }

    assert.ok(referenceCount > 0, "expected at least one `uses:` reference across workflows");
    assert.deepEqual(
        violations,
        [],
        `unpinned workflow actions found (pin to a 40-hex commit SHA with a version comment):\n${violations.join("\n")}`,
    );
});

test("release publishing stays isolated from build dependencies", () => {
    const source = readFileSync(path.join(workflowsDirectory, "release.yml"), "utf8");
    const publishJob = source.split(/^  publish:/mu)[1];
    assert.ok(publishJob, "expected a dedicated publish job");
    assert.match(source, /^  verify:[\s\S]*?permissions:\n      contents: read/mu);
    assert.match(source, /RELEASE_GIT_EXECUTABLE: \/usr\/bin\/git/u);
    assert.match(source, /RELEASE_NODE_EXECUTABLE: \$\{\{ steps\.release-tools\.outputs\.node \}\}/u);
    assert.match(source, /RELEASE_NPM_EXECUTABLE: \$\{\{ steps\.release-tools\.outputs\.npm \}\}/u);
    assert.match(source, /RELEASE_TAR_EXECUTABLE: \$\{\{ steps\.release-tools\.outputs\.tar \}\}/u);
    assert.match(source, /"\$RELEASE_NODE_EXECUTABLE" deploy\/prepareReleaseArtifact\.mjs/u);
    assert.match(source, /"\$RELEASE_NODE_EXECUTABLE" --test test\/packed-consumer-smoke\.test\.mjs/u);
    assert.match(source, /"\$RELEASE_NODE_EXECUTABLE" deploy\/verifyReleaseArtifact\.mjs --artifact-dir release-artifact/u);
    assert.match(source, /artifact-integrity: \$\{\{ steps\.prepare-artifact\.outputs\.artifact-integrity \}\}/u);
    assert.match(source, /EXPECTED_ARTIFACT_INTEGRITY: \$\{\{ needs\.verify\.outputs\.artifact-integrity \}\}/u);
    assert.doesNotMatch(source, /\bjq\b/u);
    assert.match(publishJob, /environment: release/u);
    assert.match(publishJob, /id-token: write/u);
    assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40}/u);
    assert.match(publishJob, /"\$RELEASE_NODE_EXECUTABLE" deploy\/publishReleaseArtifact\.mjs --artifact-dir release-artifact/u);
    assert.match(publishJob, /RELEASE_NODE_EXECUTABLE: \$\{\{ steps\.publish-tools\.outputs\.node \}\}/u);
    assert.match(publishJob, /RELEASE_NPM_EXECUTABLE: \$\{\{ steps\.publish-tools\.outputs\.npm \}\}/u);
    assert.match(publishJob, /RELEASE_TAR_EXECUTABLE: \/usr\/bin\/tar/u);
    assert.doesNotMatch(publishJob, /npm (?:ci|install)/u);
    assert.doesNotMatch(source, /\.tmp\/release-artifact/u);
    assert.doesNotMatch(source, /\.tmp\/typescript-(?:integration|baseline|focused|raw)/u);
    assert.match(source, /path: typescript-integration-artifacts\/raw-local-baselines\n          if-no-files-found: error/u);
    for (const fileName of ["test-typescript.yml", "test-typescript-go.yml"]) {
        const integrationSource = readFileSync(path.join(workflowsDirectory, fileName), "utf8");
        assert.doesNotMatch(integrationSource, /\.tmp\/typescript-(?:integration|baseline|focused|raw|go-integration)/u);
        assert.match(integrationSource, /if-no-files-found: error/u);
    }
});
