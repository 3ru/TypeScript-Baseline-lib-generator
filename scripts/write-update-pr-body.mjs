// @ts-check

import { execFileSync } from "node:child_process";
import {
    mkdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultManifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const defaultOutputPath = path.join(repoRoot, ".tmp", "baseline-lib-update-pr.md");

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest ?? defaultManifestPath);
const outputPath = path.resolve(args.out ?? defaultOutputPath);
const summaryOutputPath = args.summaryOut ? path.resolve(args.summaryOut) : undefined;
const baseRef = args.baseRef ?? "HEAD";

await main();

async function main() {
    const currentManifest = await readJsonFile(manifestPath);
    const currentState = await readCurrentState(currentManifest);
    const previousManifest = readJsonFileFromGit(baseRef, path.relative(repoRoot, manifestPath));
    const previousState = previousManifest ? readStateFromGit(previousManifest) : undefined;

    const summary = buildUpdateSummary({
        currentManifest,
        currentState,
        previousManifest,
        previousState,
    });

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${renderMarkdown(summary)}\n`);

    if (summaryOutputPath) {
        await mkdir(path.dirname(summaryOutputPath), { recursive: true });
        await writeFile(summaryOutputPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    }

    console.log(`Wrote baseline lib update PR body to ${path.relative(repoRoot, outputPath)}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ manifest?: string; out?: string; summaryOut?: string; baseRef?: string; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--manifest":
                args.manifest = requireArgValue(argv[++index], current);
                break;
            case "--out":
                args.out = requireArgValue(argv[++index], current);
                break;
            case "--summary-out":
                args.summaryOut = requireArgValue(argv[++index], current);
                break;
            case "--base-ref":
                args.baseRef = requireArgValue(argv[++index], current);
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
  node scripts/write-update-pr-body.mjs [--manifest <path>] [--out <path>] [--summary-out <path>] [--base-ref <git-ref>]

Examples:
  node scripts/write-update-pr-body.mjs
  node scripts/write-update-pr-body.mjs --out .tmp/baseline-lib-update-pr.md
`);
    process.exit(0);
}

/**
 * @param {any} manifest
 */
async function readCurrentState(manifest) {
    return {
        classification: await readJsonFile(resolveManifestRelativePath(manifestPath, manifest.classificationOutput)),
        generation: await readJsonFile(resolveManifestRelativePath(manifestPath, manifest.generationOutput)),
        compatManagement: await readJsonFile(resolveManifestRelativePath(manifestPath, manifest.compatManagementOutput)),
    };
}

/**
 * @param {any} manifest
 */
function readStateFromGit(manifest) {
    return {
        classification: readJsonFileFromGit(baseRef, path.relative(repoRoot, resolveManifestRelativePath(manifestPath, manifest.classificationOutput))),
        generation: readJsonFileFromGit(baseRef, path.relative(repoRoot, resolveManifestRelativePath(manifestPath, manifest.generationOutput))),
        compatManagement: readJsonFileFromGit(baseRef, path.relative(repoRoot, resolveManifestRelativePath(manifestPath, manifest.compatManagementOutput))),
    };
}

/**
 * @param {{
 *   currentManifest: any;
 *   currentState: { classification: any; generation: any; compatManagement: any; };
 *   previousManifest?: any;
 *   previousState?: { classification?: any; generation?: any; compatManagement?: any; };
 * }} options
 */
function buildUpdateSummary(options) {
    const {
        currentManifest,
        currentState,
        previousManifest,
        previousState,
    } = options;

    const currentClassificationSummary = currentState.classification.summary;
    const currentGenerationSummary = currentState.generation.summary;
    const currentCompatSummary = currentState.compatManagement.summary;
    const previousClassificationSummary = previousState?.classification?.summary;
    const previousGenerationSummary = previousState?.generation?.summary;
    const previousCompatRegistry = previousState?.compatManagement?.registry;
    const currentAllowEntries = currentState.generation.allowEntries ?? [];
    const previousAllowEntries = previousState?.generation?.allowEntries ?? [];
    const allowEntryChanges = compareAllowEntries(previousAllowEntries, currentAllowEntries);

    /** @type {string[]} */
    const reviewFlags = [];
    if (!previousCompatRegistry || previousCompatRegistry.sourceHash !== currentState.compatManagement.registry.sourceHash) {
        reviewFlags.push("`registry/compat-management.json` changed. Verify every edited group still has the right category, upstream action, and primary-source URLs.");
    }
    if ((delta(currentClassificationSummary.notModeledUpstreamCount, previousClassificationSummary?.notModeledUpstreamCount) ?? 0) !== 0) {
        reviewFlags.push("`not-modeled-upstream` count changed. Inspect `derived/current/classification.json` and `derived/current/compat-management-report.json` before merging.");
    }
    if ((delta(currentCompatSummary.managedUpstreamStateCounts.actionable, previousState?.compatManagement?.summary?.managedUpstreamStateCounts?.actionable) ?? 0) !== 0) {
        reviewFlags.push("Actionable upstream-gap count changed. Confirm whether a new or updated `microsoft/TypeScript` or `web-features` action item is needed.");
    }
    if (allowEntryChanges.length) {
        reviewFlags.push("Allow entry state or compat contract changed. Verify the polyfill contract and generated declaration diff before merging.");
    }
    if (!reviewFlags.length) {
        reviewFlags.push("No special review flags beyond the normal generated diff review.");
    }

    return {
        currentManifest,
        currentState,
        previousManifest,
        previousState,
        snapshot: {
            previous: previousManifest?.snapshot,
            current: currentManifest.snapshot,
        },
        deltas: {
            highCompatCount: delta(currentClassificationSummary.highCompatCount, previousClassificationSummary?.highCompatCount),
            lowCompatCount: delta(currentClassificationSummary.lowCompatCount, previousClassificationSummary?.lowCompatCount),
            falseCompatCount: delta(currentClassificationSummary.falseCompatCount, previousClassificationSummary?.falseCompatCount),
            includedCompatCount: delta(currentClassificationSummary.includedCompatCount, previousClassificationSummary?.includedCompatCount),
            notModeledUpstreamCount: delta(currentClassificationSummary.notModeledUpstreamCount, previousClassificationSummary?.notModeledUpstreamCount),
            managedCompatCount: delta(currentClassificationSummary.managedCompatCount, previousClassificationSummary?.managedCompatCount),
            selectedUnitCount: delta(currentGenerationSummary.selectedUnitCount, previousGenerationSummary?.selectedUnitCount),
            transformedUnitCount: delta(currentGenerationSummary.transformedUnitCount, previousGenerationSummary?.transformedUnitCount),
        },
        allowEntries: {
            activeCount: currentAllowEntries.filter(
                /** @param {{ kind?: string; }} entry */
                entry => entry.kind === "active",
            ).length,
            aliasCount: currentAllowEntries.filter(
                /** @param {{ kind?: string; }} entry */
                entry => entry.kind === "alias",
            ).length,
            changes: allowEntryChanges,
        },
        reviewFlags,
    };
}

/**
 * @param {ReturnType<typeof buildUpdateSummary>} summary
 */
function renderMarkdown(summary) {
    const currentClassificationSummary = summary.currentState.classification.summary;
    const currentGenerationSummary = summary.currentState.generation.summary;
    const currentCompatSummary = summary.currentState.compatManagement.summary;

    return [
        "Automated weekly refresh for the generator-backed `baseline` lib.",
        "",
        "## Snapshot",
        `- Snapshot id: ${formatTransition(summary.snapshot.previous?.name, summary.snapshot.current.name)}`,
        `- Baseline date: ${formatTransition(summary.snapshot.previous?.baselineDate, summary.snapshot.current.baselineDate)}`,
        `- web-features package: ${formatTransition(summary.snapshot.previous?.webFeaturesPackageVersion, summary.snapshot.current.webFeaturesPackageVersion)}`,
        `- web-features gitHead: ${formatTransition(summary.snapshot.previous?.webFeaturesGitHead, summary.snapshot.current.webFeaturesGitHead)}`,
        `- TypeScript package (tsgo): ${formatTransition(summary.snapshot.previous?.typescriptVersion, summary.snapshot.current.typescriptVersion)}`,
        `- TypeScript Strada compat package: ${formatTransition(summary.snapshot.previous?.typescriptStradaVersion, summary.snapshot.current.typescriptStradaVersion)}`,
        `- Lib source content hash: ${formatTransition(summary.previousManifest?.libSource?.libContentHash, summary.currentManifest.libSource?.libContentHash)}`,
        `- Strada source tag: ${formatTransition(summary.previousManifest?.typescriptSource?.tag, summary.currentManifest.typescriptSource?.tag)}`,
        `- Strada source commit: ${formatTransition(summary.previousManifest?.typescriptSource?.commit, summary.currentManifest.typescriptSource?.commit)}`,
        `- typescript-go source tag: ${formatTransition(summary.previousManifest?.typescriptGoSource?.tag, summary.currentManifest.typescriptGoSource?.tag)}`,
        `- typescript-go source commit: ${formatTransition(summary.previousManifest?.typescriptGoSource?.commit, summary.currentManifest.typescriptGoSource?.commit)}`,
        `- Generator version: ${summary.snapshot.current.generatorVersion}`,
        "",
        "## Generator Output",
        `- Top-level lib: \`${summary.currentState.generation.topLevelLib.outputPath}\``,
        `- Classified compat rows: ${summary.currentState.generation.summary.classifiedCompatCount}`,
        `- Included high rows: ${formatCountWithDelta(currentClassificationSummary.includedCompatCount, summary.deltas.includedCompatCount)}`,
        `- Selected declaration units: ${formatCountWithDelta(currentGenerationSummary.selectedUnitCount, summary.deltas.selectedUnitCount)}`,
        `- Transformed units: ${formatCountWithDelta(currentGenerationSummary.transformedUnitCount, summary.deltas.transformedUnitCount)}`,
        `- Allow entries: ${summary.allowEntries.activeCount} active, ${summary.allowEntries.aliasCount} aliases`,
        `- Allow entry changes: ${summary.allowEntries.changes.length ? summary.allowEntries.changes.join("; ") : "none"}`,
        "",
        "## Compat Management",
        `- Registry hash: \`${summary.currentState.compatManagement.registry.sourceHash}\``,
        `- Managed groups: ${summary.currentState.compatManagement.registry.groupCount}`,
        `- Managed compat keys: ${formatCountWithDelta(summary.currentState.compatManagement.registry.managedCompatCount, summary.deltas.managedCompatCount)}`,
        `- Categories: ${formatCountMap(currentCompatSummary.managedCategoryCounts)}`,
        `- Delivery modes: ${formatCountMap(currentCompatSummary.managedDeliveryCounts)}`,
        `- Upstream state: ${formatCountMap(currentCompatSummary.managedUpstreamStateCounts)}`,
        `- Managed resolution kinds: ${formatCountMap(currentCompatSummary.managedResolutionKindCounts)}`,
        "",
        "## Classification Deltas",
        `- high: ${formatCountWithDelta(currentClassificationSummary.highCompatCount, summary.deltas.highCompatCount)}`,
        `- low: ${formatCountWithDelta(currentClassificationSummary.lowCompatCount, summary.deltas.lowCompatCount)}`,
        `- false: ${formatCountWithDelta(currentClassificationSummary.falseCompatCount, summary.deltas.falseCompatCount)}`,
        `- not-modeled-upstream: ${formatCountWithDelta(currentClassificationSummary.notModeledUpstreamCount, summary.deltas.notModeledUpstreamCount)}`,
        `- already-excluded-upstream: ${currentClassificationSummary.alreadyExcludedUpstreamCount}`,
        "",
        "## Review Notes",
        ...summary.reviewFlags.map(flag => `- ${flag}`),
    ].join("\n");
}

/**
 * @param {Array<{ entryName: string; kind?: string; compatKeys?: string[]; }>} previousEntries
 * @param {Array<{ entryName: string; kind?: string; compatKeys?: string[]; }>} currentEntries
 */
function compareAllowEntries(previousEntries, currentEntries) {
    const previousByName = new Map(previousEntries.map(entry => [entry.entryName, entry]));
    const currentByName = new Map(currentEntries.map(entry => [entry.entryName, entry]));
    const names = [...new Set([...previousByName.keys(), ...currentByName.keys()])].sort();
    const changes = [];

    for (const name of names) {
        const previous = previousByName.get(name);
        const current = currentByName.get(name);
        if (!previous) {
            changes.push(`added allow/${name} (${current?.kind ?? "unknown"})`);
            continue;
        }
        if (!current) {
            changes.push(`removed allow/${name}`);
            continue;
        }
        if (previous.kind !== current.kind) {
            changes.push(`allow/${name}: ${previous.kind ?? "unknown"} -> ${current.kind ?? "unknown"}`);
        }
        const previousCompatKeys = [...(previous.compatKeys ?? [])].sort();
        const currentCompatKeys = [...(current.compatKeys ?? [])].sort();
        if (JSON.stringify(previousCompatKeys) !== JSON.stringify(currentCompatKeys)) {
            changes.push(`allow/${name}: compat contract changed`);
        }
    }
    return changes;
}

/**
 * @param {string} filePath
 */
async function readJsonFile(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * @param {string} gitRef
 * @param {string} repoRelativePath
 */
function readJsonFileFromGit(gitRef, repoRelativePath) {
    const sourceText = readTextFileFromGit(gitRef, repoRelativePath);
    return sourceText ? JSON.parse(sourceText) : undefined;
}

/**
 * @param {string} gitRef
 * @param {string} repoRelativePath
 */
function readTextFileFromGit(gitRef, repoRelativePath) {
    try {
        return execFileSync("git", ["show", `${gitRef}:${repoRelativePath}`], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    }
    catch {
        return undefined;
    }
}

/**
 * @param {string} manifestFilePath
 * @param {string} relativePath
 */
function resolveManifestRelativePath(manifestFilePath, relativePath) {
    return path.resolve(path.dirname(manifestFilePath), relativePath);
}

/**
 * @param {number | undefined | null} current
 * @param {number | undefined | null} previous
 */
function delta(current, previous) {
    if (typeof current !== "number" || typeof previous !== "number") {
        return undefined;
    }
    return current - previous;
}

/**
 * @param {number} count
 * @param {number | undefined | null} countDelta
 */
function formatCountWithDelta(count, countDelta) {
    if (typeof countDelta !== "number" || countDelta === 0) {
        return `${count}`;
    }
    return `${count} (${countDelta > 0 ? "+" : ""}${countDelta})`;
}

/**
 * @param {Record<string, number> | undefined} counts
 */
function formatCountMap(counts) {
    if (!counts || !Object.keys(counts).length) {
        return "none";
    }

    return Object.keys(counts)
        .sort((left, right) => left.localeCompare(right))
        .map(key => `${key}: ${counts[key]}`)
        .join(", ");
}

/**
 * @param {string | undefined} previous
 * @param {string | undefined} current
 */
function formatTransition(previous, current) {
    if (!previous) {
        return current ?? "n/a";
    }
    if (previous === current) {
        return current ?? previous;
    }
    return `${previous} -> ${current ?? "n/a"}`;
}
