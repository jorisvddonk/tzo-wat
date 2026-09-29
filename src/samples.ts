export interface Sample {
  name: string;
  description: string;
  code: string;
  expected?: any[];
}

/**
 * Sample programs shown in the web UI dropdown. Deterministic samples carry an
 * `expected` stack so they are also run by the test suite (`npm test`).
 */
export const samples: Sample[] = [
  {
    name: "Hello, world!",
    description: "build a string with rconcat",
    code: `"Hello" "," " world!" rconcat rconcat`,
    expected: ["Hello, world!"],
  },
  {
    name: "Arithmetic",
    description: "plus, min (subtract) and mul",
    code: `2 3 +
4 10 min
5 6 mul`,
    expected: [5, 6, 30],
  },
  {
    name: "If",
    description: "conditionally run a { } block",
    code: `1 1 + 2 eq jgz { "one plus one is two" }`,
    expected: ["one plus one is two"],
  },
  {
    name: "Loop",
    description: "sum 1..5 with a labelled goto",
    code: `0 "sum" setContext
1 "i" setContext
6 #loop "i" getContext lt jgz {
  "sum" getContext "i" getContext + "sum" setContext
  "i" getContext 1 + "i" setContext
  "loop" goto
}
"sum" getContext`,
    expected: [15],
  },
  {
    name: "Strings",
    description: "concat / rconcat",
    code: `"Tzo" " " rconcat "rocks" rconcat`,
    expected: ["Tzo rocks"],
  },
  {
    name: "Char codes",
    description: "charCode to build \"Hi!\"",
    code: `72 charCode 105 charCode rconcat 33 charCode rconcat`,
    expected: ["Hi!"],
  },
  {
    name: "Context",
    description: "set / get / has context",
    code: `"FOO" "bar" setContext
"bar" getContext
"bar" hasContext
"missing" hasContext`,
    expected: ["FOO", 1, 0],
  },
  {
    name: "Stack ops",
    description: "dup and mul",
    code: `42 dup *`,
    expected: [1764],
  },
  {
    name: "Random",
    description: "randInt host import (0..99)",
    code: `100 randInt`,
  },
];
