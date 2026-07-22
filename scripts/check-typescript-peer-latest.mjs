// @ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTypeScriptPeerRange } from "../deploy/package-lib.mjs";
import { baselinePackage } from "../deploy/package-registry.mjs";
import { npmViewField } from "../lib/installed-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const latestVersion = npmViewField(repoRoot, "typescript", "dist-tags.latest");
if (typeof latestVersion !== "string") {
    throw new Error("Could not resolve the latest stable TypeScript version");
}

assertTypeScriptPeerRange(baselinePackage.typescriptPeerDependencyRange, [latestVersion]);
console.log(`typescript@${latestVersion} is within peer range ${baselinePackage.typescriptPeerDependencyRange}`);
