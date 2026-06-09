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
