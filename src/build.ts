import { Instruction } from "tzo";
import sexp from "node-sexp";
import 'array-flat-polyfill';

const genFunction = (fname) => {
  return (...args: any[]) => {
    return sexp(fname, args);
  }
};

const genStr = (sname) => {
  return (...args: any[]) => {
    return `${sname} ${args.join(" ")}`;
  }
}

const str = (val) => {
  return `"${val}"`
}

const func = genFunction('func');
const param = genFunction('param');
const result = genFunction('result');
const exprt = genFunction('export');
const imprt = genFunction('import');
const call = genStr('call');
const memory = genFunction('memory');
const local: any = genFunction('local');
(local as any).get = genStr('local.get');
(local as any).set = genStr('local.set');

const i32 = {
  add: genStr("i32.add"),
  load: genStr("i32.load"),
  store: genStr("i32.store"),
  const: genStr("i32.const"),
}
i32.toString = () => "i32";

interface StringTable {
  [key: string]: number
}

export class Builder {
  input: Instruction[] = undefined;
  wasm_module = sexp("module");
  stringtable: StringTable = {}

  unknownInstructions = {};

  constructor(input: Instruction[]) {
    this.input = input;
    input.forEach(i => {
      if (i.type === "push-string-instruction" && this.stringtable[i.value] === undefined) {
        this.stringtable[i.value] = Object.keys(this.stringtable).length;
      }
    });
  }

  declareImport(importName: string) {
    this.wasm_module.nodes.push(
      func("$i", imprt(str("imports"), str(importName)), param(i32))
    )
  }

  build() {
    const neededLocals = [
      local("$sA", i32),
      local("$sB", i32)
    ]
    const main_instructions = this.input.map(i => {
      if (i.type === "push-string-instruction") {
        return i32.const(this.stringtable[i.value]);
      }
      if (i.type === "push-number-instruction") {
        return i32.const(i.value);
      }
      if (i.type === "invoke-function-instruction" && i.functionName === "getContext") {
        return i32.load();
      }
      if (i.type === "invoke-function-instruction" && i.functionName === "setContext") {
        /*
        In Tzo, `setContext` pops off the ADDRESS before the VALUE.
        In WASM, `.load` pops off the VALUE before the ADDRESS.
        Thus, we need to swap the top two items for WebAssembly compat.
        We use locals $sA and $sB for this
        */
        return [
          local.set("$sA"),
          local.set("$sB"),
          local.get("$sB"),
          local.get("$sA"),
          i32.store() // finally store
        ]

      }


      this.unknownInstructions[i.functionName] = (this.unknownInstructions[i.functionName] === undefined ? 0 : this.unknownInstructions[i.functionName]) + 1;
    }).flat(1).filter(i => i !== undefined);

    console.warn(`Unknown instructions: ${JSON.stringify(this.unknownInstructions, null, 2)}`);

    this.wasm_module.nodes.push(
      imprt(str("js"), str("mem"), memory(1)),
      func(
        "$main", ...neededLocals, ...main_instructions
      ),
      exprt(str("add"), func("$main"))
    )
    return this.wasm_module;
  }

}