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
    prepareTypeScriptGoBaselinePatch,
    renderTypeScriptGoPatchSummary,
} from "../lib/typescript-go-upstream.mjs";
import { readTypeScriptGoSourcePin } from "../lib/typescript-source.mjs";

// Authoritative gate that verifies `tsgo --lib baseline` runs self-consistently
// with the baseline lib built into microsoft/typescript-go (TypeScript 7).
// It needs the Go toolchain, so it stays out of the normal `npm test` and runs in
// a dedicated workflow or a local Go environment. Assumes a pinned go clone + submodule.

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const generatedLibPath = path.join(repoRoot, "generated", "current", "baseline.d.ts");
const positiveFixturePath = path.join(repoRoot, "fixtures", "typescript", "smoke", "positive-flag.ts");

const args = parseArgs(process.argv.slice(2));

main();

function main() {
    if (!args.typescriptGoDir) {
        throw new Error("Missing --typescript-go-dir");
    }
    assertGoAvailable();

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const typescriptGoDir = path.resolve(args.typescriptGoDir);

    const patchSummary = prepareTypeScriptGoBaselinePatch({
        repoRoot,
        typescriptGoDir,
        generatedLibPath,
        expectedCommit: readTypeScriptGoSourcePin(manifest).commit,
        allowUnpinned: args.allowUnpinned,
    });
    console.log(renderTypeScriptGoPatchSummary(patchSummary).trimEnd());

    // Regenerate the generated files (libs_generated.go / embed_generated.go) via the upstream mechanism.
    runGo(typescriptGoDir, ["generate", "./internal/bundled/"]);

    const tsgoBinary = path.join(typescriptGoDir, process.platform === "win32" ? "tsgo.exe" : "tsgo");
    runGo(typescriptGoDir, ["build", "-o", tsgoBinary, "./cmd/tsgo"]);
    assert.ok(fs.existsSync(tsgoBinary), `Expected built tsgo at ${tsgoBinary}`);

    const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-baseline-go-smoke-"));
    try {
        runSmokeChecks(tsgoBinary, smokeRoot);
    }
    finally {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
    }

    const summaryText = [
        "# TypeScript Go Integration Summary",
        "",
        `- typescript-go clone: \`${typescriptGoDir}\``,
        `- tsgo binary: \`${tsgoBinary}\``,
        "- go generate: ok",
        "- go build: ok",
        "- Positive `--lib baseline` smoke: passed",
        "- Negative `--lib baseline` smoke: passed",
    ].join("\n");
    if (args.out) {
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, `${summaryText}\n`);
    }
    console.log(`\n${summaryText}`);
}

/**
 * @param {string} tsgoBinary
 * @param {string} smokeRoot
 */
function runSmokeChecks(tsgoBinary, smokeRoot) {
    const positiveTargetPath = path.join(smokeRoot, "positive-flag.ts");
    fs.copyFileSync(positiveFixturePath, positiveTargetPath);

    const negativeProbes = loadActiveNegativeProbes();
    const negativeTargetPath = path.join(smokeRoot, "negative-flag.ts");
    fs.writeFileSync(negativeTargetPath, renderNegativeProbeSource(negativeProbes));

    // Positive: Baseline high APIs pass under --lib baseline.
    const positive = runTsgoAllowFailure(tsgoBinary, ["--strict", "--noEmit", "--lib", "baseline", positiveTargetPath]);
    assert.ok(positive.ok, `Expected positive baseline smoke to pass:\n${positive.output}`);

    // Negative: currently excluded APIs become type errors.
    const negative = runTsgoAllowFailure(tsgoBinary, ["--strict", "--noEmit", "--lib", "baseline", negativeTargetPath]);
    assert.equal(negative.ok, false, "Expected negative baseline smoke to fail under tsgo --lib baseline");
    for (const probe of negativeProbes) {
        assert.match(
            negative.output,
            probe.errorPattern,
            `Expected excluded probe ${probe.compatKey} to fail under tsgo --lib baseline`,
        );
    }
}

function loadActiveNegativeProbes() {
    /** @type {{ classifiedCompatRows: Array<{ compatKey: string; includeInTarget: boolean; }>; }} */
    const classification = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "derived", "current", "classification.json"), "utf8"),
    );
    return selectActiveNegativeProbes(classification.classifiedCompatRows);
}

function assertGoAvailable() {
    const result = spawnSync("go", ["version"], { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error("`go` toolchain is required for the typescript-go integration gate but was not found on PATH");
    }
    console.log(result.stdout.trim());
}

/**
 * @param {string} cwd
 * @param {string[]} goArgs
 */
function runGo(cwd, goArgs) {
    execFileSync("go", goArgs, { cwd, stdio: "inherit" });
}

/**
 * @param {string} tsgoBinary
 * @param {string[]} tsgoArgs
 */
function runTsgoAllowFailure(tsgoBinary, tsgoArgs) {
    const result = spawnSync(tsgoBinary, tsgoArgs, { encoding: "utf8" });
    return {
        ok: result.status === 0,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ typescriptGoDir?: string; out?: string; allowUnpinned?: boolean; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--typescript-go-dir":
                args.typescriptGoDir = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--out":
                args.out = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--allow-unpinned":
                args.allowUnpinned = true;
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
  node scripts/test-typescript-go-integration.mjs --typescript-go-dir <path> [--out <path>] [--allow-unpinned]

Requires the Go toolchain and a typescript-go checkout with its _submodules/TypeScript submodule initialized.
`);
    process.exit(0);
}
