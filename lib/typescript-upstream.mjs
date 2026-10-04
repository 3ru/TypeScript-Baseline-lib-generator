// @ts-check

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assertDirectoryExists,
    assertFileExists,
    copyDirectoryContents,
    ensurePatchedTextFile,
} from "./text-patch.mjs";

export const typescriptLibSourceDirectory = path.join("tsc", "internal", "bundled", "libs");

export const compilerOptionsRelativePath = path.join("tools", "scripts", "tsc", "options.ts");

const libMapEntry = '                { name: "baseline", value: "lib.baseline.d.ts" },';

const libMapAnchor = '                { name: "esnext", value: "lib.esnext.d.ts" },';

/**
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
        assertTypeScriptSourcePin(typescriptDir, options.expectedCommit);
    }

    const generatedLibPath = path.resolve(
        options.generatedLibPath ?? path.join(repoRoot, "generated", "current", "baseline.d.ts"),
    );

    const fixturesRoot = path.resolve(options.fixturesRoot ?? path.join(repoRoot, "fixtures", "typescript"));
    const fixtureCasesRoot = path.join(fixturesRoot, "tests", "cases");
    const fixtureBaselinesRoot = path.join(fixturesRoot, "tests", "baselines", "reference");
    const libSourceDirectory = path.join(typescriptDir, typescriptLibSourceDirectory);
    const targetLibSourcePath = path.join(libSourceDirectory, "lib.baseline.d.ts");
    const compilerOptionsPath = path.join(typescriptDir, compilerOptionsRelativePath);
    const copyrightPath = path.join(typescriptDir, "tsc", "internal", "bundled", "CopyrightNotice.txt");

    assertFileExists(generatedLibPath, "generated baseline lib");
    assertFileExists(compilerOptionsPath, "TypeScript compiler option definitions");
    assertFileExists(copyrightPath, "TypeScript copyright notice");
    assertDirectoryExists(fixtureCasesRoot, "TypeScript fixture cases root");
    assertDirectoryExists(fixtureBaselinesRoot, "TypeScript fixture baselines root");

    const source = fs.readFileSync(generatedLibPath, "utf8");
    const copyright = fs.readFileSync(copyrightPath, "utf8");
    const license = source.match(/\/\*! \*+[\s\S]*?\*+ \*\/\s*/u);

    if (!license || license[0].trim() !== copyright.trim()) {
        throw new Error("Generated baseline lib does not contain the TypeScript copyright notice");
    }

    const libText = `${copyright}\n${source.replace(license[0], "")}`.replace(/\r\n/gu, "\n");

    const patchedCompilerOptions = ensurePatchedTextFile(compilerOptionsPath, {
        alreadyPresentMarker: libMapEntry.trim(),
        anchor: libMapAnchor,
        insertion: `${libMapAnchor}\n${libMapEntry}`,
        description: "options.ts lib entry",
    });

    const copiedGeneratedLib = {
        changed: !fs.existsSync(targetLibSourcePath) || fs.readFileSync(targetLibSourcePath, "utf8") !== libText,
    };

    if (copiedGeneratedLib.changed) {
        fs.writeFileSync(targetLibSourcePath, libText);
    }

    const fixtureFiles = [
        ...copyDirectoryContents(
            fixtureCasesRoot,
            path.join(typescriptDir, "tsc", "testdata", "tests", "cases"),
        ),
        ...copyDirectoryContents(
            fixtureBaselinesRoot,
            path.join(typescriptDir, "tsc", "testdata", "baselines", "reference", "compiler"),
        ),
    ];

    const fixtureFilePaths = fixtureFiles.map(entry => entry.targetPath);
    const changedFixtureFiles = fixtureFiles.flatMap(entry => entry.changed ? [entry.targetPath] : []);

    return {
        typescriptDir,
        generatedLibPath,
        targetLibSourcePath,
        compilerOptionsPath,
        copiedGeneratedLib,
        patchedCompilerOptions,
        fixtureFiles: fixtureFilePaths,
        changedFixtureFiles,
    };
}

/**
 * @param {string} typescriptDir
 * @param {string[]} allowedRelativePaths
 */
export function findUnexpectedTypeScriptPatchPaths(typescriptDir, allowedRelativePaths) {
    const changedPaths = [
        ...execFileSync("git", ["diff", "--name-only", "HEAD", "--"], {
            cwd: typescriptDir,
            encoding: "utf8",
        }).split(/\r?\n/u),
        ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
            cwd: typescriptDir,
            encoding: "utf8",
        }).split(/\r?\n/u),
    ].filter(Boolean);

    const allowedPaths = new Set(allowedRelativePaths.map(relativePath => relativePath.split(path.sep).join("/")));

    return [...new Set(changedPaths)]
        .filter(relativePath => (
            !allowedPaths.has(relativePath)
            && !isExpectedTypeScriptBaselineUpdate(typescriptDir, relativePath)
        ))
        .sort();
}

/**
 * @param {string} typescriptDir
 */
export function renderTypeScriptPatchDiff(typescriptDir) {
    const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
        cwd: typescriptDir,
        encoding: "utf8",
    });

    const untrackedPaths = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: typescriptDir,
        encoding: "utf8",
    }).split(/\r?\n/u).filter(Boolean).sort();

    const untrackedDiffs = untrackedPaths.map(relativePath => {
        const result = spawnSync("git", ["diff", "--no-index", "--binary", "--", os.devNull, relativePath], {
            cwd: typescriptDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (result.error || result.status !== 1) {
            throw result.error ?? new Error(
                `Could not render diff for ${relativePath}: ${result.stderr || `git exited with ${result.status}`}`,
            );
        }

        return result.stdout;
    });

    return [trackedDiff, ...untrackedDiffs].filter(Boolean).join("");
}

/**
 * @param {string} output
 * @param {string} testName
 */
export function hasPassingGoTestEvent(output, testName) {
    return output.split(/\r?\n/u)
        .filter(line => line.startsWith("{"))
        .map(line => JSON.parse(line))
        .some(event => event.Action === "pass" && event.Test === testName);
}

/**
 * @param {string} typescriptDir
 * @param {string} relativePath
 */
function isExpectedTypeScriptBaselineUpdate(typescriptDir, relativePath) {
    if (
        !relativePath.startsWith("tsc/testdata/baselines/reference/")
        || !relativePath.endsWith(".js")
        || !fs.existsSync(path.join(typescriptDir, relativePath))
    ) {
        return false;
    }

    const previousText = execFileSync("git", ["show", `HEAD:${relativePath}`], {
        cwd: typescriptDir,
        encoding: "utf8",
    });

    const nextText = fs.readFileSync(path.join(typescriptDir, relativePath), "utf8");
    const previousNormalized = normalizeTypeScriptBaselineUpdate(previousText);
    const nextNormalized = normalizeTypeScriptBaselineUpdate(nextText);

    return previousNormalized !== undefined
        && nextNormalized !== undefined
        && previousNormalized === nextNormalized;
}

/**
 * @param {string} text
 */
function normalizeTypeScriptBaselineUpdate(text) {
    let matched = false;

    const diagnosticNormalized = text.replace(
        /^.*Argument for '--lib' option must be:.*$/gmu,
        line => {
            matched = true;

            return line.replace(/,\s*'baseline'(?=,)/gu, "");
        },
    );

    const helpNormalized = diagnosticNormalized.replace(
        /^[^\r\n]*one or more:\s+es5[\s\S]*?(?=\r?\n(?:[+-]?[ \t]*default:|[ \t]*\r?\n))/gimu,
        block => {
            matched = true;

            return block.replace(/,\s*baseline(?=,)/gu, "").replace(/\s+/gu, "");
        },
    );

    return matched ? helpNormalized : undefined;
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
        `- Installed lib source: \`${summary.targetLibSourcePath}\``,
        `- Compiler option definitions patched: ${formatBoolean(summary.patchedCompilerOptions.changed)}`,
        `- Compiler fixture files: ${summary.fixtureFiles.length} total, ${summary.changedFixtureFiles.length} written this run`,
        "",
        "## Installed Files",
        "",
        `- \`${summary.targetLibSourcePath}\``,
        ...summary.fixtureFiles.map(filePath => `- \`${filePath}\`${summary.changedFixtureFiles.includes(filePath) ? " (updated)" : " (unchanged)"}`),
        "",
        "## Next Step",
        "",
        `Run \`npm ci && npm run generate\` in \`${summary.typescriptDir}\` before reviewing or proposing the complete upstream diff.`,
    ];

    return `${lines.join("\n")}\n`;
}

/**
 * @param {string} typescriptDir
 * @param {string} expectedCommit
 */
export function assertTypeScriptSourcePin(typescriptDir, expectedCommit) {
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
            "Use scripts/checkout-typescript-source.mjs to get the pinned checkout, or pass --allow-unpinned deliberately.",
        ].join("\n"));
    }
}

/**
 * @param {string} repoRoot
 * @param {string | undefined} explicitDirectory
 */
function resolveTypeScriptWorkingDirectory(repoRoot, explicitDirectory) {
    const candidatePath = path.resolve(explicitDirectory ?? path.join(repoRoot, ".tmp", "TypeScript"));

    if (fs.existsSync(path.join(candidatePath, typescriptLibSourceDirectory, "lib.es5.d.ts"))) {
        return candidatePath;
    }

    throw new Error(
        `Could not find a current TypeScript clone at ${candidatePath}. Run npm run checkout:typescript-source or pass --typescript-dir.`,
    );
}

/**
 * @param {boolean} value
 */
function formatBoolean(value) {
    return value ? "yes" : "no";
}
