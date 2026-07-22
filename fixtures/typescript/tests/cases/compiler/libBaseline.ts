// @strict: true
// @lib: baseline

Intl.supportedValuesOf("currency");
new Intl.NumberFormat().formatRange(1, 2);

[1, 2, 3].at(0);
[1, 2, 3].toReversed();
"baseline".at(0);

Object.hasOwn({ baseline: true }, "baseline");
new Error("problem", { cause: new Error("root") });
/baseline/d.hasIndices;

type __BaselineLegacyRegExpStatic =
    | "$1"
    | "$2"
    | "$3"
    | "$4"
    | "$5"
    | "$6"
    | "$7"
    | "$8"
    | "$9"
    | "input"
    | "$_"
    | "lastMatch"
    | "$&"
    | "lastParen"
    | "$+"
    | "leftContext"
    | "$`"
    | "rightContext"
    | "$'";
type __BaselineAssertNever<T extends never> = T;
type __BaselineHasNoLegacyRegExpStatics = __BaselineAssertNever<
    Extract<__BaselineLegacyRegExpStatic, keyof typeof RegExp>
>;
(function probeCaller() {}).caller; // Error
"baseline".substr(1); // Error
new RegExp("baseline").compile("baseline"); // Error
(function probeArguments() { return arguments.callee; })(); // Error
