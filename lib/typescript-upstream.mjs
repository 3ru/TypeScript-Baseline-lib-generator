// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    assertDirectoryExists,
    assertFileExists,
    copyDirectoryContents,
    copyFileIfChanged,
    ensurePatchedTextFile,
} from "./text-patch.mjs";

const commandLineParserEntry = '    ["baseline", "lib.baseline.d.ts"],';
const commandLineParserAnchor = '    ["esnext", "lib.esnext.d.ts"],';
const libsJsonEntry = '        "baseline",';
const libsJsonAnchor = '        "esnext",';

/**
 * When expectedCommit is passed, verify the target clone's HEAD matches the pin
 * before writing. This prevents accidentally patching an unpinned clone found by
 * auto-discovery (e.g. ../TypeScript) while it's in a state unrelated to the pin.
 * Only pass allowUnpinned to deliberately patch a different commit.
 *
 * @param {{
 *   repoRoot: string;
 *   typescriptDir?: string;
 *   generatedLibPath?: string;
 *   fixturesRoot?: string;
 *   expectedCommit?: string;
 *   allowUnpinned?: boolean;
 * }} options
 */
export function prepareTypeScriptBaselinePatch(options) {
    const repoRoot = path.resolve(options.repoRoot);
    const typescriptDir = resolveTypeScriptWorkingDirectory(repoRoot, options.typescriptDir);

    if (options.expectedCommit && !options.allowUnpinned) {
        assertCloneMatchesPin(typescriptDir, options.expectedCommit);
    }
    const generatedLibPath = path.resolve(options.generatedLibPath ?? path.join(repoRoot, "generated", "current", "baseline.d.ts"));
    const fixturesRoot = path.resolve(options.fixturesRoot ?? path.join(repoRoot, "fixtures", "typescript"));
    const sourceTestsRoot = path.join(fixturesRoot, "tests");
    const targetLibPath = path.join(typescriptDir, "src", "lib", "baseline.d.ts");
    const commandLineParserPath = path.join(typescriptDir, "src", "compiler", "commandLineParser.ts");
    const libsJsonPath = path.join(typescriptDir, "src", "lib", "libs.json");

    assertFileExists(generatedLibPath, "generated baseline lib");
    assertFileExists(commandLineParserPath, "TypeScript commandLineParser.ts");
    assertFileExists(libsJsonPath, "TypeScript libs.json");
    assertDirectoryExists(sourceTestsRoot, "TypeScript fixture tests root");

    const copiedGeneratedLib = copyFileIfChanged(generatedLibPath, targetLibPath);
    const patchedCommandLineParser = ensurePatchedTextFile(commandLineParserPath, {
        alreadyPresentMarker: commandLineParserEntry,
        anchor: commandLineParserAnchor,
        insertion: `${commandLineParserAnchor}\n${commandLineParserEntry}`,
        description: "commandLineParser lib entry",
    });
    const patchedLibsJson = ensurePatchedTextFile(libsJsonPath, {
        alreadyPresentMarker: '"baseline"',
        anchor: libsJsonAnchor,
        insertion: `${libsJsonAnchor}\n${libsJsonEntry}`,
        description: "libs.json lib entry",
    });
    // Track the full fixture list and the files actually rewritten this run separately.
    // On an idempotent re-run, reporting unchanged files as "copied" would be misleading.
    const fixtureFiles = copyDirectoryContents(sourceTestsRoot, path.join(typescriptDir, "tests"));
    const fixtureFilePaths = fixtureFiles.map(entry => entry.targetPath);
    const changedFixtureFiles = fixtureFiles.filter(entry => entry.changed).map(entry => entry.targetPath);

    return {
        typescriptDir,
        generatedLibPath,
        targetGeneratedLibPath: targetLibPath,
        commandLineParserPath,
        libsJsonPath,
        copiedGeneratedLib,
        patchedCommandLineParser,
        patchedLibsJson,
        fixtureFiles: fixtureFilePaths,
        changedFixtureFiles,
    };
}

/**
 * @param {string} typescriptDir
 * @param {string} expectedCommit
 */
function assertCloneMatchesPin(typescriptDir, expectedCommit) {
    /** @type {string | undefined} */
    let headCommit;
    try {
        headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: typescriptDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        headCommit = undefined;
    }

    if (headCommit !== expectedCommit) {
        throw new Error([
            `TypeScript clone at ${typescriptDir} is at ${headCommit ?? "<not a git checkout>"}, but the manifest pins ${expectedCommit}.`,
            "Refusing to patch an unpinned clone.",
            "Use scripts/checkout-typescript-source.mjs to get a pinned checkout, or pass --allow-unpinned to patch deliberately.",
        ].join("\n"));
    }
}

/**
 * @param {{
 *   repoRoot: string;
 *   explicitDirectory?: string;
 * }} options
 */
function findTypeScriptWorkingDirectory(options) {
    const repoRoot = path.resolve(options.repoRoot);
    const candidates = [
        options.explicitDirectory,
        path.join(repoRoot, "..", "TypeScript"),
        path.join(repoRoot, "TypeScript"),
        path.join(process.cwd(), "TypeScript"),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const candidatePath = path.resolve(String(candidate));
        if (fs.existsSync(path.join(candidatePath, "src", "compiler", "commandLineParser.ts"))) {
            return candidatePath;
        }
    }

    return undefined;
}

/**
 * @param {ReturnType<typeof prepareTypeScriptBaselinePatch>} summary
 */
export function renderTypeScriptPatchSummary(summary) {
    const lines = [
        "# TypeScript Patch Summary",
        "",
        `- TypeScript clone: \`${summary.typescriptDir}\``,
        `- Generated source: \`${summary.generatedLibPath}\``,
        `- Installed lib: \`${summary.targetGeneratedLibPath}\``,
        `- commandLineParser patched: ${formatBoolean(summary.patchedCommandLineParser.changed)}`,
        `- libs.json patched: ${formatBoolean(summary.patchedLibsJson.changed)}`,
        `- Compiler fixture files: ${summary.fixtureFiles.length} total, ${summary.changedFixtureFiles.length} written this run`,
        "",
        "## Installed Files",
        "",
        `- \`${summary.targetGeneratedLibPath}\``,
        ...summary.fixtureFiles.map(filePath => `- \`${filePath}\`${summary.changedFixtureFiles.includes(filePath) ? " (updated)" : " (unchanged)"}`),
    ];

    return `${lines.join("\n")}\n`;
}

/**
 * @param {string} repoRoot
 * @param {string | undefined} explicitDirectory
 */
function resolveTypeScriptWorkingDirectory(repoRoot, explicitDirectory) {
    const foundDirectory = findTypeScriptWorkingDirectory({
        repoRoot,
        explicitDirectory,
    });

    if (!foundDirectory) {
        throw new Error(
            "Could not find a TypeScript clone. Pass --typescript-dir or place a clone at ../TypeScript.",
        );
    }

    return foundDirectory;
}

/**
 * @param {boolean} value
 */
function formatBoolean(value) {
    return value ? "yes" : "no";
}
