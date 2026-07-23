// @ts-check

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createTempDirectory,
    repoGeneratedLibPath,
    runTsc,
    runTscStrada,
    writeJsonFile,
    writeTextFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("generated lib supports erased utility types with strict library checking", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    writeTextFile(
        path.join(tempDirectory, "baseline.d.ts"),
        fs.readFileSync(repoGeneratedLibPath, "utf8"),
    );
    writeTextFile(path.join(tempDirectory, "third-party.d.ts"), [
        "declare const thirdPartyLabels: Record<string, string>;",
        "declare const thirdPartyIterator: IterableIterator<string>;",
        "declare const thirdPartyAsyncIterable: AsyncIterable<string>;",
        "declare const thirdPartyAsyncIterator: AsyncIterableIterator<string>;",
        "declare function thirdPartyTag(strings: TemplateStringsArray): string;",
        "",
    ].join("\n"));
    writeTextFile(path.join(tempDirectory, "consumer.ts"), [
        "interface Model { a: string; b?: number; readonly c: boolean; }",
        "declare function callable(this: { prefix: string }, value: number, flag?: boolean): string;",
        "declare abstract class Constructable { constructor(value: number, label?: string); value: number; }",
        "type T01 = Awaited<Promise<string>>;",
        "type T02 = Partial<Model>;",
        "type T03 = Required<Model>;",
        "type T04 = Readonly<Model>;",
        "type T05 = Pick<Model, \"a\">;",
        "type T06 = Record<string, Model>;",
        "type T07 = Exclude<\"a\" | \"b\", \"b\">;",
        "type T08 = Extract<\"a\" | \"b\", \"b\">;",
        "type T09 = Omit<Model, \"b\">;",
        "type T10 = NonNullable<string | null | undefined>;",
        "type T11 = Parameters<typeof callable>;",
        "type T12 = ConstructorParameters<typeof Constructable>;",
        "type T13 = ReturnType<typeof callable>;",
        "type T14 = InstanceType<typeof Constructable>;",
        "type T15 = ThisParameterType<typeof callable>;",
        "type T16 = OmitThisParameter<typeof callable>;",
        "type T17 = Uppercase<\"baseline\">;",
        "type T18 = Lowercase<\"BASELINE\">;",
        "type T19 = Capitalize<\"baseline\">;",
        "type T20 = Uncapitalize<\"Baseline\">;",
        "const contextual: { method(): number } & ThisType<{ value: number }> = {",
        "    method() { return this.value; },",
        "};",
        "declare const readonlyMap: ReadonlyMap<string, number>;",
        "declare const readonlySet: ReadonlySet<number>;",
        "declare const readonlyValues: readonly number[];",
        "declare const promiseLike: PromiseLike<number>;",
        "declare const callableValue: ((this: { prefix: string }, value: number) => string) & CallableFunction;",
        "readonlyMap.get(thirdPartyLabels.baseline);",
        "thirdPartyIterator.next();",
        "thirdPartyAsyncIterable[Symbol.asyncIterator]();",
        "thirdPartyAsyncIterator.next();",
        "thirdPartyTag`baseline`;",
        "readonlySet.has(contextual.method());",
        "readonlyValues.findLast(value => value > 0);",
        "readonlyValues.toReversed();",
        "promiseLike.then(value => value + 1);",
        "callableValue.call({ prefix: \"\" }, 1);",
        "callableValue.bind({ prefix: \"\" });",
        "declare const arr: readonly number[];",
        "for (const x of arr) { const value: number = x; value; }",
        "function readArguments() { for (const value of arguments) { value; } }",
        "",
    ].join("\n"));
    writeJsonFile(path.join(tempDirectory, "tsconfig.json"), {
        compilerOptions: {
            noLib: true,
            skipLibCheck: false,
            strict: true,
            target: "esnext",
            noEmit: true,
        },
        files: ["baseline.d.ts", "third-party.d.ts", "consumer.ts"],
    });

    runTsc(["-p", path.join(tempDirectory, "tsconfig.json")], { cwd: tempDirectory });
    runTscStrada(["-p", path.join(tempDirectory, "tsconfig.json")], { cwd: tempDirectory });
});
