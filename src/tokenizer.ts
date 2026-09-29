import type { Instruction } from "tzo";

export interface ConciseProgram {
  instructions: Instruction[];
  labelMap: { [key: string]: number };
}

const NUMBER = /^-?[0-9]+\.?[0-9]*$/;

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/**
 * Parse Tzo concise syntax into a Standard Representation program list + label map.
 *
 * Follows the ConciseText grammar from the tzo repository: labels are a suffix on
 * the instruction they label (`nop #main`), numbers may be decimal, strings support
 * backslash-escaped quotes and backslashes, and line and block comments are skipped.
 */
export function parseConcise(code: string): ConciseProgram {
  const instructions: Instruction[] = [];
  const labelMap: { [key: string]: number } = {};
  const n = code.length;
  let i = 0;

  const atCommentStart = () =>
    code[i] === "/" && (code[i + 1] === "/" || code[i + 1] === "*");

  function skipTrivia() {
    while (i < n) {
      const c = code[i];
      if (isWhitespace(c)) {
        i++;
      } else if (code[i] === "/" && code[i + 1] === "/") {
        i += 2;
        while (i < n && code[i] !== "\n" && code[i] !== "\r") i++;
      } else if (code[i] === "/" && code[i + 1] === "*") {
        i += 2;
        while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
        i += 2;
      } else {
        break;
      }
    }
  }

  function readWord(): string {
    let s = "";
    while (i < n && !isWhitespace(code[i]) && code[i] !== "#" && !atCommentStart()) {
      s += code[i];
      i++;
    }
    return s;
  }

  function maybeLabel(instr: Instruction) {
    const save = i;
    while (i < n && isWhitespace(code[i])) i++;
    if (code[i] === "#") {
      i++;
      const label = readWord();
      (instr as any).label = label;
      labelMap[label] = instructions.length - 1;
    } else {
      i = save;
    }
  }

  while (true) {
    skipTrivia();
    if (i >= n) break;
    const c = code[i];

    if (c === '"') {
      i++;
      let value = "";
      while (i < n && code[i] !== '"') {
        if (code[i] === "\\" && (code[i + 1] === '"' || code[i + 1] === "\\")) {
          value += code[i + 1];
          i += 2;
        } else {
          value += code[i];
          i++;
        }
      }
      i++;
      const instr = { type: "push-string-instruction", value } as Instruction;
      instructions.push(instr);
      maybeLabel(instr);
    } else if (c === "#") {
      i++;
      const label = readWord();
      labelMap[label] = instructions.length > 0 ? instructions.length - 1 : 0;
      if (instructions.length > 0) {
        (instructions[instructions.length - 1] as any).label = label;
      }
    } else {
      const token = readWord();
      if (token.length === 0) {
        i++;
        continue;
      }
      const instr = NUMBER.test(token)
        ? ({ type: "push-number-instruction", value: parseFloat(token) } as Instruction)
        : ({ type: "invoke-function-instruction", functionName: token } as Instruction);
      instructions.push(instr);
      maybeLabel(instr);
    }
  }

  return { instructions, labelMap };
}
