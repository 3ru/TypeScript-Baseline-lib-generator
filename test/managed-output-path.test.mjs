// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    isPathWithin,
    removeManagedPath,
    resolveManagedOutputPath,
} from "../lib/shared.mjs";
import {
    cleanupTempDirectories,
    createTempDirectory,
} from "./helpers.mjs";

const repoRoot = path.resolve("/repo");
const manifestPath = path.join(repoRoot, "manifests", "baseline.json");
const generatedRoot = path.join(repoRoot, "generated", "current");
/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("managed output paths stay inside their canonical repo root", () => {
    assert.equal(
        resolveManagedOutputPath(
            "generated/current/baseline.d.ts",
            repoRoot,
            manifestPath,
            "firstClassLib.outputFile",
            [generatedRoot],
        ),
        path.join(generatedRoot, "baseline.d.ts"),
    );

    for (const invalidPath of [
        path.join(repoRoot, "outside.d.ts"),
        "../outside.d.ts",
        "generated/elsewhere/outside.d.ts",
    ]) {
        assert.throws(
            () => resolveManagedOutputPath(
                invalidPath,
                repoRoot,
                manifestPath,
                "firstClassLib.outputFile",
                [generatedRoot],
            ),
            /repo-relative path|managed output root/u,
        );
    }
});

test("managed removal rejects symbolic-link ancestors", async () => {
    const boundaryRoot = createTempDirectory(tempDirectories);
    const managedRoot = path.join(boundaryRoot, "generated", "current");
    const outsideRoot = path.join(boundaryRoot, "outside");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, "sentinel.txt"), "keep\n");
    fs.symlinkSync(outsideRoot, path.join(managedRoot, "linked"), "dir");

    const targetPath = path.join(managedRoot, "linked", "nested");
    assert.ok(isPathWithin(managedRoot, targetPath));
    await assert.rejects(
        removeManagedPath(targetPath, boundaryRoot, [managedRoot], { recursive: true }),
        /symbolic link/u,
    );
    assert.equal(fs.readFileSync(path.join(outsideRoot, "sentinel.txt"), "utf8"), "keep\n");
});
