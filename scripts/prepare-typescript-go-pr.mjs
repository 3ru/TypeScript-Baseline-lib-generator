// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    prepareTypeScriptGoBaselinePatch,
    renderTypeScriptGoPatchSummary,
} from "../lib/typescript-go-upstream.mjs";
import { readTypeScriptGoSourcePin } from "../lib/typescript-source.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const defaultSummaryPath = path.join(repoRoot, ".tmp", "typescript-go-pr-summary.md");

const args = parseArgs(process.argv.slice(2));

main();

function main() {
    if (!args.typescriptGoDir) {
        throw new Error("Missing --typescript-go-dir");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const summary = prepareTypeScriptGoBaselinePatch({
        repoRoot,
        typescriptGoDir: args.typescriptGoDir,
        expectedCommit: readTypeScriptGoSourcePin(manifest).commit,
        allowUnpinned: args.allowUnpinned,
    });
    const summaryText = renderTypeScriptGoPatchSummary(summary);

    const outPath = args.out ?? defaultSummaryPath;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, summaryText);

    console.log(summaryText.trimEnd());
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
  node scripts/prepare-typescript-go-pr.mjs --typescript-go-dir <path> [--out <path>] [--allow-unpinned]

Example:
  node scripts/checkout-typescript-source.mjs --source go --out .tmp/typescript-go --force
  git -C .tmp/typescript-go submodule update --init --depth 1 _submodules/TypeScript
  node scripts/prepare-typescript-go-pr.mjs --typescript-go-dir .tmp/typescript-go
`);
    process.exit(0);
}
