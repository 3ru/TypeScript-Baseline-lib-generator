// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    prepareTypeScriptBaselinePatch,
    renderTypeScriptPatchSummary,
} from "../lib/typescript-upstream.mjs";
import { readStradaSourcePin } from "../lib/typescript-source.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultSummaryPath = path.join(repoRoot, ".tmp", "typescript-pr-summary.md");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const summary = prepareTypeScriptBaselinePatch({
    repoRoot,
    typescriptDir: args.typescriptDir,
    expectedCommit: readStradaSourcePin(manifest).commit,
    allowUnpinned: args.allowUnpinned,
});
const summaryText = renderTypeScriptPatchSummary(summary);

if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, summaryText);
}
else {
    fs.mkdirSync(path.dirname(defaultSummaryPath), { recursive: true });
    fs.writeFileSync(defaultSummaryPath, summaryText);
}

console.log(summaryText.trimEnd());

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ out?: string; typescriptDir?: string; allowUnpinned?: boolean; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--allow-unpinned":
                args.allowUnpinned = true;
                break;
            case "--typescript-dir":
                args.typescriptDir = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--out":
                args.out = path.resolve(requireArgValue(argv[++index], current));
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
  node scripts/prepare-typescript-pr.mjs [--typescript-dir <path>] [--out <path>] [--allow-unpinned]

Examples:
  node scripts/prepare-typescript-pr.mjs
  node scripts/prepare-typescript-pr.mjs --typescript-dir ../TypeScript
  node scripts/prepare-typescript-pr.mjs --typescript-dir ../TypeScript --out .tmp/typescript-pr-summary.md
`);
    process.exit(0);
}
