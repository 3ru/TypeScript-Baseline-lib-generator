// @ts-check

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    renderNegativeProbeSource,
    selectActiveNegativeProbes,
} from "../lib/negative-probes.mjs";
import {
    prepareTypeScriptBaselinePatch,
    renderTypeScriptPatchSummary,
} from "../lib/typescript-upstream.mjs";
import { readStradaSourcePin } from "../lib/typescript-source.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const fixturesRoot = path.join(repoRoot, "fixtures", "typescript");
const defaultSummaryPath = path.join(repoRoot, ".tmp", "typescript-integration-summary.md");
const defaultDiffPath = path.join(repoRoot, ".tmp", "typescript-baseline-changes.diff");
const defaultFocusedBaselinesDirectory = path.join(repoRoot, ".tmp", "typescript-focused-artifact");
const defaultLocalBaselinesDirectory = path.join(repoRoot, ".tmp", "typescript-raw-local-baselines");

const args = parseArgs(process.argv.slice(2));

await main();

async function main() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const patchSummary = prepareTypeScriptBaselinePatch({
        repoRoot,
        typescriptDir: args.typescriptDir,
        fixturesRoot,
        expectedCommit: readStradaSourcePin(manifest).commit,
        allowUnpinned: args.allowUnpinned,
    });
    const integrationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-baseline-ts-integration-"));
    /** @type {ReturnType<typeof runSmokeChecks> | undefined} */
    let smokeResults;
    /** @type {{
     *   targetedHarness?: { ok: boolean; output: string; };
     *   fullSuite?: { ok: boolean; output: string; };
     *   baselineAccept?: { ok: boolean; output: string; };
     *   baselineDiffPath?: string;
     *   focusedBaselinesPath?: string;
     *   localBaselinesPath?: string;
     * }} */
    const extendedResults = {};
    /** @type {unknown} */
    let blockingFailure;
    /** @type {unknown} */
    let failure;

    try {
        try {
            if (!args.skipInstall) {
                installTypeScriptDependencies(patchSummary.typescriptDir);
            }

            runNpm(patchSummary.typescriptDir, ["run", "build:compiler"]);
            smokeResults = runSmokeChecks(patchSummary.typescriptDir, integrationDirectory);

            // gate: blocking checks only (smoke + targeted harness). Meant to run
            //   per PR, so it excludes the TypeScript full-suite diagnostics.
            // full: on top of gate, runs the full suite / baseline-accept / raw
            //   baselines as diagnostics. For push to main, schedule, and dispatch.
            if (args.mode === "gate" || args.mode === "full") {
                runNpm(patchSummary.typescriptDir, ["run", "build:tests"]);
                extendedResults.targetedHarness = runCommandAllowFailure(
                    "npx",
                    ["hereby", "runtests", "--tests=libBaseline", "--light=false"],
                    { cwd: patchSummary.typescriptDir },
                );
                if (!extendedResults.targetedHarness.ok) {
                    blockingFailure = new Error(
                        extendedResults.targetedHarness.output.trim() ||
                            "TypeScript targeted libBaseline harness failed",
                    );
                }
                extendedResults.focusedBaselinesPath = copyFocusedBaselinesArtifact({
                    typescriptDir: patchSummary.typescriptDir,
                    outputDirectory: args.focusedBaselinesOut,
                });
            }

            if (args.mode === "full") {
                extendedResults.fullSuite = runCommandAllowFailure(
                    "npm",
                    ["test"],
                    { cwd: patchSummary.typescriptDir },
                );
                extendedResults.localBaselinesPath = copyLocalBaselinesArtifact({
                    typescriptDir: patchSummary.typescriptDir,
                    outputDirectory: args.localBaselinesOut,
                });
                extendedResults.baselineAccept = runCommandAllowFailure(
                    "npx",
                    ["hereby", "baseline-accept"],
                    { cwd: patchSummary.typescriptDir },
                );
                if (args.baselineDiffOut) {
                    fs.mkdirSync(path.dirname(args.baselineDiffOut), { recursive: true });
                    const diffText = extendedResults.baselineAccept.ok
                        ? execFileSync("git", ["diff"], {
                            cwd: patchSummary.typescriptDir,
                            encoding: "utf8",
                        })
                        : renderUnavailableDiffArtifact({
                            baselineAccept: extendedResults.baselineAccept,
                            focusedBaselinesPath: extendedResults.focusedBaselinesPath,
                            localBaselinesPath: extendedResults.localBaselinesPath,
                            typescriptDir: patchSummary.typescriptDir,
                        });
                    fs.writeFileSync(args.baselineDiffOut, diffText);
                    extendedResults.baselineDiffPath = args.baselineDiffOut;
                }
            }
        }
        catch (error) {
            failure = error;
        }

        const summaryText = renderIntegrationSummary({
            patchSummary,
            smokeResults,
            extendedResults,
            mode: args.mode,
            blockingFailureMessage: blockingFailure ? formatErrorMessage(blockingFailure) : failure ? formatErrorMessage(failure) : undefined,
        });

        fs.mkdirSync(path.dirname(args.summaryOut), { recursive: true });
        fs.writeFileSync(args.summaryOut, summaryText);
        console.log(summaryText.trimEnd());

        if (failure) {
            throw failure;
        }
        if (blockingFailure) {
            throw blockingFailure;
        }
    }
    finally {
        fs.rmSync(integrationDirectory, { recursive: true, force: true });
    }
}

/**
 * @param {string} typescriptDir
 */
function installTypeScriptDependencies(typescriptDir) {
    const installArgs = fs.existsSync(path.join(typescriptDir, "package-lock.json"))
        ? ["ci"]
        : ["install"];
    runNpm(typescriptDir, installArgs);
}

/**
 * @param {string} typescriptDir
 * @param {string} integrationDirectory
 */
function runSmokeChecks(typescriptDir, integrationDirectory) {
    const smokeRoot = path.join(integrationDirectory, "smoke");
    const positiveFlagPath = copySmokeFixture("positive-flag.ts", smokeRoot);
    const negativeProbes = loadActiveNegativeProbes();
    const negativeFlagPath = writeNegativeSmokeFixture(smokeRoot, negativeProbes);
    const tsconfigPath = writeSmokeTsconfig(smokeRoot);
    const localTscPath = path.join(typescriptDir, "built", "local", "tsc.js");

    assert.ok(fs.existsSync(localTscPath), `Expected built local tsc at ${localTscPath}`);

    runCommand(process.execPath, [localTscPath, "--strict", "--noEmit", "--lib", "baseline", positiveFlagPath], {
        cwd: typescriptDir,
    });
    runCommand(process.execPath, [localTscPath, "-p", tsconfigPath], {
        cwd: typescriptDir,
    });

    const negativeResult = runCommandAllowFailure(
        process.execPath,
        [localTscPath, "--strict", "--noEmit", "--lib", "baseline", negativeFlagPath],
        { cwd: typescriptDir },
    );
    assert.equal(negativeResult.ok, false, "Expected negative baseline smoke to fail");
    for (const probe of negativeProbes) {
        assert.match(
            negativeResult.output,
            probe.errorPattern,
            `Expected excluded probe ${probe.compatKey} to fail under --lib baseline`,
        );
    }

    return {
        positiveFlagPath,
        tsconfigPath,
        negativeFlagPath,
    };
}

/**
 * The negative smoke is generated by deriving the currently excluded probes from
 * the checked-in classification. Hardcoded API names would always break on a
 * Baseline promotion date, so we keep no static fixture.
 */
function loadActiveNegativeProbes() {
    /** @type {{ classifiedCompatRows: Array<{ compatKey: string; includeInTarget: boolean; }>; }} */
    const classification = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "derived", "current", "classification.json"), "utf8"),
    );
    return selectActiveNegativeProbes(classification.classifiedCompatRows);
}

/**
 * @param {string} smokeRoot
 * @param {ReturnType<typeof selectActiveNegativeProbes>} negativeProbes
 */
function writeNegativeSmokeFixture(smokeRoot, negativeProbes) {
    const targetPath = path.join(smokeRoot, "negative-flag.ts");
    fs.mkdirSync(smokeRoot, { recursive: true });
    fs.writeFileSync(targetPath, renderNegativeProbeSource(negativeProbes));
    return targetPath;
}

/**
 * @param {"positive-reference.ts" | "positive-flag.ts"} fixtureName
 * @param {string} smokeRoot
 */
function copySmokeFixture(fixtureName, smokeRoot) {
    const sourcePath = path.join(fixturesRoot, "smoke", fixtureName);
    const targetPath = path.join(smokeRoot, fixtureName);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, fs.readFileSync(sourcePath, "utf8"));

    return targetPath;
}

/**
 * @param {string} smokeRoot
 */
function writeSmokeTsconfig(smokeRoot) {
    const tsconfigPath = path.join(smokeRoot, "tsconfig.json");
    fs.mkdirSync(smokeRoot, { recursive: true });
    fs.writeFileSync(
        tsconfigPath,
        `${JSON.stringify({
            compilerOptions: {
                strict: true,
                noEmit: true,
                lib: ["baseline"],
            },
            files: ["positive-flag.ts"],
        }, undefined, 4)}\n`,
    );
    return tsconfigPath;
}

/**
 * @param {{
 *   patchSummary: ReturnType<typeof prepareTypeScriptBaselinePatch>;
 *   smokeResults: ReturnType<typeof runSmokeChecks> | undefined;
 *   extendedResults: {
 *     targetedHarness?: { ok: boolean; output: string; };
     *     fullSuite?: { ok: boolean; output: string; };
     *     baselineAccept?: { ok: boolean; output: string; };
     *     baselineDiffPath?: string;
     *     focusedBaselinesPath?: string;
     *     localBaselinesPath?: string;
     *   };
     *   mode: "smoke" | "gate" | "full";
 *   blockingFailureMessage?: string;
 * }} options
 */
function renderIntegrationSummary(options) {
    const blockingChecksPassed = !options.blockingFailureMessage;
    const lines = [
        "# TypeScript Integration Summary",
        "",
        `- Mode: \`${options.mode}\``,
        `- Blocking integration gate: ${blockingChecksPassed ? "passed" : "failed"}`,
        `- Smoke: ${formatBlockingCheckStatus(Boolean(options.smokeResults), options.blockingFailureMessage)}`,
    ];

    if (options.smokeResults) {
        lines.push(
            `- Positive --lib fixture: \`${options.smokeResults.positiveFlagPath}\``,
            `- Positive tsconfig fixture: \`${options.smokeResults.tsconfigPath}\``,
            `- Negative --lib fixture: \`${options.smokeResults.negativeFlagPath}\``,
        );
    }

    if (options.mode === "gate" || options.mode === "full") {
        lines.push(
            `- Targeted harness test: ${formatBlockingResult(options.extendedResults.targetedHarness)}`,
        );
        if (options.extendedResults.focusedBaselinesPath) {
            lines.push(`- Focused integration artifact: \`${options.extendedResults.focusedBaselinesPath}\``);
        }
    }

    if (options.mode === "full") {
        lines.push(
            `- Full TypeScript suite: ${formatDiagnosticResult(options.extendedResults.fullSuite)}`,
            `- Baseline accept: ${formatDiagnosticResult(options.extendedResults.baselineAccept)}`,
        );
        if (options.extendedResults.localBaselinesPath) {
            lines.push(`- Raw local baselines artifact: \`${options.extendedResults.localBaselinesPath}\``);
        }
        if (options.extendedResults.baselineDiffPath) {
            lines.push(`- Baseline diff artifact: \`${options.extendedResults.baselineDiffPath}\``);
        }
    }

    lines.push(
        "",
        "## Patch",
        "",
        renderTypeScriptPatchSummary(options.patchSummary).trimEnd(),
    );

    if (options.blockingFailureMessage) {
        lines.push(
            "",
            "## Blocking Failure",
            "",
            "```text",
            options.blockingFailureMessage,
            "```",
        );
    }

    if (options.mode === "full") {
        lines.push(
            "",
            "## Diagnostics",
            "",
            `- Targeted harness output: ${summarizeResult(options.extendedResults.targetedHarness)}`,
            `- Full suite output: ${summarizeResult(options.extendedResults.fullSuite)}`,
            `- Baseline accept output: ${summarizeResult(options.extendedResults.baselineAccept)}`,
        );
    }

    return `${lines.join("\n")}\n`;
}

/**
 * @param {{ ok: boolean; output: string; } | undefined} result
 */
function summarizeResult(result) {
    if (!result) {
        return "not run";
    }

    return result.ok ? "passed" : firstNonEmptyLine(result.output) ?? "failed";
}

/**
 * @param {string} output
 */
function firstNonEmptyLine(output) {
    return output
        .split(/\r?\n/u)
        .map(line => line.trim())
        .find(Boolean);
}

/**
 * @param {boolean} ok
 * @param {string | undefined} blockingFailureMessage
 */
function formatBlockingCheckStatus(ok, blockingFailureMessage) {
    if (ok) {
        return "passed (blocking)";
    }
    return blockingFailureMessage ? "failed (blocking)" : "not run";
}

/**
 * @param {{ ok: boolean; output: string; } | undefined} result
 */
function formatBlockingResult(result) {
    if (!result) {
        return "not run";
    }
    return result.ok ? "passed (blocking)" : "failed (blocking)";
}

/**
 * @param {{ ok: boolean; output: string; } | undefined} result
 */
function formatDiagnosticResult(result) {
    if (!result) {
        return "not run";
    }
    return result.ok ? "passed" : "failed (diagnostic)";
}

/**
 * @param {unknown} error
 */
function formatErrorMessage(error) {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }

    return String(error);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{
     *   typescriptDir?: string; allowUnpinned?: boolean;
     *   summaryOut: string;
     *   baselineDiffOut?: string;
     *   focusedBaselinesOut: string;
     *   localBaselinesOut: string;
     *   mode: "smoke" | "gate" | "full";
     *   skipInstall: boolean;
     * }} */
    const args = {
        summaryOut: defaultSummaryPath,
        baselineDiffOut: defaultDiffPath,
        focusedBaselinesOut: defaultFocusedBaselinesDirectory,
        localBaselinesOut: defaultLocalBaselinesDirectory,
        mode: "smoke",
        skipInstall: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--allow-unpinned":
                args.allowUnpinned = true;
                break;
            case "--typescript-dir":
                args.typescriptDir = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--summary-out":
                args.summaryOut = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--baseline-diff-out":
                args.baselineDiffOut = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--focused-baselines-out":
                args.focusedBaselinesOut = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--local-baselines-out":
                args.localBaselinesOut = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--mode": {
                const mode = requireArgValue(argv[++index], current);
                if (mode !== "smoke" && mode !== "gate" && mode !== "full") {
                    throw new Error(`Unsupported integration mode: ${mode}`);
                }
                args.mode = mode;
                break;
            }
            case "--skip-install":
                args.skipInstall = true;
                break;
            case "--help":
            case "-h":
                printUsageAndExit();
                break;
            default:
                throw new Error(`Unknown argument: ${current}`);
        }
    }

    return args;
}

/**
 * @param {string | undefined} value
 * @param {string} flagName
 */
function requireArgValue(value, flagName) {
    if (!value) {
        throw new Error(`Missing value for ${flagName}`);
    }
    return value;
}

function printUsageAndExit() {
    console.log(`Usage:
  node scripts/test-typescript-integration.mjs [--typescript-dir <path>] [--mode <smoke|gate|full>] [--summary-out <path>] [--baseline-diff-out <path>] [--focused-baselines-out <path>] [--local-baselines-out <path>] [--skip-install]

Modes:
  smoke  only --lib baseline smoke with the built local tsc (blocking)
  gate   smoke + targeted libBaseline harness (blocking only, for PRs)
  full   gate + TypeScript full suite / baseline-accept (diagnostic)

Examples:
  node scripts/test-typescript-integration.mjs --typescript-dir ../TypeScript
  node scripts/test-typescript-integration.mjs --typescript-dir ../TypeScript --mode gate
  node scripts/test-typescript-integration.mjs --typescript-dir ../TypeScript --mode full
`);
    process.exit(0);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runNpm(cwd, args) {
    runCommand("npm", args, { cwd });
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string; }} options
 */
function runCommand(file, args, options) {
    execFileSync(file, args, {
        cwd: options.cwd,
        stdio: "inherit",
        env: {
            ...process.env,
            npm_config_yes: "true",
        },
    });
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string; }} options
 */
function runCommandAllowFailure(file, args, options) {
    const result = spawnSync(file, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            npm_config_yes: "true",
        },
    });

    return {
        ok: result.status === 0,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
}

/**
 * @param {{
 *   typescriptDir: string;
 *   outputDirectory: string;
 * }} options
 */
function copyLocalBaselinesArtifact(options) {
    const sourceDirectory = path.join(options.typescriptDir, "tests", "baselines", "local");
    if (!fs.existsSync(sourceDirectory)) {
        return undefined;
    }

    fs.rmSync(options.outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(options.outputDirectory), { recursive: true });
    fs.cpSync(sourceDirectory, options.outputDirectory, { recursive: true });
    return options.outputDirectory;
}

/**
 * @param {{
 *   typescriptDir: string;
 *   outputDirectory: string;
 * }} options
 */
function copyFocusedBaselinesArtifact(options) {
    fs.rmSync(options.outputDirectory, { recursive: true, force: true });
    // Keep a reviewer-sized snapshot of the proposal-specific patch surface.
    fs.mkdirSync(options.outputDirectory, { recursive: true });
    /** @type {string[]} */
    const focusedRelativePaths = [
        path.join("src", "compiler", "commandLineParser.ts"),
        path.join("src", "lib", "baseline.d.ts"),
        path.join("src", "lib", "libs.json"),
        path.join("tests", "cases", "compiler", "libBaseline.ts"),
        path.join("tests", "baselines", "reference", "libBaseline.errors.txt"),
        path.join("tests", "baselines", "reference", "libBaseline.js"),
        path.join("tests", "baselines", "reference", "libBaseline.symbols"),
        path.join("tests", "baselines", "reference", "libBaseline.types"),
    ];

    let copiedFileCount = 0;
    for (const relativePath of focusedRelativePaths) {
        const sourcePath = path.join(options.typescriptDir, relativePath);
        if (!fs.existsSync(sourcePath)) {
            continue;
        }
        const targetPath = path.join(options.outputDirectory, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
        copiedFileCount++;
    }
    return copiedFileCount > 0 ? options.outputDirectory : undefined;
}

/**
 * @param {{
 *   baselineAccept: { ok: boolean; output: string; };
 *   focusedBaselinesPath?: string;
 *   localBaselinesPath?: string;
 *   typescriptDir: string;
 * }} options
 */
function renderUnavailableDiffArtifact(options) {
    const gitStatus = runCommandAllowFailure("git", ["status", "--short"], {
        cwd: options.typescriptDir,
    });

    return [
        "# Accepted Diff Unavailable",
        "",
        "The full TypeScript suite is diagnostic-only in this workflow.",
        "The suite finished, but `hereby baseline-accept` did not succeed, so a post-accept `git diff` artifact could not be produced.",
        "",
        `- Focused integration artifact: ${options.focusedBaselinesPath ?? "not written"}`,
        `- Raw local baselines artifact: ${options.localBaselinesPath ?? "not written"}`,
        `- Git status snapshot: ${gitStatus.ok ? "captured below" : "failed to capture"}`,
        "",
        "## baseline-accept output",
        "",
        "```text",
        options.baselineAccept.output.trim() || "<no output>",
        "```",
        "",
        "## git status --short",
        "",
        "```text",
        gitStatus.output.trim() || "<no output>",
        "```",
        "",
    ].join("\n");
}
