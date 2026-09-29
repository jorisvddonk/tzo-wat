import wabt from "wabt";
import { Builder, HostImport } from "../src/build";
import { parseConcise } from "../src/tokenizer";

const DEFAULT_CODE = `1 1 + 2 eq jgz { "1 + 1 = 2!" }`;

const hostImports: { [key: string]: HostImport } = {
  loadImage: { params: ["f64", "f64", "f64"] },
  beginDraw: { params: [] },
  drawFrame: { params: ["f64"] },
  randInt: { params: ["f64"], result: "f64" },
  endDraw: { params: [] },
  getResponse: { params: [], result: "f64" },
  emit: { params: ["f64"] },
  response: { params: ["f64", "f64"] },
  optionEnabled: { params: ["f64"], result: "f64" },
  optionDisabled: { params: ["f64"], result: "f64" },
  disableOption: { params: ["f64"] },
  enableOption: { params: ["f64"] },
};

const decoder = new TextDecoder("utf-8");

const $ = (id: string) => document.getElementById(id) as any;

const inputEl: HTMLTextAreaElement = $("input");
const watEl: HTMLTextAreaElement = $("wat");
const statusEl: HTMLElement = $("status");
const warningsEl: HTMLElement = $("warnings");
const runOutputEl: HTMLElement = $("run-output");
const downloadEl: HTMLAnchorElement = $("download");
const runBtn: HTMLButtonElement = $("run");
const compileBtn: HTMLButtonElement = $("compile");
const assembleBtn: HTMLButtonElement = $("assemble");

let lastWasm: Uint8Array | null = null;

function compile(): string {
  const code = inputEl.value;
  const { instructions, labelMap } = parseConcise(code);
  const builder = new Builder(instructions, labelMap, {}, hostImports);
  const wat = builder.build();
  const warnings = builder.getWarnings();
  if (warnings.length > 0) {
    warningsEl.textContent = "Unknown functions (treated as no-ops): " + warnings.join(", ");
    warningsEl.style.display = "block";
  } else {
    warningsEl.style.display = "none";
  }
  watEl.value = wat;
  lastWasm = null;
  downloadEl.style.display = "none";
  return wat;
}

async function assemble(wat: string): Promise<Uint8Array> {
  const w = await wabt();
  const module = w.parseWat("input.tzo", wat);
  const binary = module.toBinary({});
  return new Uint8Array(binary.buffer);
}

function readStringFromMemory(memory: WebAssembly.Memory, offset: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = offset;
  while (bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

function makeHostImports(log: (line: string) => void) {
  const handler = (name: string) => (...args: number[]) => {
    log(`${name}(${args.join(", ")})`);
    return 0;
  };
  return {
    loadImage: handler("loadImage"),
    beginDraw: handler("beginDraw"),
    drawFrame: handler("drawFrame"),
    randInt: (max: number) => Math.floor(Math.random() * max),
    endDraw: handler("endDraw"),
    getResponse: () => 0,
    emit: handler("emit"),
    response: handler("response"),
    optionEnabled: () => 0,
    optionDisabled: () => 0,
    disableOption: handler("disableOption"),
    enableOption: handler("enableOption"),
  };
}

async function run() {
  runOutputEl.textContent = "";
  const lines: string[] = [];
  let wasm = lastWasm;
  if (wasm === null) {
    const wat = compile();
    wasm = await assemble(wat);
    lastWasm = wasm;
  }
  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {
    imports: makeHostImports(line => lines.push(line)),
  });

  (instance.exports as any).main();

  const stack: any[] = [];
  const stackSize = (instance.exports as any).stack_size();
  for (let i = 0; i < stackSize; i++) {
    const tag = (instance.exports as any).stack_tag(i);
    const val = (instance.exports as any).stack_num(i);
    stack.push(tag === 1 ? readStringFromMemory((instance.exports as any).pagememory, val) : val);
  }
  const stackLine = "stack: " + JSON.stringify(stack);
  const logLines = lines.length > 0 ? lines.join("\n") + "\n" : "";
  runOutputEl.textContent = logLines + stackLine;
}

compileBtn.addEventListener("click", () => {
  try {
    compile();
    statusEl.textContent = "compiled to wat";
    statusEl.className = "ok";
  } catch (e) {
    statusEl.textContent = String(e);
    statusEl.className = "error";
  }
});

assembleBtn.addEventListener("click", async () => {
  try {
    const bytes = new Uint8Array(await assemble(watEl.value));
    const blob = new Blob([bytes], { type: "application/wasm" });
    downloadEl.href = URL.createObjectURL(blob);
    downloadEl.download = "out.wasm";
    downloadEl.style.display = "inline-block";
    downloadEl.textContent = `download out.wasm (${bytes.length} bytes)`;
    statusEl.textContent = "assembled to wasm";
    statusEl.className = "ok";
  } catch (e) {
    statusEl.textContent = String(e);
    statusEl.className = "error";
  }
});

runBtn.addEventListener("click", async () => {
  try {
    await run();
    statusEl.textContent = "ran";
    statusEl.className = "ok";
  } catch (e) {
    statusEl.textContent = String(e);
    statusEl.className = "error";
  }
});

inputEl.value = DEFAULT_CODE;
watEl.value = "// press \u201cCompile\u201d";
