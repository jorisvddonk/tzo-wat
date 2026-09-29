import fs from "fs";
import program from "commander";
import { Builder, HostImport } from "./build";
import { parseConcise } from "./tokenizer";
import { testHosts, HostCtx } from "./hosts";
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
  const instructions: Instruction[] =
    input_file.code !== undefined ? parseConcise(input_file.code).instructions : input_file.input_program;

  const hostNames: string[] = Array.from(new Set(["randInt"].concat(input_file.host || [])));
  for (const name of hostNames) {
    if (testHosts[name] === undefined) {
      throw new Error(`unknown test host function: ${name}`);
    }
  }

  const hostImports: { [key: string]: HostImport } = {};
  for (const name of hostNames) {
    hostImports[name] = {
      params: testHosts[name].params,
      result: testHosts[name].result,
      resultKind: testHosts[name].resultKind,
    };
  }

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

  let instance: any;
  const recorded: { name: string; args: any[] }[] = [];
  const ctx: HostCtx = {
    readString: (ptr: number) => {
      throw new Error("readString used before instantiation");
    },
    writeString: (s: string) => {
      const bytes = Buffer.from(s, "utf8");
      const ptr = instance.exports.alloc(bytes.length + 1);
      const mem = new Uint8Array(instance.exports.pagememory.buffer);
      mem.set(bytes, ptr);
      mem[ptr + bytes.length] = 0;
      return ptr;
    },
  };

  const imports: any = {};
  for (const name of hostNames) {
    const host = testHosts[name];
    imports[name] = (...raw: number[]) => {
      const decoded = raw.map((v, i) => {
        const kind = host.argKinds !== undefined ? host.argKinds[i] : "number";
        return kind === "string" ? readStringFromMem(instance.exports.pagememory.buffer, v) : v;
      });
      recorded.push({ name, args: decoded });
      const result = host.impl(raw, ctx);
      return host.result !== undefined ? result : undefined;
    };
  }

  const module = w.parseWat(filename, wasm_text);
  const binary = module.toBinary({});
  const compiled = await WebAssemblyAny.compile(binary.buffer);
  instance = await WebAssemblyAny.instantiate(compiled, { imports });
  ctx.readString = (ptr: number) => readStringFromMem(instance.exports.pagememory.buffer, ptr);

  instance.exports.main();

  const errors: string[] = [];
  const expected = input_file.expected || {};

  const gotStack: any[] = [];
  const stackSize = instance.exports.stack_size();
  for (let i = 0; i < stackSize; i++) {
    const tag = instance.exports.stack_tag(i);
    const val = instance.exports.stack_num(i);
    gotStack.push(tag === 1 ? readStringFromMem(instance.exports.pagememory.buffer, val) : val);
  }

  const gotContext: { [key: string]: any } = {};
  const ctxSize = instance.exports.ctx_size();
  for (let i = 0; i < ctxSize; i++) {
    const key = readStringFromMem(instance.exports.pagememory.buffer, instance.exports.ctx_key(i));
    const tag = instance.exports.ctx_tag(i);
    const val = instance.exports.ctx_num(i);
    gotContext[key] = tag === 1 ? readStringFromMem(instance.exports.pagememory.buffer, val) : val;
  }

  if (expected.stack !== undefined) {
    if (!deepEqual(gotStack, expected.stack)) {
      errors.push(`stack: got ${JSON.stringify(gotStack)} expected ${JSON.stringify(expected.stack)}`);
    }
  }
  if (expected.context !== undefined) {
    if (!deepEqual(gotContext, expected.context)) {
      errors.push(`context: got ${JSON.stringify(gotContext)} expected ${JSON.stringify(expected.context)}`);
    }
  }
  if (expected.programCounter !== undefined) {
    const gotPc = instance.exports.get_pc();
    if (gotPc !== expected.programCounter) {
      errors.push(`programCounter: got ${gotPc} expected ${expected.programCounter}`);
    }
  }
  if (expected.calls !== undefined) {
    if (!deepEqual(recorded, expected.calls)) {
      errors.push(`host calls: got ${JSON.stringify(recorded)} expected ${JSON.stringify(expected.calls)}`);
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
