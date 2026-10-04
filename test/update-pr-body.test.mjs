// @ts-check

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanupTempDirectories, createTempDirectory, repoRoot, writeJsonFile } from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => cleanupTempDirectories(tempDirectories));

test("the update PR CLI reads repo-relative reports and retains large previous reports", () => {
    const cwd = createUpdateRepository();
    const classificationPath = path.join(cwd, "derived/current/classification.json");
    const classification = JSON.parse(fs.readFileSync(classificationPath, "utf8"));
    classification.padding = "x".repeat(1024 * 1024);
    writeJsonFile(classificationPath, classification);
    commitInputs(cwd);
    classification.summary.includedCompatCount += 1;
    writeJsonFile(classificationPath, classification);

    const result = runUpdateBody(cwd);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(cwd, ".tmp/update.json"), "utf8"));
    assert.equal(summary.deltas.includedCompatCount, 1);
    assert.equal(summary.previousState.classification.padding.length, 1024 * 1024);
    assert.match(fs.readFileSync(path.join(cwd, ".tmp/update.md"), "utf8"), /Included high rows: \d+ \(\+1\)/u);
});

test("the update PR CLI rejects invalid refs and missing reports instead of inventing an initial snapshot", () => {
    const cwd = createUpdateRepository();
    commitInputs(cwd);
    const invalidRef = runUpdateBody(cwd, ["--base-ref", "missing-update-base"]);
    assert.notEqual(invalidRef.status, 0);
    assert.match(invalidRef.stderr, /missing-update-base/u);
    assert.equal(fs.existsSync(path.join(cwd, ".tmp/update.json")), false);

    execFileSync("git", ["rm", "--cached", "derived/current/generation.json"], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Remove previous report"], { cwd });
    const missingReport = runUpdateBody(cwd);
    assert.notEqual(missingReport.status, 0);
    assert.match(missingReport.stderr, /derived\/current\/generation\.json/u);
    assert.equal(fs.existsSync(path.join(cwd, ".tmp/update.json")), false);
});

test("a valid base commit without a manifest is an initial snapshot", () => {
    const cwd = createUpdateRepository();
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "--quiet", "-m", "Initial commit"], { cwd });
    const result = runUpdateBody(cwd);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(cwd, ".tmp/update.json"), "utf8"));
    assert.equal(summary.previousManifest, undefined);
    assert.equal(summary.deltas.includedCompatCount, undefined);
});

function createUpdateRepository() {
    const cwd = createTempDirectory(tempDirectories);

    for (const relativePath of [
        "scripts/write-update-pr-body.mjs",
        "lib/year-contracts.mjs",
        "lib/shared.mjs",
        "manifests/baseline-js.json",
        "derived/current/classification.json",
        "derived/current/generation.json",
        "derived/current/compat-management-report.json",
    ]) {
        const destination = path.join(cwd, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, relativePath), destination);
    }

    execFileSync("git", ["init", "--quiet"], { cwd });

    return cwd;
}

/** @param {string} cwd */
function commitInputs(cwd) {
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Snapshot"], { cwd });
}

/** @param {string} cwd @param {string[]} args */
function runUpdateBody(cwd, args = []) {
    return spawnSync(process.execPath, [
        path.join(cwd, "scripts/write-update-pr-body.mjs"),
        "--out", path.join(cwd, ".tmp/update.md"),
        "--summary-out", path.join(cwd, ".tmp/update.json"),
        ...args,
    ], { cwd, encoding: "utf8" });
}
