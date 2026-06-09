// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { repoManifest } from "./helpers.mjs";
import {
    readStradaSourcePin,
    readTypeScriptGoSourcePin,
    resolveStradaSourceTag,
    resolveTypeScriptGoSourceTag,
} from "../lib/typescript-source.mjs";

// Pin the exhaustive consistency of the pins (tag <-> snapshot version, commit
// format) offline. That the commit matches the tag's actual object is verified at checkout.

test("repo manifest pins a frozen Strada source tag that matches the strada package version", () => {
    const pin = readStradaSourcePin(repoManifest);

    assert.equal(pin.repository, "https://github.com/microsoft/TypeScript.git");
    assert.equal(pin.tag, resolveStradaSourceTag(repoManifest.snapshot.typescriptStradaVersion));
    assert.match(pin.commit, /^[0-9a-f]{40}$/u);
});

test("repo manifest pins a typescript-go source tag that matches the typescript package version", () => {
    const pin = readTypeScriptGoSourcePin(repoManifest);

    assert.equal(pin.repository, "https://github.com/microsoft/typescript-go.git");
    assert.equal(pin.tag, resolveTypeScriptGoSourceTag(repoManifest.snapshot.typescriptVersion));
    assert.match(pin.commit, /^[0-9a-f]{40}$/u);
    assert.match(pin.stradaSubmoduleCommit, /^[0-9a-f]{40}$/u);
});

test("repo manifest pins a cross-platform verified lib source", () => {
    const libSource = repoManifest.libSource;

    assert.equal(libSource.basePackage, "typescript");
    assert.equal(libSource.platformPackagePrefix, "@typescript/typescript-");
    assert.ok(libSource.referencePlatforms.length >= 2, "expected at least two reference platforms");
    assert.match(libSource.libContentHash, /^sha256-[0-9a-f]{64}$/u);
    assert.ok(Number.isInteger(libSource.libFileCount) && libSource.libFileCount > 0);
});
