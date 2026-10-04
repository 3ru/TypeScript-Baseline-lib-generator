// @ts-check

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { getCompatFeatureMemberships, parseCompatRow } from "./compat-rows.mjs";
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
    const log = fs.createWriteStream(logPath);
    const startedAt = new Date().toISOString();
    const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

    for (const stream of [child.stdout, child.stderr]) {
        stream.pipe(log, { end: false });
        stream.pipe(process.stdout, { end: false });
    }

    /** @type {Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string; }>} */
    const completion = new Promise(resolve => {
        /** @type {string | undefined} */
        let startError;
        child.on("error", error => {
            startError = error.stack ?? error.message;
            log.write(`${startError}\n`);
            process.stdout.write(`${startError}\n`);
        });
        child.on("close", (code, signal) => {
            log.end();
            resolve({ code, signal, error: startError });
        });
    });

    const result = await Promise.all([completion, finished(log)])
        .then(([result]) => result)
        .catch(async error => {
            child.kill();
            child.stdout.destroy();
            child.stderr.destroy();
            const result = await completion;

            return { ...result, code: 1, error: error instanceof Error ? error.stack ?? error.message : String(error) };
        });

    const exitCode = result.error ? 1 : result.code ?? 1;
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

    const commands = [];

    for (const name of fs.readdirSync(options.outputDirectory)) {
        if (!name.endsWith(".json") || name === "summary.json") {
            continue;
        }

        try {
            commands.push(parseCommandRecord(JSON.parse(fs.readFileSync(path.join(options.outputDirectory, name), "utf8"))));
        }
        catch (error) {
            readErrors.push(`Command record ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    commands.sort((left, right) => compareStringsCaseSensitive(left.startedAt, right.startedAt));

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
        try {
            const log = readLogTail(path.join(options.outputDirectory, command.logFile));
            lines.push("", `## ${command.step} failure`, "", "```text", log.replaceAll("```", "'''"), "```");
        }
        catch (error) {
            readErrors.push(`Command log ${command.logFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
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

/** @param {unknown} value */
function parseCommandRecord(value) {
    if (!value || typeof value !== "object"
        || !("step" in value) || !("command" in value) || !("startedAt" in value)
        || !("finishedAt" in value) || !("exitCode" in value) || !("signal" in value)
        || !("logFile" in value)) {
        throw new Error("Invalid command record");
    }

    const { step, command, startedAt, finishedAt, exitCode, signal, logFile } = value;
    const error = "error" in value ? value.error : undefined;

    if (typeof step !== "string" || !/^[a-z][a-z0-9-]*$/u.test(step)
        || !Array.isArray(command) || !command.length
        || typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))
        || typeof finishedAt !== "string" || !Number.isFinite(Date.parse(finishedAt))
        || typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0
        || (signal !== null && typeof signal !== "string")
        || (error !== undefined && typeof error !== "string")
        || typeof logFile !== "string" || logFile !== `${step}.log`) {
        throw new Error("Invalid command record fields");
    }

    const parsedCommand = [];

    for (const argument of command) {
        if (typeof argument !== "string") {
            throw new Error("Invalid command argument");
        }

        parsedCommand.push(argument);
    }

    return { step, command: parsedCommand, startedAt, finishedAt, exitCode, signal, error, logFile };
}

/** @param {string} logPath */
function readLogTail(logPath) {
    const descriptor = fs.openSync(logPath, "r");

    try {
        const size = fs.fstatSync(descriptor).size;
        const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
        const text = buffer.toString("utf8", 0, bytesRead).trimEnd().split(/\r?\n/u).slice(-120).join("\n");

        return size > buffer.length ? `[Log truncated to the last 64 KiB.]\n${text}` : text;
    }
    finally {
        fs.closeSync(descriptor);
    }
}

/** @param {unknown} previous @param {unknown} current */
function compareDatasetInputs(previous, current) {
    if (previous === undefined || current === undefined) {
        return undefined;
    }

    /** @param {unknown} dataset */
    const index = dataset => {
        if (!dataset || typeof dataset !== "object" || !("compatRows" in dataset) || !Array.isArray(dataset.compatRows)) {
            throw new Error("Dataset must contain a compatRows array");
        }

        /** @type {Map<string, string[]>} */
        const grouped = new Map();

        for (const value of dataset.compatRows) {
            const row = parseCompatRow(value);
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

    const before = index(previous);
    const after = index(current);

    return {
        added: [...after.keys()].filter(key => !before.has(key)).sort(),
        removed: [...before.keys()].filter(key => !after.has(key)).sort(),
        changed: [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)).sort(),
    };
}
