import { Instruction } from "tzo";
import sexp from "node-sexp";

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
const local = {
  get: genStr('local.get')
}
const i32 = {
  add: genStr("i32.add")
}
i32.toString = () => "i32";

export class Builder {
  input: Instruction[] = undefined;
  wasm_module = sexp("module");
  constructor(input) {
    this.input = input;
  }

  build() {
    this.wasm_module.nodes.push(
      func("$i", imprt(str("imports"), str("callback")), param(i32)),
      func(
        "$add", param(i32), param(i32), local.get(0), local.get(1), i32.add(), call('$i')
      ),
      exprt(str("add"), func("$add"))
    )
    return this.wasm_module;
  }

}