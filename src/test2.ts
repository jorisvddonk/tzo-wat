import fs from "fs";
import program from "commander";
import { Builder } from "./build";
import wabt from "wabt";
import 'wasm-ts';
import binaryen from "binaryen";
import { assert } from "console";

const input_file = JSON.parse(fs.readFileSync(process.argv[2]).toString());

//console.log(input_file)

const builder = new Builder(input_file.input_program);
let expectedStackResultType = [];
if (input_file.expected.stack) {
  expectedStackResultType = input_file.expected.stack.map(x => binaryen.i32); // TODO: string support.... how?
}
wabt().then(w => {
  const wasm_text = builder.build(expectedStackResultType).toString();
  console.log(wasm_text);
  const module = w.parseWat('stdin', wasm_text);
  module.resolveNames()
  //module.validate();
  const binary = module.toBinary({
    log: true
  });
  fs.writeFileSync("./temp.wasm", binary.buffer);
  return binary.buffer;
}).then(async buffer => {
  let instance;
  const module = await WebAssembly.compile(buffer);
  const readStringFromMem = (offset) => {
    let str = '';
    let buf = new Uint8Array(instance.exports.pagememory.buffer);
    for (let i = offset; buf[i] > 0; i++) {
      str += String.fromCharCode(buf[i]);
    }
    return str;
  }
  instance = await (WebAssembly as any).instantiate(module, {
    env: {
      memory: new WebAssembly.Memory({ initial: 32767 }),
      table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
    },
    imports: {},
    //js: {
    //mem: new WebAssembly.Memory({ initial: 32767 }),
    //}
  });
  let retval = instance.exports.main();
  if (typeof retval === "number") {
    retval = [retval];
  }
  if (typeof retval === "undefined") {
    retval = [];
  }
  if (input_file.expected.stack !== undefined) {
    const got = JSON.stringify(retval);
    const expected = JSON.stringify(input_file.expected.stack);
    assert(got === expected, `main() return value (${got}) needs to be equal to expected stack value (${expected})`);
    console.log("Test passed!");
  }
});
