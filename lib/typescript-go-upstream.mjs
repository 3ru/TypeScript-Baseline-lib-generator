// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    assertFileExists,
    copyFileIfChanged,
    ensurePatchedTextFile,
} from "./text-patch.mjs";

// Baseline lib patch for microsoft/typescript-go (TypeScript 7).
//
// typescript-go generates lib.*.d.ts from the submodule's (_submodules/TypeScript)
// src/lib via `go generate ./internal/bundled/` (generate.go).
// The generated libs_generated.go / embed_generated.go are gofmt'd and DO NOT EDIT.
// So we don't touch the generated files by hand; we ride the same "add input and
// regenerate" path as upstream:
//   1. Put baseline.d.ts at the submodule's src/lib/baseline.d.ts
//      (generate.go treats libName "baseline" as sourced from "baseline.d.ts")
//   2. Add "baseline" to the libs array in the submodule's src/lib/libs.json
//      (this is generate.go's only lib enumeration input)
//   3. Add {Key: "baseline", Value: "lib.baseline.d.ts"} to the hand-maintained
//      LibMap (internal/tsoptions/enummaps.go)
// Running `go generate` and the build is the caller's job (integration script / CI).
// This module handles only the deterministic text patch and doesn't depend on the Go toolchain.

export const typescriptGoSubmoduleLibDir = path.join("_submodules", "TypeScript", "src", "lib");
export const enumMapsRelativePath = path.join("internal", "tsoptions", "enummaps.go");

const libMapEntry = '\t{Key: "baseline", Value: "lib.baseline.d.ts"},';
const libMapAnchor = '\t{Key: "esnext", Value: "lib.esnext.d.ts"},';
const libsJsonEntry = '        "baseline",';
const libsJsonAnchor = '        "esnext",';

/**
 * When expectedCommit is passed, verify the target clone's HEAD matches the pin
 * before writing. Pass allowUnpinned to explicitly skip the check.
 *
 * @param {{
 *   repoRoot: string;
 *   typescriptGoDir: string;
 *   generatedLibPath?: string;
 *   expectedCommit?: string;
 *   allowUnpinned?: boolean;
 * }} options
 */
export function prepareTypeScriptGoBaselinePatch(options) {
    const repoRoot = path.resolve(options.repoRoot);
    const typescriptGoDir = path.resolve(options.typescriptGoDir);

    if (options.expectedCommit && !options.allowUnpinned) {
        assertCloneMatchesPin(typescriptGoDir, options.expectedCommit);
    }

    const generatedLibPath = path.resolve(
        options.generatedLibPath ?? path.join(repoRoot, "generated", "current", "baseline.d.ts"),
    );
    const submoduleLibDir = path.join(typescriptGoDir, typescriptGoSubmoduleLibDir);
    const targetLibSourcePath = path.join(submoduleLibDir, "baseline.d.ts");
    const libsJsonPath = path.join(submoduleLibDir, "libs.json");
    const enumMapsPath = path.join(typescriptGoDir, enumMapsRelativePath);

    assertFileExists(generatedLibPath, "generated baseline lib");
    assertFileExists(libsJsonPath, "typescript-go submodule libs.json (did you check out submodules?)");
    assertFileExists(enumMapsPath, "typescript-go enummaps.go");

    const copiedGeneratedLib = copyFileIfChanged(generatedLibPath, targetLibSourcePath);
    const patchedLibsJson = ensurePatchedTextFile(libsJsonPath, {
        alreadyPresentMarker: '"baseline"',
        anchor: libsJsonAnchor,
        insertion: `${libsJsonAnchor}\n${libsJsonEntry}`,
        description: "submodule libs.json lib entry",
    });
    const patchedEnumMaps = ensurePatchedTextFile(enumMapsPath, {
        alreadyPresentMarker: libMapEntry.trim(),
        anchor: libMapAnchor,
        insertion: `${libMapAnchor}\n${libMapEntry}`,
        description: "enummaps.go LibMap entry",
    });

    return {
        typescriptGoDir,
        generatedLibPath,
        targetLibSourcePath,
        libsJsonPath,
        enumMapsPath,
        copiedGeneratedLib,
        patchedLibsJson,
        patchedEnumMaps,
    };
}

/**
 * @param {ReturnType<typeof prepareTypeScriptGoBaselinePatch>} summary
 */
export function renderTypeScriptGoPatchSummary(summary) {
    const lines = [
        "# TypeScript Go Patch Summary",
        "",
        `- typescript-go clone: \`${summary.typescriptGoDir}\``,
        `- Generated source: \`${summary.generatedLibPath}\``,
        `- Installed lib source: \`${summary.targetLibSourcePath}\``,
        `- submodule libs.json patched: ${summary.patchedLibsJson.changed ? "yes" : "no"}`,
        `- enummaps.go LibMap patched: ${summary.patchedEnumMaps.changed ? "yes" : "no"}`,
        "",
        "## Next step",
        "",
        "Run `go generate ./internal/bundled/` in the clone to regenerate",
        "`libs_generated.go` / `embed_generated.go` with the baseline lib, then build.",
    ];

    return `${lines.join("\n")}\n`;
}

/**
 * @param {string} typescriptGoDir
 * @param {string} expectedCommit
 */
function assertCloneMatchesPin(typescriptGoDir, expectedCommit) {
    /** @type {string | undefined} */
    let headCommit;
    try {
        headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: typescriptGoDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        headCommit = undefined;
    }

    if (headCommit !== expectedCommit) {
        throw new Error([
            `typescript-go clone at ${typescriptGoDir} is at ${headCommit ?? "<not a git checkout>"}, but the manifest pins ${expectedCommit}.`,
            "Refusing to patch an unpinned clone.",
            "Use scripts/checkout-typescript-source.mjs --source go to get a pinned checkout, or pass --allow-unpinned.",
        ].join("\n"));
    }
}
