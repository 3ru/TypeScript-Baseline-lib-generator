// @ts-check

import fs from "node:fs";
import path from "node:path";
import { runRecordedUpdateStep, writeUpdateDiagnostics } from "../lib/update-diagnostics.mjs";

const cwd = process.cwd();
const outputDirectory = path.join(cwd, ".tmp", "update-diagnostics");
const [mode, step, separator, command, ...args] = process.argv.slice(2);

if (mode === "run" && step && separator === "--" && command) {
    process.exitCode = await runRecordedUpdateStep({ cwd, outputDirectory, step, command, args });
}
else if (mode === "report" && !step) {
    const { markdown } = writeUpdateDiagnostics({
        cwd,
        outputDirectory,
        steps: JSON.parse(process.env.UPDATE_WORKFLOW_STEPS ?? "{}"),
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    }
    console.log(`Wrote ${path.relative(cwd, outputDirectory)}/summary.md`);
}
else {
    throw new Error("Usage: node scripts/update-diagnostics.mjs run <step> -- <command> [args...] | report");
}
