// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    applyTypeScriptSourcePin,
    checkoutTypeScriptSource,
    readTypeScriptSourcePin,
} from "../lib/typescript-source.mjs";
import { readLibSourceConfig } from "../lib/toolchain-libs.mjs";
import {
    cleanupTempDirectories,
    createTempDirectory,
    repoManifest,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("repo manifest pins the unified TypeScript source", () => {
    const pin = readTypeScriptSourcePin(repoManifest);

    assert.equal(pin.repository, "https://github.com/microsoft/TypeScript.git");
    assert.equal(pin.ref, "main");
    assert.match(pin.commit, /^[0-9a-f]{40}$/u);
});

test("source pinning and checkout remain exact after the tracked branch advances", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const sourceDirectory = path.join(tempDirectory, "source");
    const checkoutDirectory = path.join(tempDirectory, "checkout");

    initializeRepository(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "value.txt"), "first\n");
    commitAll(sourceDirectory, "first");

    const manifest = {};

    const pin = applyTypeScriptSourcePin({
        manifest,
        repository: sourceDirectory,
    });

    assert.equal(pin.ref, "main");

    fs.writeFileSync(path.join(sourceDirectory, "value.txt"), "second\n");
    commitAll(sourceDirectory, "second");

    const result = checkoutTypeScriptSource({
        manifest,
        outDirectory: checkoutDirectory,
    });

    assert.equal(result.commit, pin.commit);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkoutDirectory, encoding: "utf8" }).trim(), pin.commit);
    assert.equal(fs.readFileSync(path.join(checkoutDirectory, "value.txt"), "utf8"), "first\n");

    fs.writeFileSync(path.join(checkoutDirectory, "local.txt"), "dirty\n");
    assert.throws(
        () => checkoutTypeScriptSource({ manifest, outDirectory: checkoutDirectory }),
        /checkout has local changes/u,
    );

    const refreshed = checkoutTypeScriptSource({
        manifest,
        outDirectory: checkoutDirectory,
        force: true,
    });

    assert.equal(refreshed.reusedExistingCheckout, false);
    assert.ok(!fs.existsSync(path.join(checkoutDirectory, "local.txt")));
    assert.equal(fs.readFileSync(path.join(checkoutDirectory, "value.txt"), "utf8"), "first\n");
});

test("repo manifest pins a cross-platform verified lib source", () => {
    const libSource = repoManifest.libSource;

    assert.equal(libSource.basePackage, "typescript");
    assert.equal(libSource.platformPackagePrefix, "@typescript/typescript-");
    assert.ok(libSource.referencePlatforms.length >= 2, "expected at least two reference platforms");
    assert.match(libSource.libContentHash, /^sha256-[0-9a-f]{64}$/u);
    assert.ok(Number.isInteger(libSource.libFileCount) && libSource.libFileCount > 0);
});

test("lib source pins reject coerced values and duplicate reference platforms", () => {
    assert.deepEqual(readLibSourceConfig(repoManifest), repoManifest.libSource);

    for (const referencePlatforms of [
        ["linux-x64", "linux-x64"],
        ["linux-x64", 42],
        ["linux-x64", null],
        ["linux-x64", "../other"],
    ]) {
        assert.throws(
            () => readLibSourceConfig({ libSource: { ...repoManifest.libSource, referencePlatforms } }),
            /referencePlatforms/,
        );
    }

    assert.throws(
        () => readLibSourceConfig({ libSource: { ...repoManifest.libSource, libContentHash: [repoManifest.libSource.libContentHash] } }),
        /libContentHash/,
    );
});

/**
 * @param {string} directory
 */
function initializeRepository(directory) {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
}

/**
 * @param {string} directory
 * @param {string} message
 */
function commitAll(directory, message) {
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: directory });
}
