// @ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(deployDirectory, "..");
export const deployGeneratedDirectory = path.join(deployDirectory, "generated");

export const baselinePackage = {
    id: "baseline",
    name: "typescript-baseline-lib",
    description: "Baseline widely available JavaScript declarations for TypeScript.",
    typescriptPeerDependencyRange: ">=6 <8",
    initialVersion: "0.0.1",
    license: "Apache-2.0",
    keywords: [
        "typescript",
        "baseline",
        "web-features",
        "declarations",
        "javascript",
    ],
    homepage: "https://github.com/3ru/TypeScript-Baseline-lib-generator",
    repositoryUrl: "git+https://github.com/3ru/TypeScript-Baseline-lib-generator.git",
    bugsUrl: "https://github.com/3ru/TypeScript-Baseline-lib-generator/issues",
    readmeTemplatePath: path.join(deployDirectory, "readmes", "baseline.md"),
    stageDirectory: path.join(deployGeneratedDirectory, "typescript-baseline-lib"),
    generatedFiles: [
        {
            from: path.join(repoRoot, "generated", "current", "baseline.d.ts"),
            to: "baseline.d.ts",
        },
        {
            from: path.join(repoRoot, "generated", "current", "allow"),
            to: "allow",
        },
        {
            from: path.join(repoRoot, "generated", "current", "year"),
            to: "year",
        },
        {
            from: path.join(repoRoot, "derived", "current", "classification.json"),
            to: path.join("reports", "classification.json"),
        },
        {
            from: path.join(repoRoot, "derived", "current", "compat-management-report.json"),
            to: path.join("reports", "compat-management-report.json"),
        },
        {
            from: path.join(repoRoot, "derived", "current", "generation.json"),
            to: path.join("reports", "generation.json"),
        },
    ],
};

export const baselinePackageName = baselinePackage.name;

export const packages = [baselinePackage];
