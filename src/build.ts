import { Instruction } from "tzo";
import sexp from "node-sexp";
import 'array-flat-polyfill';
import { Analyzer } from "tzo-analyze";
import { Expression } from "tzo-analyze/dist/interfaces";

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
const nop = genStr('nop');
const memory = genFunction('memory');
const local: any = genFunction('local');
(local as any).get = genStr('get_local');
(local as any).set = genStr('set_local');

const i32 = {
  add: genStr("i32.add"),
  load: genStr("i32.load"),
  store: genStr("i32.store"),
  const: genStr("i32.const"),
  eq: genStr("i32.eq"),
}
i32.toString = () => "i32";

interface StringTable {
  [key: string]: number
}

type WasmExpression = Expression & { value: string, conditionBody?: WasmExpression[], thenBody?: WasmExpression[] };

export class Builder {
  imports: string[] = [];
  input: Instruction[] = undefined;
  analysis: WasmExpression[] = [];
  wasm_module = sexp("module");
  stringtable: StringTable = {}

  unknownInstructions = {};

  constructor(input: Instruction[]) {
    const analyzer = new Analyzer(input, {
      beginDraw: {
        in: [],
        out: []
      },
      endDraw: {
        in: [],
        out: []
      },
      drawFrame: {
        in: [
          "number"
        ],
        out: []
      },
      loadImage: {
        in: [
          "string",
          "number",
          "number"
        ],
        out: []
      }
    });
    this.input = input;
    input.forEach(i => {
      if (i.type === "push-string-instruction" && this.stringtable[i.value] === undefined) {
        this.stringtable[i.value] = Object.keys(this.stringtable).length;
      }
    });
    let analysis: WasmExpression[] = analyzer.getExpressions() as WasmExpression[];
    analysis = this.analyze(analysis);
    this.analysis = analysis;
  }

  analyze: (expressions: Expression[]) => WasmExpression[] | undefined = (expressions) => {
    if (expressions === undefined) {
      return undefined;
    }
    expressions = expressions.filter(f => f !== undefined);
    const retval: WasmExpression[] = [];
    for (let i = expressions.length - 1; i >= 0; i--) {
      if (i > 0) {
        const ei = expressions[i];
        const ei2 = expressions[i - 1];
        if (ei2.type === "function" && ei2.value === "jgz" && ei.type === "block" && ei.value === "{}") {
          const ei_children_analysis = this.analyze(ei.children);
          const ei2_children_analysis = this.analyze(ei2.children);
          retval.unshift({
            type: ei.type,
            value: "if",
            consumes: ei.consumes,
            produces: ei.produces,
            conditionBody: ei2_children_analysis,
            thenBody: ei_children_analysis,
            children: undefined
          });
          i -= 1;
          continue;
        }
      }
      const ei = expressions[i] as any;
      retval.unshift({
        type: ei.type,
        value: ei.value,
        consumes: ei.consumes,
        produces: ei.produces,
        children: this.analyze(ei.children),
      });
    }
    return retval;
  }

  expressionToString(expression: WasmExpression) {
    if (expression.type === "block" && expression.value === "if") {
      return `${this.treeToString(expression.conditionBody)}
if $I0
${this.treeToString(expression.thenBody)}
end`;
    }
    if (expression.type === "number_literal") {
      return this.convertInstruction({ type: "push-number-instruction", value: expression.value });
    }
    if (expression.type === "string_literal") {
      return this.convertInstruction({ type: "push-string-instruction", value: expression.value });
    }
    return `${this.treeToString(expression.children as WasmExpression[])}
${(this.convertInstruction({
      type: "invoke-function-instruction",
      functionName: expression.value
    }) || "").toString()}`;
  }

  treeToString(expressions: WasmExpression[]) {
    return expressions.map(x => this.expressionToString(x)).join('\n');
  }

  declareImport(importName: string, params?) {
    if (params === undefined) {
      params = [];
    }
    this.imports.push(importName);
    this.wasm_module.nodes.push(
      func(`$${importName}`, imprt(str("imports"), str(importName)), ...params)
    )
  }

  convertInstruction(i: Instruction) {
    function c(instr: (Instruction | string)[]) {
      return instr.map(x => x.toString()).join('\n');
    }

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
      return c([
        local.set("$sA"),
        local.set("$sB"),
        local.get("$sB"),
        local.get("$sA"),
        i32.store() // finally store
      ]);
    }
    if (i.functionName === "not") {
      return c([
        i32.const(1),
        i32.eq(),
        `if $I0 (result i32)`,
        i32.const(0),
        `else`,
        i32.const(1),
        `end`
      ])
    }
    if (i.functionName === "+" || i.functionName === "plus") {
      return i32.add();
    }
    if (i.functionName === "nop") {
      return nop();
    }
    if (i.functionName === "eq") {
      return i32.eq();
    }
    if (i.functionName === "pause") {
      return call('$pause');
    }

    if (this.imports.includes(i.functionName)) {
      return call(`$${i.functionName}`);
    }


    this.unknownInstructions[i.functionName] = (this.unknownInstructions[i.functionName] === undefined ? 0 : this.unknownInstructions[i.functionName]) + 1;

  }

  build() {
    const neededLocals = [
      local("$sA", i32),
      local("$sB", i32)
    ]

    this.wasm_module.nodes.push(
      imprt(str("js"), str("mem"), memory(1)),
      func(
        "$main", ...neededLocals, '\n', this.treeToString(this.analysis)
      ),
      exprt(str("main"), func("$main"))
    )

    console.warn(`Unknown instructions: ${JSON.stringify(this.unknownInstructions, null, 2)}`);

    return this.wasm_module;
  }

}