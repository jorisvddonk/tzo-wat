# Tzo-Wat

This is an experimental compiler that compiles [Tzo](https://github.com/jorisvddonk/tzo) Standard Representation into a WebAssembly .wat file!

The compiler emits a **self-contained** wasm module that contains a small Tzo VM runtime:
it executes the Tzo program list with a program-counter dispatch loop, a tagged value stack
(numbers and strings), a bump-allocated string heap, and a runtime context map. No JavaScript
runtime is required for the standard opcodes.

## Supported opcodes

All of the Tzo standard runtime is supported:

`nop`, `pop`, `+`/`plus`, `-`/`min`, `*`/`mul`, `or`, `and`, `lt`, `gt`, `not`, `eq`, `dup`,
`jz`, `jgz`, `goto` (by label or number), `setContext`, `getContext`, `hasContext`,
`delContext`, `{`/`}`, `exit`, `pause`, `ppc`, `stacksize`, `charCode`, `concat`, `rconcat`,
`randInt`, and `stdout`.

Functions that are not standard opcodes are looked up in a host-import table
(`loadImage`, `drawFrame`, `emit`, ... in the CLI) and compiled to wasm imports.

## How it works

- `src/build.ts` takes a Tzo instruction list, label map and initial context, and emits WAT text.
- String literals are interned into data segments; the runtime heap starts immediately after them.
- Execution is a program-counter dispatch loop, so `goto`, `jz`/`jgz` and `ppc` behave exactly
  like the reference VM.
- `src/cli.ts` wires up the game host imports and writes the `.wat` file.
- `src/test2.ts` is the test runner that validates the compiled output against the fixtures.

## Running

1. make sure you have dependencies installed: `npm i`
2. `npm run start -- --input <path to Tzo VMState .json> --output out.wat`
3. `npx wat2wasm ./out.wat -o out.wasm`
4. `node src/test.js ./out.wasm` — runs the program and prints the resulting stack and context

## Testing

The reference opcode tests live in the [tzo](https://github.com/jorisvddonk/tzo) repository,
which is included as a git submodule under `vendor/tzo`. Initialize it first:

```sh
git submodule update --init --recursive
npm test
```

`src/test2.ts` compiles every `vendor/tzo/src/tests/*.json` fixture to wasm, runs it, and
validates the resulting stack (numbers and strings), context, and program counter.

## Runtime layout

The generated module keeps everything in linear memory:

| region        | address    | contents                                   |
| ------------- | ---------- | ------------------------------------------ |
| value stack   | `0`        | `f64` per stack slot (string = pointer)    |
| tag stack     | `524288`   | `i32` tag per slot (`0` number, `1` string)|
| context table | `786432`   | 16-byte entries: key ptr, tag, value       |
| scratch       | `1048576`  | number->string conversion buffers          |
| string data   | `1114112`  | interned string literals (data segments)   |
| heap          | after data | bump-allocated strings at runtime          |

The module exports `main`, `pagememory`, and accessors used by the test runner:
`stack_size`, `stack_tag`, `stack_num`, `ctx_size`, `ctx_key`, `ctx_tag`, `ctx_num`, `get_pc`.
