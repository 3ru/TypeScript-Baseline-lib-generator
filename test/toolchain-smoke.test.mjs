// @ts-check

import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createManifest,
    createTempDirectory,
    runGenerate,
    runTsc,
    runTscStrada,
    writeTextFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

// Pin that the generated lib alone reads under both the primary toolchain (TypeScript 7 / tsgo)
// and the compat toolchain (the final Strada series). Consumers will run a mix of 6.x and 7.x
// for now, so we must not ship a generated artifact that only one of them can read.

test("toolchain smoke: baseline declarations typecheck under TypeScript 7 (tsgo)", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    runGenerate(fixture.manifestPath);

    const inputPath = path.join(tempDirectory, "ts7-pass.ts");
    writeTextFile(inputPath, [
        "const values = Intl.supportedValuesOf(\"currency\");",
        "values.map(value => value.toUpperCase());",
        "",
    ].join("\n"));

    runTsc(["--noEmit", "--noLib", "--skipLibCheck", fixture.topLevelOutputPath, inputPath]);
});

test("toolchain smoke: baseline declarations typecheck under Strada (TypeScript 6)", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    runGenerate(fixture.manifestPath);

    const inputPath = path.join(tempDirectory, "strada-pass.ts");
    writeTextFile(inputPath, [
        "const values = Intl.supportedValuesOf(\"currency\");",
        "values.map(value => value.toUpperCase());",
        "",
    ].join("\n"));

    runTscStrada(["--noEmit", "--noLib", "--skipLibCheck", fixture.topLevelOutputPath, inputPath]);
});
