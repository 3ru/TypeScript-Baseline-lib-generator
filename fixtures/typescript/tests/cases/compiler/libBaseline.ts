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

(function probeCaller() {}).caller; // Error
"baseline".substr(1); // Error
new RegExp("baseline").compile("baseline"); // Error
