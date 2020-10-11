import { Instruction } from "tzo";
import 'array-flat-polyfill';
import { Analyzer } from "tzo-analyze";
import { Expression } from "tzo-analyze/dist/interfaces";
import binaryen from "binaryen";

interface StringTable {
  [key: string]: number
}

type WasmExpression = Expression & { value: string, conditionBody?: WasmExpression[], thenBody?: WasmExpression[] };

export class Builder {
  imports: string[] = [];
  input: Instruction[] = undefined;
  analysis: WasmExpression[] = [];
  stringtable: StringTable = {};
  strtbl_i = 0;
  module = new binaryen.Module();
  binaryen_imports = {};

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
      },
      getResponse: {
        in: [],
        out: []
      },
      emit: {
        in: ["string | number"],
        out: []
      },
      response: {
        in: ["string", "number"],
        out: []
      }
    });
    this.input = input;
    input.forEach(i => {
      if (i.type === "push-string-instruction" && this.stringtable[i.value] === undefined) {
        this.stringtable[i.value] = this.strtbl_i;
        this.strtbl_i += i.value.length + 1;
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
            consumes: ei2.consumes,
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
      if (ei.type === "function" && ei.value === "setContext") {
        /*
        In Tzo, `setContext` pops off the ADDRESS before the VALUE.
        In WASM, `.store` pops off the VALUE before the ADDRESS.
        Thus, we need to swap the children for WebAssembly compat.
        */
        ei.children = ei.children.reverse();
      }
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

  expressionToBinaryen: (expression: WasmExpression) => number = (expression: WasmExpression) => {
    function assertLength(children: (Expression | WasmExpression)[], maxLength: number, helpText?: string) {
      if (children.length > maxLength) {
        throw new Error(`Too many children (${children.length})${helpText !== undefined ? ' ' + helpText : ''}!`);
      }
    }
    if (expression.type === "block" && expression.value === "if") {
      assertLength(expression.conditionBody, 1, 'in if statement condition body')
      return this.module.if(this.expressionToBinaryen(expression.conditionBody[0]), this.module.block(null, expression.thenBody.map(c => {
        return this.expressionToBinaryen(c);
      })));
    }
    if (expression.type === "number_literal") {
      return this.module.i32.const(expression.value);
    }
    if (expression.type === "string_literal") {
      return this.module.i32.const(this.stringtable[expression.value]);
    }
    if (expression.type === "function" && expression.value === "goto") {
      // skip gotos!
      this.unknownInstructions["goto"] = (this.unknownInstructions["goto"] === undefined ? 0 : this.unknownInstructions["goto"]) + 1;
      return this.module.nop();
    }

    if (expression.type === "block" && expression.value === "{}") {
      return this.module.block(null, expression.children.map((c: WasmExpression) => {
        return this.expressionToBinaryen(c);
      }));
    }

    const children = expression.children as WasmExpression[];

    if (expression.value === "getContext") {
      assertLength(expression.children, 1, "(getContext)");
      return this.module.i32.load(0, 2, this.expressionToBinaryen(children[0]));
    } else if (expression.value === "setContext") {
      assertLength(expression.children, 2, "(setContext)");
      return this.module.i32.store(0, 2, this.expressionToBinaryen(children[0]), this.expressionToBinaryen(children[1]))
    } else if (expression.value === "or") {
      assertLength(expression.children, 2, "(or)");
      // TODO: align with actual Tzo spec!!? (needs testing!)
      return this.module.i32.or(this.module.i32.ne(this.module.i32.const(0), this.expressionToBinaryen(children[0])), this.module.i32.ne(this.module.i32.const(0), this.expressionToBinaryen(children[1])));
    } else if (expression.value === "and") {
      assertLength(expression.children, 2, "(and)");
      // TODO: align with actual Tzo spec!!? (needs testing!)
      return this.module.i32.and(this.module.i32.ne(this.module.i32.const(0), this.expressionToBinaryen(children[0])), this.module.i32.ne(this.module.i32.const(0), this.expressionToBinaryen(children[1])));
    } else if (expression.value === "eq") {
      assertLength(expression.children, 2, "(eq)");
      return this.module.i32.eq(this.expressionToBinaryen(children[0]), this.expressionToBinaryen(children[1]));
    } else if (expression.value === "not") {
      assertLength(expression.children, 1, "(not)");
      return this.module.if(this.module.i32.eq(this.expressionToBinaryen(children[0]), this.module.i32.const(1)), this.module.i32.const(0), this.module.i32.const(1))
    } else if (expression.value === "+" || expression.value === "plus") {
      assertLength(expression.children, 2, "(plus)");
      return this.module.i32.add(this.expressionToBinaryen(children[0]), this.expressionToBinaryen(children[1]));
    } else if (expression.value === "-" || expression.value === "min") {
      assertLength(expression.children, 2, "(min)");
      return this.module.i32.sub(this.expressionToBinaryen(children[0]), this.expressionToBinaryen(children[1]));
    } else if (expression.value === "*" || expression.value === "mul") {
      assertLength(expression.children, 2, "(mul)");
      return this.module.i32.mul(this.expressionToBinaryen(children[0]), this.expressionToBinaryen(children[1]));
    } else if (expression.value === "nop") {
      return this.module.nop();
    }

    if (this.imports.includes(expression.value)) {
      const b_import = this.binaryen_imports[expression.value];
      const params = (expression.children as WasmExpression[]).map(c => this.expressionToBinaryen(c))
      return this.module.call(expression.value, params, b_import.result);
    }

    throw new Error(`Unimplemented Tzo parsed code type/value: ${expression.type} // ${expression.value}`);
  }

  treeToBinaryen(expressions: WasmExpression[]) {
    return expressions.map(x => this.expressionToBinaryen(x));
  }

  declareImport(importName: string, params?, results?) {
    const paramTypeToBinaryenType = (t: string) => {
      if (t === "(param i32)" || t === "(result i32)") {
        return binaryen.i32;
      }
      if (t === "(param i64)" || t === "(result i64)") {
        return binaryen.i64;
      }
    }
    if (params === undefined) {
      params = [];
    }
    if (results === undefined) {
      results = [];
    }
    this.imports.push(importName);
    const b_params = binaryen.createType(params.map(c => paramTypeToBinaryenType(c)));
    const b_results = binaryen.createType(results.map(c => paramTypeToBinaryenType(c)));
    this.module.addFunctionImport(importName, "imports", importName, b_params, b_results);
    this.binaryen_imports[importName] = {
      params: b_params,
      result: b_results
    }
  }

  getDatas_binaryen() {
    return Object.entries(this.stringtable).map(entry => {
      return {
        data: Uint8Array.from(entry[0].split("").map(x => x.charCodeAt(0)).concat([0])),
        offset: this.module.i32.const(entry[1]),
        passive: false
      }
    });
  }

  build() {
    this.module.setMemory(1, 1, "pagememory", this.getDatas_binaryen());

    this.module.addFunction("main", binaryen.createType([]), binaryen.none, [binaryen.i32, binaryen.i32], this.module.block(null,
      this.treeToBinaryen(this.analysis)
    ));
    this.module.addFunctionExport("main", "main");

    console.warn(`Unknown instructions: ${JSON.stringify(this.unknownInstructions, null, 2)}`);

    this.module.optimize();
    return this.module.emitText();
  }

}