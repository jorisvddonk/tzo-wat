import fs from "fs";
import program from "commander";
import { Builder, HostImport } from "./build";
import wabt from "wabt";
import glob from "glob";
import { Instruction } from "tzo";
import { TextDecoder } from "util";

const WebAssemblyAny = (globalThis as any).WebAssembly;

program
  .version('0.0.1')
  .option('--input <globstr>', "Load Tzo VM test .json file(s)", "vendor/tzo/src/tests/*.json")
  .option('--verbose', "Verbose logging", false)
  .parse(process.argv);

const decoder = new TextDecoder("utf-8");

function readStringFromMem(buffer: ArrayBuffer, offset: number): string {
  const bytes = new Uint8Array(buffer);
  let end = offset;
  while (bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

function deepEqual(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return a === b;
}

function labelMapOf(instructions: Instruction[]): { [key: string]: number } {
  const map: { [key: string]: number } = {};
  instructions.forEach((instr: any, i) => {
    if (instr.label !== undefined) {
      map[instr.label] = i;
    }
  });
  return map;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function testFile(filename: string, verbose: boolean, w: any) {
  const input_file = JSON.parse(fs.readFileSync(filename).toString());
  const instructions: Instruction[] = input_file.input_program;
  const hostImports: { [key: string]: HostImport } = {
    randInt: { params: ["f64"], result: "f64" },
  };
  const builder = new Builder(
    instructions,
    labelMapOf(instructions),
    input_file.initial_context !== undefined ? input_file.initial_context : {},
    hostImports
  );
  const wasm_text = builder.build();
  if (verbose) {
    console.log(wasm_text);
  }
  const module = w.parseWat(filename, wasm_text);
  const binary = module.toBinary({});
  const compiled = await WebAssemblyAny.compile(binary.buffer);
  const instance = await WebAssemblyAny.instantiate(compiled, {
    imports: {
      randInt: (max: number) => Math.floor(Math.random() * max),
    },
  });
  const memory: any = instance.exports.pagememory;
  instance.exports.main();

  const errors: string[] = [];
  const arraysEqual = (a: any[], b: any[]) => deepEqual(a, b);

  const gotStack: any[] = [];
  const stackSize = instance.exports.stack_size();
  for (let i = 0; i < stackSize; i++) {
    const tag = instance.exports.stack_tag(i);
    const val = instance.exports.stack_num(i);
    gotStack.push(tag === 1 ? readStringFromMem(memory.buffer, val) : val);
  }

  const gotContext: { [key: string]: any } = {};
  const ctxSize = instance.exports.ctx_size();
  for (let i = 0; i < ctxSize; i++) {
    const key = readStringFromMem(memory.buffer, instance.exports.ctx_key(i));
    const tag = instance.exports.ctx_tag(i);
    const val = instance.exports.ctx_num(i);
    gotContext[key] = tag === 1 ? readStringFromMem(memory.buffer, val) : val;
  }

  if (input_file.expected.stack !== undefined) {
    if (!arraysEqual(gotStack, input_file.expected.stack)) {
      errors.push(`stack: got ${JSON.stringify(gotStack)} expected ${JSON.stringify(input_file.expected.stack)}`);
    }
  }
  if (input_file.expected.context !== undefined) {
    if (!deepEqual(gotContext, input_file.expected.context)) {
      errors.push(`context: got ${JSON.stringify(gotContext)} expected ${JSON.stringify(input_file.expected.context)}`);
    }
  }
  if (input_file.expected.programCounter !== undefined) {
    const gotPc = instance.exports.get_pc();
    if (gotPc !== input_file.expected.programCounter) {
      errors.push(`programCounter: got ${gotPc} expected ${input_file.expected.programCounter}`);
    }
  }

  if (errors.length > 0) {
    failed++;
    failures.push(`${filename}\n    ${errors.join("\n    ")}`);
    if (verbose) {
      console.log(wasm_text);
    }
  } else {
    passed++;
  }
}

async function main() {
  const files: string[] = await new Promise((resolve, reject) => {
    glob(program.input, {}, (err, matches) => (err ? reject(err) : resolve(matches)));
  });
  files.sort();
  const w = await wabt();
  for (const file of files) {
    try {
      await testFile(file, program.verbose, w);
    } catch (e) {
      failed++;
      failures.push(`${file}\n    threw: ${e}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (out of ${files.length})`);
  if (failures.length > 0) {
    console.log("\nFailures:\n" + failures.join("\n"));
    process.exitCode = 1;
  }
}

main();
