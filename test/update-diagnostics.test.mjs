// @ts-check

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { writeUpdateDiagnostics } from "../lib/update-diagnostics.mjs";
import { cleanupTempDirectories, createTempDirectory, repoRoot, writeJsonFile } from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => cleanupTempDirectories(tempDirectories));

test("a failed update keeps its exit code and reports candidate inputs without reading stale generated reports", () => {
    const cwd = createTempDirectory(tempDirectories);
    const outputDirectory = path.join(cwd, ".tmp", "update-diagnostics");
    const manifestPath = path.join(cwd, "manifests", "baseline-js.json");
    const datasetPath = path.join(cwd, "datasets", "web-features-js-compat.json");
    writeJsonFile(path.join(cwd, "package.json"), { dependencies: { "web-features": "1.0.0" } });
    writeJsonFile(manifestPath, { snapshot: { webFeaturesPackageVersion: "1.0.0" } });
    writeJsonFile(datasetPath, { compatRows: [
        { compatKey: "javascript.builtins.Known", featureId: "known", featureName: "Known", baselineStatus: "low" },
        { compatKey: "javascript.builtins.Removed", featureId: "removed", featureName: "Removed", baselineStatus: false },
    ] });
    commitInputs(cwd);
    writeJsonFile(manifestPath, { snapshot: { webFeaturesPackageVersion: "2.0.0" } });
    writeJsonFile(path.join(cwd, "package.json"), { dependencies: { "web-features": "2.0.0" } });
    writeJsonFile(datasetPath, { compatRows: [
        { compatKey: "javascript.builtins.Known", featureId: "known", featureName: "Known", baselineStatus: "high" },
        { compatKey: "javascript.builtins.Known", featureId: "other-feature", featureName: "Other", baselineStatus: "high" },
        { compatKey: "javascript.builtins.New", featureId: "new", featureName: "New", baselineStatus: false },
    ] });
    const derivedDirectory = path.join(cwd, "derived", "current");
    fs.mkdirSync(derivedDirectory, { recursive: true });
    fs.writeFileSync(path.join(derivedDirectory, "generation.json"), "not a current generation report");

    const failure = runDiagnostics(cwd, ["run", "generate", "--", process.execPath, "-e", "console.error('Special compat keys missing registry metadata: javascript.builtins.New'); process.exit(17)"]);
    assert.equal(failure.status, 17);
    const { summary, markdown } = writeUpdateDiagnostics({ cwd, outputDirectory, steps: { generate: { outcome: "failure" }, test: { outcome: "skipped" } } });
    assert.equal(summary.status, "failed");
    assert.equal(summary.commands[0].exitCode, 17);
    assert.equal(summary.inputs.previous.snapshot.webFeaturesPackageVersion, "1.0.0");
    assert.equal(summary.inputs.candidate.snapshot.webFeaturesPackageVersion, "2.0.0");
    assert.equal(summary.inputs.candidate.dependencies["web-features"], "2.0.0");
    assert.deepEqual(summary.dataset, {
        added: ["javascript.builtins.New"],
        removed: ["javascript.builtins.Removed"],
        changed: ["javascript.builtins.Known"],
    });
    assert.deepEqual(summary.readErrors, []);
    assert.match(markdown, /Special compat keys missing registry metadata/u);
    assert.match(markdown, /registry\/compat-management\.json/u);
    assert.match(markdown, /does not validate or publish/u);
    assert.ok(fs.existsSync(path.join(outputDirectory, "summary.json")));
    assert.ok(fs.existsSync(path.join(outputDirectory, "generate.log")));
});

test("an unavailable executable still leaves a failed command record", () => {
    const cwd = createTempDirectory(tempDirectories);
    const failure = runDiagnostics(cwd, ["run", "install", "--", path.join(cwd, "missing-command")]);
    assert.equal(failure.status, 1);
    const result = JSON.parse(fs.readFileSync(path.join(cwd, ".tmp", "update-diagnostics", "install.json"), "utf8"));
    assert.equal(result.exitCode, 1);
    assert.match(result.error, /ENOENT/u);
});

test("command capture applies backpressure and preserves all output before recording exit", { timeout: 10_000 }, async () => {
    const cwd = createTempDirectory(tempDirectories);
    const markerPath = path.join(cwd, "output-finished");

    const child = spawn(process.execPath, [path.join(repoRoot, "scripts/update-diagnostics.mjs"), "run", "large-output", "--", process.execPath, "-e", `
        const fs = require('node:fs');
        const chunk = Buffer.alloc(64 * 1024, 'x');
        let remaining = 64;
        function write() {
            while (remaining > 0) {
                remaining--;
                if (!process.stdout.write(chunk)) {
                    process.stdout.once('drain', write);
                    return;
                }
            }
            fs.writeFileSync(${JSON.stringify(markerPath)}, 'done');
            process.exitCode = 23;
        }
        write();
    `], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const completion = once(child, "close");

    try {
        await once(child.stdout, "readable");
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(fs.existsSync(markerPath), false, "producer must wait while the console consumer is paused");
        let outputBytes = 0;
        child.stdout.on("data", chunk => { outputBytes += chunk.length; });
        child.stdout.resume();
        const [exitCode] = await completion;
        assert.equal(exitCode, 23);
        assert.equal(outputBytes, 4 * 1024 * 1024);
        const outputDirectory = path.join(cwd, ".tmp/update-diagnostics");
        assert.equal(fs.statSync(path.join(outputDirectory, "large-output.log")).size, outputBytes);
        const record = JSON.parse(fs.readFileSync(path.join(outputDirectory, "large-output.json"), "utf8"));
        assert.equal(record.exitCode, 23);
    }
    finally {
        child.kill();
        child.stdout.resume();
        child.stderr.resume();
        await completion;
    }
});

test("a log write failure stops the command and remains a blocking result", () => {
    const cwd = createTempDirectory(tempDirectories);
    const outputDirectory = path.join(cwd, ".tmp/update-diagnostics");
    fs.mkdirSync(path.join(outputDirectory, "generate.log"), { recursive: true });
    const failure = runDiagnostics(cwd, ["run", "generate", "--", process.execPath, "-e", "console.log('starting'); setTimeout(() => { process.exitCode = 17; }, 1000)"]);
    assert.equal(failure.status, 1);
    const record = JSON.parse(fs.readFileSync(path.join(outputDirectory, "generate.json"), "utf8"));
    assert.equal(record.exitCode, 1);
    assert.match(record.error, /EISDIR/u);
});

test("incomplete command artifacts retain the other failure logs and a bounded log tail", () => {
    const cwd = createTempDirectory(tempDirectories);
    const outputDirectory = path.join(cwd, ".tmp/update-diagnostics");
    const failure = runDiagnostics(cwd, ["run", "generate", "--", process.execPath, "-e", "process.exitCode = 17"]);
    assert.equal(failure.status, 17);
    const command = JSON.parse(fs.readFileSync(path.join(outputDirectory, "generate.json"), "utf8"));
    fs.writeFileSync(path.join(outputDirectory, "generate.log"), `${"x".repeat(2 * 1024 * 1024)}\n${Array.from({ length: 200 }, (_, index) => `Failure line ${index}`).join("\n")}\n`);
    fs.writeFileSync(path.join(outputDirectory, "interrupted.json"), "{");
    writeJsonFile(path.join(outputDirectory, "missing.json"), { ...command, step: "missing", logFile: "missing.log" });
    writeJsonFile(path.join(outputDirectory, "invalid.json"), { ...command, logFile: "../outside.log" });

    const { summary, markdown } = writeUpdateDiagnostics({ cwd, outputDirectory });
    assert.equal(summary.status, "failed");
    assert.equal(summary.commands.length, 2);
    assert.ok(summary.readErrors.some(error => error.startsWith("Command record interrupted.json:")));
    assert.ok(summary.readErrors.some(error => error.startsWith("Command record invalid.json:")));
    assert.ok(summary.readErrors.some(error => error.startsWith("Command log missing.log:")));
    assert.match(markdown, /Log truncated to the last 64 KiB/u);
    assert.match(markdown, /Failure line 199/u);
    assert.doesNotMatch(markdown, /Failure line 79\n/u);
    assert.ok(markdown.length < 70 * 1024);
    assert.ok(fs.existsSync(path.join(outputDirectory, "summary.json")));
});

test("setup failures produce a report even when no command ran and candidate inputs are missing", () => {
    const cwd = createTempDirectory(tempDirectories);
    execFileSync("git", ["init", "--quiet"], { cwd });
    const summaryPath = path.join(cwd, "github-summary.md");

    const result = runDiagnostics(cwd, ["report"], {
        UPDATE_WORKFLOW_STEPS: JSON.stringify({ "setup-node": { outcome: "failure" } }),
        GITHUB_STEP_SUMMARY: summaryPath,
    });

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(cwd, ".tmp", "update-diagnostics", "summary.json"), "utf8"));
    assert.equal(summary.status, "failed");
    assert.deepEqual(summary.failedSteps, [{ step: "setup-node", outcome: "failure" }]);
    assert.equal(summary.readErrors.length, 6);
    assert.match(fs.readFileSync(summaryPath, "utf8"), /Dataset comparison unavailable/u);
});

test("diagnostics track secondary feature memberships and retain failure logs for malformed candidates", () => {
    const cwd = createTempDirectory(tempDirectories);
    const outputDirectory = path.join(cwd, ".tmp", "update-diagnostics");
    const datasetPath = path.join(cwd, "datasets", "web-features-js-compat.json");
    const first = { featureId: "first", featureName: "First", snapshot: ["es2020"], group: ["group-a", "group-b"] };
    const second = { featureId: "second", featureName: "Second", snapshot: ["es2021"], group: ["group-c"] };
    const third = { ...second, featureId: "third", featureName: "Third" };

    const row = {
        compatKey: "javascript.builtins.Known",
        ...first,
        baselineStatus: "high",
        featureMemberships: [first, second],
    };

    writeJsonFile(path.join(cwd, "package.json"), { dependencies: {} });
    writeJsonFile(path.join(cwd, "manifests", "baseline-js.json"), { snapshot: {} });
    writeJsonFile(datasetPath, { compatRows: [row] });
    commitInputs(cwd);

    for (const featureMemberships of [
        [first, second, third],
        [first, third],
        [first, { ...second, featureName: "Renamed" }],
        [first, { ...second, snapshot: ["es2022"] }],
        [first, { ...second, group: ["other-group"] }],
        undefined,
    ]) {
        writeJsonFile(datasetPath, { compatRows: [{ ...row, featureMemberships }] });
        const { summary } = writeUpdateDiagnostics({ cwd, outputDirectory });
        assert.deepEqual(summary.dataset?.changed, [row.compatKey]);
    }

    writeJsonFile(datasetPath, { compatRows: [{ ...row, featureMemberships: [second, { ...first, group: [...first.group].reverse() }] }] });
    assert.deepEqual(writeUpdateDiagnostics({ cwd, outputDirectory }).summary.dataset?.changed, []);

    writeJsonFile(datasetPath, { compatRows: [{ ...row, featureMemberships: [first, { ...second, snapshot: null }] }] });
    assert.equal(runDiagnostics(cwd, ["run", "generate", "--", process.execPath, "-e", "console.error('candidate rejected'); process.exit(2)"]).status, 2);
    const { summary, markdown } = writeUpdateDiagnostics({ cwd, outputDirectory });
    assert.equal(summary.status, "failed");
    assert.equal(summary.dataset, undefined);
    assert.match(summary.readErrors.join("\n"), /feature membership snapshot must be an array of strings/u);
    assert.match(markdown, /candidate rejected/u);
});

test("malformed dataset inputs make a successful command report incomplete", () => {
    const cwd = createTempDirectory(tempDirectories);
    const outputDirectory = path.join(cwd, ".tmp/update-diagnostics");
    const datasetPath = path.join(cwd, "datasets/web-features-js-compat.json");
    writeJsonFile(path.join(cwd, "package.json"), { dependencies: {} });
    writeJsonFile(path.join(cwd, "manifests/baseline-js.json"), { snapshot: {} });
    writeJsonFile(datasetPath, { compatRows: [] });
    commitInputs(cwd);
    assert.equal(runDiagnostics(cwd, ["run", "install", "--", process.execPath, "-e", "process.exitCode = 0"]).status, 0);

    for (const candidate of [
        null,
        {},
        { compatRows: [{ compatKey: "javascript.builtins.Known", featureId: "known", baselineStatus: "high" }] },
    ]) {
        writeJsonFile(datasetPath, candidate);
        const { summary } = writeUpdateDiagnostics({ cwd, outputDirectory });
        assert.equal(summary.status, "incomplete");
        assert.equal(summary.dataset, undefined);
        assert.equal(summary.readErrors.length, 1);
        assert.match(summary.readErrors[0], /^Dataset comparison:/u);
    }
});

test("update workflows keep checks blocking and collect candidate diagnostics before creating a pull request", () => {
    for (const name of ["weekly-update.yml", "typescript-update.yml"]) {
        const workflow = parse(fs.readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8"));
        /** @type {Array<{ id?: string; run?: string; if?: string; uses?: string; with?: { path?: string; "include-hidden-files"?: boolean; }; "continue-on-error"?: boolean; }>} */
        const steps = workflow.jobs.update.steps;
        const reportIndex = steps.findIndex(step => step.run === "node scripts/update-diagnostics.mjs report");
        const pullRequestIndex = steps.findIndex(step => step.id === "pull-request");
        const upload = steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
        assert.ok(reportIndex >= 0 && pullRequestIndex > reportIndex);
        assert.equal(steps[reportIndex].if, "always()");
        assert.equal(upload?.if, "always()");
        assert.equal(upload?.with?.path, ".tmp/update-diagnostics");
        assert.equal(upload?.with?.["include-hidden-files"], true);
        assert.equal(steps[pullRequestIndex].if, undefined);

        for (const step of steps.filter(step => step.run?.includes("update-diagnostics.mjs run"))) {
            assert.ok(steps.indexOf(step) < reportIndex, `${name}: ${step.id} runs after diagnostics`);
            assert.equal(step["continue-on-error"], undefined);
        }
    }
});

/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [environment] */
function runDiagnostics(cwd, args, environment = {}) {
    return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "update-diagnostics.mjs"), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...environment },
    });
}

/** @param {string} cwd */
function commitInputs(cwd) {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["add", "manifests", "datasets", "package.json"], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"], { cwd });
}
