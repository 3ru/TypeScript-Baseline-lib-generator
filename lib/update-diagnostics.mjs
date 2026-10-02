// @ts-check

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCompatFeatureMemberships } from "./compat-rows.mjs";
import { compareStringsCaseSensitive } from "./shared.mjs";

const manifestPath = "manifests/baseline-js.json";
const datasetPath = "datasets/web-features-js-compat.json";

/**
 * Keep the command's failure blocking while saving its output for the update report.
 * @param {{ cwd: string; outputDirectory: string; step: string; command: string; args: string[]; }} options
 */
export async function runRecordedUpdateStep(options) {
    if (!/^[a-z][a-z0-9-]*$/u.test(options.step)) {
        throw new Error(`Invalid update step name: ${options.step}`);
    }
    fs.mkdirSync(options.outputDirectory, { recursive: true });
    const logPath = path.join(options.outputDirectory, `${options.step}.log`);
    const resultPath = path.join(options.outputDirectory, `${options.step}.json`);
    fs.writeFileSync(logPath, "");
    const startedAt = new Date().toISOString();
    /** @type {{ code: number | null; signal: NodeJS.Signals | null; error?: string; }} */
    const result = await new Promise(resolve => {
        const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
        /** @param {Buffer} chunk */
        const record = chunk => {
            fs.appendFileSync(logPath, chunk);
            process.stdout.write(chunk);
        };
        child.stdout.on("data", record);
        child.stderr.on("data", record);
        child.on("error", error => {
            record(Buffer.from(`${error.message}\n`));
            resolve({ code: null, signal: null, error: error.message });
        });
        child.on("close", (code, signal) => resolve({ code, signal }));
    });
    const exitCode = result.code ?? 1;
    fs.writeFileSync(resultPath, `${JSON.stringify({
        step: options.step,
        command: [options.command, ...options.args],
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal: result.signal,
        error: result.error,
        logFile: path.basename(logPath),
    }, undefined, 2)}\n`);
    return exitCode;
}

/**
 * Read inputs independently of generation: derived files may still describe HEAD
 * after a failed update, so they are deliberately absent from this report.
 * @param {{ cwd: string; outputDirectory: string; steps?: Record<string, { outcome?: string; }>; }} options
 */
export function writeUpdateDiagnostics(options) {
    fs.mkdirSync(options.outputDirectory, { recursive: true });
    /** @type {string[]} */
    const readErrors = [];
    /** @param {string} relativePath @param {boolean} previous */
    const readInput = (relativePath, previous) => {
        try {
            const text = previous
                ? execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 })
                : fs.readFileSync(path.join(options.cwd, relativePath), "utf8");
            return JSON.parse(text);
        }
        catch (error) {
            readErrors.push(`${previous ? "HEAD" : "Working tree"} ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };
    const previousManifest = readInput(manifestPath, true);
    const currentManifest = readInput(manifestPath, false);
    const previousPackage = readInput("package.json", true);
    const currentPackage = readInput("package.json", false);
    const previousDataset = readInput(datasetPath, true);
    const currentDataset = readInput(datasetPath, false);
    let dataset;
    try {
        dataset = compareDatasetInputs(previousDataset, currentDataset);
    }
    catch (error) {
        readErrors.push(`Dataset comparison: ${error instanceof Error ? error.message : String(error)}`);
    }
    const commands = fs.readdirSync(options.outputDirectory)
        .filter(name => name.endsWith(".json") && name !== "summary.json")
        .map(name => JSON.parse(fs.readFileSync(path.join(options.outputDirectory, name), "utf8")))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const failedSteps = Object.entries(options.steps ?? {})
        .filter(([, step]) => step.outcome === "failure" || step.outcome === "cancelled")
        .map(([step, value]) => ({ step, outcome: value.outcome }));
    const summary = {
        status: failedSteps.length || commands.some(command => command.exitCode !== 0)
            ? "failed"
            : readErrors.length || !commands.length ? "incomplete" : "passed",
        failedSteps,
        commands,
        inputs: {
            previous: { dependencies: previousPackage?.dependencies, snapshot: previousManifest?.snapshot, typescriptSource: previousManifest?.typescriptSource },
            candidate: { dependencies: currentPackage?.dependencies, snapshot: currentManifest?.snapshot, typescriptSource: currentManifest?.typescriptSource },
        },
        dataset,
        readErrors,
    };
    const lines = [
        "# Update diagnostics",
        "",
        `Update checks: ${summary.status}.`,
        "",
        "These are candidate inputs. A failed update does not validate or publish generated declarations.",
        "",
        ...failedSteps.map(step => `- Workflow step \`${step.step}\`: ${step.outcome}.`),
        ...commands.map(command => `- \`${command.step}\`: exit ${command.exitCode}; log: \`${command.logFile}\`.`),
        "",
        "## Input pins",
        "",
        "```json",
        JSON.stringify(summary.inputs, undefined, 2),
        "```",
        "",
        "## Dataset changes",
        "",
        summary.dataset
            ? `${summary.dataset.added.length} added, ${summary.dataset.removed.length} removed, ${summary.dataset.changed.length} changed compat keys.`
            : "Dataset comparison unavailable. See the input read errors below.",
        "",
        ...(summary.dataset ? [
            ...summary.dataset.added.map(key => `- Added: \`${key}\`.`),
            ...summary.dataset.removed.map(key => `- Removed: \`${key}\`.`),
            ...summary.dataset.changed.map(key => `- Changed: \`${key}\`.`),
        ] : []),
    ];
    for (const command of commands.filter(command => command.exitCode !== 0)) {
        const log = fs.readFileSync(path.join(options.outputDirectory, command.logFile), "utf8");
        lines.push("", `## ${command.step} failure`, "", "```text", log.trimEnd().split(/\r?\n/u).slice(-120).join("\n").replaceAll("```", "'''"), "```");
    }
    if (readErrors.length) {
        lines.push("", "## Input read errors", "", ...readErrors.map(error => `- ${error}`));
    }
    if (summary.status === "failed") {
        lines.push("", "## Recovery", "",
            "Inspect the failed step's log in this artifact. For registry drift, review the named compat keys and their upstream declarations before editing registry/compat-management.json. For an upstream layout error, update the TypeScript adapter and its fixtures.",
            "",
            "Run npm run validate after the repair. TypeScript source updates also require npm run test:typescript:gate against the candidate commit. Rerun the update workflow before merging its pull request.");
    }
    const markdown = `${lines.join("\n")}\n`;
    fs.writeFileSync(path.join(options.outputDirectory, "summary.json"), `${JSON.stringify(summary, undefined, 2)}\n`);
    fs.writeFileSync(path.join(options.outputDirectory, "summary.md"), markdown);
    return { summary, markdown };
}

/** @param {any} previous @param {any} current */
function compareDatasetInputs(previous, current) {
    if (!Array.isArray(previous?.compatRows) || !Array.isArray(current?.compatRows)) {
        return undefined;
    }
    /** @param {any[]} rows */
    const index = rows => {
        /** @type {Map<string, string[]>} */
        const grouped = new Map();
        for (const row of rows) {
            const values = grouped.get(row.compatKey) ?? [];
            values.push(JSON.stringify({
                baselineStatus: row.baselineStatus,
                baselineLowDate: row.baselineLowDate,
                baselineHighDate: row.baselineHighDate,
                featureMemberships: getCompatFeatureMemberships(row)
                    .map(membership => ({
                        featureId: membership.featureId,
                        featureName: membership.featureName,
                        snapshot: [...membership.snapshot].sort(compareStringsCaseSensitive),
                        group: [...membership.group].sort(compareStringsCaseSensitive),
                    }))
                    .sort((left, right) => compareStringsCaseSensitive(left.featureId, right.featureId)),
            }));
            grouped.set(row.compatKey, values);
        }
        return new Map([...grouped].map(([key, values]) => [key, JSON.stringify(values.sort())]));
    };
    const before = index(previous.compatRows);
    const after = index(current.compatRows);
    return {
        added: [...after.keys()].filter(key => !before.has(key)).sort(),
        removed: [...before.keys()].filter(key => !after.has(key)).sort(),
        changed: [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)).sort(),
    };
}
