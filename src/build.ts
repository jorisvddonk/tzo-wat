import { Instruction } from "tzo";

export type WasmType = "f64" | "i32";

export interface HostImport {
  params: WasmType[];
  result?: WasmType;
  /** Whether a non-void result should be pushed as a number or a string. Defaults to "number". */
  resultKind?: "number" | "string";
}

const VALUE_BASE = 0;
const MAX_STACK = 65536;
const TAG_BASE = 524288;
const CTX_BASE = 786432;
const CTX_MAX = 4096;
const SCRATCH = 1048576;
const INTBUF = SCRATCH;
const OUTBUF = SCRATCH + 64;
const DATA_BASE = 1114112;

const NUM = 0;
const STR = 1;

interface BraceMap {
  [open: number]: number;
}

export class Builder {
  private instructions: Instruction[];
  private labelMap: { [key: string]: number };
  private initialContext: { [key: string]: string | number };
  private hostImports: { [key: string]: HostImport };

  private strings = new Map<string, number>();
  private dataOffset = DATA_BASE;
  private braceMap: BraceMap = {};
  private warnings: string[] = [];

  constructor(
    instructions: Instruction[],
    labelMap: { [key: string]: number } = {},
    initialContext: { [key: string]: string | number } = {},
    hostImports: { [key: string]: HostImport } = {}
  ) {
    this.instructions = instructions;
    this.labelMap = labelMap;
    this.initialContext = initialContext;
    this.hostImports = hostImports;
    this.computeBraceMap();
  }

  private computeBraceMap() {
    const stack: number[] = [];
    this.instructions.forEach((instr, i) => {
      if (instr.type !== "invoke-function-instruction") return;
      if (instr.functionName === "{") {
        stack.push(i);
      } else if (instr.functionName === "}") {
        const open = stack.pop();
        if (open === undefined) {
          throw new Error(`Unbalanced } at instruction ${i}!`);
        }
        this.braceMap[open] = i;
      }
    });
    if (stack.length > 0) {
      throw new Error(`Unbalanced { at instruction ${stack[stack.length - 1]}!`);
    }
  }

  private intern(s: string): number {
    const existing = this.strings.get(s);
    if (existing !== undefined) return existing;
    const offset = this.dataOffset;
    this.strings.set(s, offset);
    this.dataOffset += Buffer.from(s, "utf8").length + 1;
    return offset;
  }

  private internAll() {
    for (const instr of this.instructions) {
      if (instr.type === "push-string-instruction") {
        this.intern(instr.value);
      }
    }
    for (const label of Object.keys(this.labelMap)) {
      this.intern(label);
    }
    for (const [key, value] of Object.entries(this.initialContext)) {
      this.intern(key);
      if (typeof value === "string") this.intern(value);
    }
    this.intern("NaN");
    this.intern("Infinity");
    this.intern("-Infinity");
    this.intern("0");
    this.intern("");
  }

  private watString(s: string): string {
    const bytes = Array.from(Buffer.from(s, "utf8"));
    return '"' + bytes.map(b => "\\" + b.toString(16).padStart(2, "0")).join("") + "\\00" + '"';
  }

  private dataSegments(): string {
    const segments: string[] = [];
    for (const [s, offset] of this.strings.entries()) {
      segments.push(` (data (i32.const ${offset}) ${this.watString(s)})`);
    }
    return segments.join("\n");
  }

  private num(n: number): string {
    if (Number.isNaN(n)) return "(f64.const nan)";
    if (n === Infinity) return "(f64.const inf)";
    if (n === -Infinity) return "(f64.const -inf)";
    if (Object.is(n, -0)) return "(f64.const -0)";
    return `(f64.const ${n})`;
  }

  private defaultAdvance(): string {
    return `(global.set $pc (i32.add (global.get $pc) (i32.const 1))) (br $tick)`;
  }

  private body(i: number): string {
    const instr = this.instructions[i];
    if (instr.type === "push-number-instruction") {
      return `(call $push_num ${this.num(instr.value)}) ${this.defaultAdvance()}`;
    }
    if (instr.type === "push-string-instruction") {
      return `(call $push_str (i32.const ${this.intern(instr.value)})) ${this.defaultAdvance()}`;
    }

    const name = instr.functionName;
    const bin = (op: string) =>
      `(local.set $a (call $pop_num)) (local.set $b (call $pop_num)) ` +
      `(call $push_num (${op} (local.get $a) (local.get $b))) ${this.defaultAdvance()}`;
    const cmp = (op: string) =>
      `(local.set $a (call $pop_num)) (local.set $b (call $pop_num)) ` +
      `(call $push_num (f64.convert_i32_s (${op} (local.get $a) (local.get $b)))) ${this.defaultAdvance()}`;
    const bool = (op: string) =>
      `(local.set $a (call $pop_num)) (local.set $b (call $pop_num)) ` +
      `(call $push_num (f64.convert_i32_s (i32.${op} (f64.ne (local.get $a) (f64.const 0)) (f64.ne (local.get $b) (f64.const 0))))) ${this.defaultAdvance()}`;

    switch (name) {
      case "nop":
        return this.defaultAdvance();
      case "}":
        return this.defaultAdvance();
      case "{":
        return `(global.set $pc (i32.const ${this.braceMap[i] + 1})) (br $tick)`;
      case "+":
      case "plus":
        return bin("f64.add");
      case "-":
      case "min":
        return bin("f64.sub");
      case "*":
      case "mul":
        return bin("f64.mul");
      case "or":
        return bool("or");
      case "and":
        return bool("and");
      case "lt":
        return cmp("f64.lt");
      case "gt":
        return cmp("f64.gt");
      case "not":
        return `(local.set $a (call $pop_num)) (call $push_num (f64.convert_i32_s (f64.eq (local.get $a) (f64.const 0)))) ${this.defaultAdvance()}`;
      case "eq":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(local.set $tb (call $pop)) (local.set $vb (global.get $tmpval)) ` +
          `(if (i32.and (i32.eq (local.get $ta) (i32.const ${NUM})) (i32.eq (local.get $tb) (i32.const ${NUM}))) ` +
          `(then (call $push_num (f64.convert_i32_s (f64.eq (local.get $va) (local.get $vb))))) ` +
          `(else (if (i32.and (i32.eq (local.get $ta) (i32.const ${STR})) (i32.eq (local.get $tb) (i32.const ${STR}))) ` +
          `(then (call $push_num (f64.convert_i32_s (call $streq (i32.trunc_f64_u (local.get $va)) (i32.trunc_f64_u (local.get $vb)))))) ` +
          `(else (call $push_num (f64.const 0)))))) ${this.defaultAdvance()}`
        );
      case "dup":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(call $push (local.get $ta) (local.get $va)) (call $push (local.get $ta) (local.get $va)) ${this.defaultAdvance()}`
        );
      case "pop":
        return `(drop (call $pop)) ${this.defaultAdvance()}`;
      case "concat":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(local.set $tb (call $pop)) (local.set $vb (global.get $tmpval)) ` +
          `(call $push_str (call $concat (call $valToStr (local.get $ta) (local.get $va)) (call $valToStr (local.get $tb) (local.get $vb)))) ${this.defaultAdvance()}`
        );
      case "rconcat":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(local.set $tb (call $pop)) (local.set $vb (global.get $tmpval)) ` +
          `(call $push_str (call $concat (call $valToStr (local.get $tb) (local.get $vb)) (call $valToStr (local.get $ta) (local.get $va)))) ${this.defaultAdvance()}`
        );
      case "charCode":
        return `(local.set $a (call $pop_num)) (call $push_str (call $charCode (local.get $a))) ${this.defaultAdvance()}`;
      case "stacksize":
        return `(call $push_num (f64.convert_i32_u (global.get $sp))) ${this.defaultAdvance()}`;
      case "ppc":
        return `(call $push_num (f64.convert_i32_u (global.get $pc))) ${this.defaultAdvance()}`;
      case "setContext":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(local.set $tb (call $pop)) (local.set $vb (global.get $tmpval)) ` +
          `(call $ctx_set (i32.trunc_f64_u (local.get $va)) (local.get $tb) (local.get $vb)) ${this.defaultAdvance()}`
        );
      case "getContext":
        return `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) (call $ctx_get (i32.trunc_f64_u (local.get $va))) ${this.defaultAdvance()}`;
      case "hasContext":
        return `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) (call $push_num (f64.convert_i32_s (call $ctx_has (i32.trunc_f64_u (local.get $va))))) ${this.defaultAdvance()}`;
      case "delContext":
        return `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) (call $ctx_del (i32.trunc_f64_u (local.get $va))) ${this.defaultAdvance()}`;
      case "stdout":
        return (
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(drop (call $valToStr (local.get $ta) (local.get $va))) ${this.defaultAdvance()}`
        );
      case "jz":
        return (
          `(local.set $a (call $pop_num)) ` +
          `(if (f64.eq (local.get $a) (f64.const 0)) ` +
          `(then (global.set $pc (i32.add (global.get $pc) (i32.const 2)))) ` +
          `(else (global.set $pc (i32.add (global.get $pc) (i32.const 1))))) (br $tick)`
        );
      case "jgz":
        return (
          `(local.set $a (call $pop_num)) ` +
          `(if (f64.gt (local.get $a) (f64.const 0)) ` +
          `(then (global.set $pc (i32.add (global.get $pc) (i32.const 2)))) ` +
          `(else (global.set $pc (i32.add (global.get $pc) (i32.const 1))))) (br $tick)`
        );
      case "exit":
      case "pause":
        return `(global.set $halt (i32.const 1)) (br $tick)`;
      case "goto": {
        let out =
          `(local.set $ta (call $pop)) (local.set $va (global.get $tmpval)) ` +
          `(if (i32.eq (local.get $ta) (i32.const ${STR})) (then `;
        for (const [label, target] of Object.entries(this.labelMap)) {
          out += `(if (call $streq (i32.trunc_f64_u (local.get $va)) (i32.const ${this.intern(label)})) (then (global.set $pc (i32.const ${target})) (br $tick))) `;
        }
        out += `(global.set $halt (i32.const 1))) ` +
          `(else (global.set $pc (i32.trunc_f64_s (local.get $va))))) (br $tick)`;
        return out;
      }
      default:
        if (name.startsWith("_")) {
          return this.defaultAdvance();
        }
        if (this.hostImports[name]) {
          const hi = this.hostImports[name];
          const n = hi.params.length;
          let pops = "";
          for (let k = n - 1; k >= 0; k--) {
            pops += `(local.set $p${k} (call $pop_num)) `;
          }
          const args = hi.params.map((_, k) => `(local.get $p${k})`).join(" ");
          if (hi.result) {
            if (hi.resultKind === "string") {
              return `${pops}(call $push_str (call $${name} ${args})) ${this.defaultAdvance()}`;
            }
            return `${pops}(call $push_num (call $${name} ${args})) ${this.defaultAdvance()}`;
          }
          return `${pops}(call $${name} ${args}) ${this.defaultAdvance()}`;
        }
        this.warnings.push(name);
        return this.defaultAdvance();
    }
  }

  private importsSection(): string {
    const lines: string[] = [];
    for (const [name, hi] of Object.entries(this.hostImports)) {
      const params = hi.params.map(p => `(param ${p})`).join(" ");
      const result = hi.result ? ` (result ${hi.result})` : "";
      lines.push(` (import "imports" "${name}" (func $${name} ${params}${result}))`);
    }
    return lines.join("\n");
  }

  private runtime(): string {
    return `
 (global $sp (mut i32) (i32.const 0))
 (global $pc (mut i32) (i32.const 0))
 (global $halt (mut i32) (i32.const 0))
 (global $hp (mut i32) (i32.const ${this.heapBase()}))
 (global $ctx_count (mut i32) (i32.const 0))
 (global $tmpval (mut f64) (f64.const 0))
 (global $empty_str (mut i32) (i32.const ${this.intern("")}))

 (func $memcopy (param $d i32) (param $s i32) (param $n i32)
  (local $i i32)
  (block $done (loop $l
   (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
   (i32.store8 (i32.add (local.get $d) (local.get $i)) (i32.load8_u (i32.add (local.get $s) (local.get $i))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $l))))

 (func $strlen (param $p i32) (result i32)
  (local $n i32)
  (block $done (loop $l
   (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $p) (local.get $n)))))
   (local.set $n (i32.add (local.get $n) (i32.const 1)))
   (br $l)))
  (local.get $n))

 (func $streq (param $a i32) (param $b i32) (result i32)
  (local $i i32) (local $ca i32)
  (block $eq (loop $l
   (local.set $ca (i32.load8_u (i32.add (local.get $a) (local.get $i))))
   (if (i32.ne (local.get $ca) (i32.load8_u (i32.add (local.get $b) (local.get $i)))) (then (return (i32.const 0))))
   (if (i32.eqz (local.get $ca)) (then (br $eq)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $l)))
  (i32.const 1))

 (func $alloc (param $n i32) (result i32)
  (local $p i32)
  (local.set $p (global.get $hp))
  (global.set $hp (i32.add (global.get $hp) (local.get $n)))
  (local.get $p))

 (func $strdup (param $p i32) (result i32)
  (local $n i32) (local $q i32)
  (local.set $n (i32.add (call $strlen (local.get $p)) (i32.const 1)))
  (local.set $q (call $alloc (local.get $n)))
  (call $memcopy (local.get $q) (local.get $p) (local.get $n))
  (local.get $q))

 (func $concat (param $a i32) (param $b i32) (result i32)
  (local $la i32) (local $lb i32) (local $q i32)
  (local.set $la (call $strlen (local.get $a)))
  (local.set $lb (call $strlen (local.get $b)))
  (local.set $q (call $alloc (i32.add (i32.add (local.get $la) (local.get $lb)) (i32.const 1))))
  (call $memcopy (local.get $q) (local.get $a) (local.get $la))
  (call $memcopy (i32.add (local.get $q) (local.get $la)) (local.get $b) (local.get $lb))
  (i32.store8 (i32.add (local.get $q) (i32.add (local.get $la) (local.get $lb))) (i32.const 0))
  (local.get $q))

 (func $charCode (param $cpf f64) (result i32)
  (local $cp i32) (local $q i32)
  (local.set $cp (i32.trunc_f64_u (local.get $cpf)))
  (local.set $q (call $alloc (i32.const 5)))
  (if (i32.lt_u (local.get $cp) (i32.const 0x80))
   (then
    (i32.store8 (local.get $q) (local.get $cp))
    (i32.store8 (i32.add (local.get $q) (i32.const 1)) (i32.const 0))))
  (if (i32.and (i32.ge_u (local.get $cp) (i32.const 0x80)) (i32.lt_u (local.get $cp) (i32.const 0x800)))
   (then
    (i32.store8 (local.get $q) (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6))))
    (i32.store8 (i32.add (local.get $q) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 2)) (i32.const 0))))
  (if (i32.and (i32.ge_u (local.get $cp) (i32.const 0x800)) (i32.lt_u (local.get $cp) (i32.const 0x10000)))
   (then
    (i32.store8 (local.get $q) (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12))))
    (i32.store8 (i32.add (local.get $q) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 2)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 3)) (i32.const 0))))
  (if (i32.ge_u (local.get $cp) (i32.const 0x10000))
   (then
    (i32.store8 (local.get $q) (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18))))
    (i32.store8 (i32.add (local.get $q) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 2)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 3)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $q) (i32.const 4)) (i32.const 0))))
  (local.get $q))

 (func $numToStr (param $v f64) (result i32)
  (local $neg i32) (local $i i64) (local $n i32) (local $o i32) (local $frac f64) (local $d i64) (local $j i32)
  (if (f64.ne (local.get $v) (local.get $v)) (then (return (i32.const ${this.intern("NaN")}))))
  (if (f64.eq (local.get $v) (f64.const inf)) (then (return (i32.const ${this.intern("Infinity")}))))
  (if (f64.eq (local.get $v) (f64.const -inf)) (then (return (i32.const ${this.intern("-Infinity")}))))
  (if (f64.eq (local.get $v) (f64.const 0)) (then (return (i32.const ${this.intern("0")}))))
  (if (f64.lt (local.get $v) (f64.const 0))
   (then (local.set $neg (i32.const 1)) (local.set $v (f64.neg (local.get $v)))))
  (local.set $i (i64.trunc_f64_u (local.get $v)))
  (local.set $frac (f64.sub (local.get $v) (f64.convert_i64_u (local.get $i))))
  (if (i64.eqz (local.get $i))
   (then (i32.store8 (i32.const ${INTBUF}) (i32.const 48)) (local.set $n (i32.const 1)))
   (else (block $idone (loop $il
    (br_if $idone (i64.eqz (local.get $i)))
    (i32.store8 (i32.add (i32.const ${INTBUF}) (local.get $n)) (i32.add (i32.wrap_i64 (i64.rem_u (local.get $i) (i64.const 10))) (i32.const 48)))
    (local.set $n (i32.add (local.get $n) (i32.const 1)))
    (local.set $i (i64.div_u (local.get $i) (i64.const 10)))
    (br $il)))))
  (local.set $o (i32.const 0))
  (if (local.get $neg) (then (i32.store8 (i32.const ${OUTBUF}) (i32.const 45)) (local.set $o (i32.const 1))))
  (local.set $j (local.get $n))
  (block $odone (loop $ol
   (br_if $odone (i32.eqz (local.get $j)))
   (local.set $j (i32.sub (local.get $j) (i32.const 1)))
   (i32.store8 (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.load8_u (i32.add (i32.const ${INTBUF}) (local.get $j))))
   (local.set $o (i32.add (local.get $o) (i32.const 1)))
   (br $ol)))
  (if (f64.gt (local.get $frac) (f64.const 0))
   (then
    (i32.store8 (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.const 46))
    (local.set $o (i32.add (local.get $o) (i32.const 1)))
    (local.set $j (i32.const 0))
    (block $fdone (loop $fl
     (br_if $fdone (i32.ge_u (local.get $j) (i32.const 17)))
     (local.set $frac (f64.mul (local.get $frac) (f64.const 10)))
     (local.set $d (i64.trunc_f64_u (local.get $frac)))
     (i32.store8 (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.add (i32.wrap_i64 (local.get $d)) (i32.const 48)))
     (local.set $o (i32.add (local.get $o) (i32.const 1)))
     (local.set $frac (f64.sub (local.get $frac) (f64.convert_i64_u (local.get $d))))
     (local.set $j (i32.add (local.get $j) (i32.const 1)))
     (br_if $fdone (f64.lt (local.get $frac) (f64.const 0.0000000001)))
     (br $fl)))
    (block $tdone (loop $tl
     (br_if $tdone (i32.le_u (local.get $o) (i32.const 2)))
     (br_if $tdone (i32.ne (i32.load8_u (i32.sub (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.const 1))) (i32.const 48)))
     (local.set $o (i32.sub (local.get $o) (i32.const 1)))
     (br $tl)))
    (if (i32.eq (i32.load8_u (i32.sub (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.const 1))) (i32.const 46))
     (then (local.set $o (i32.sub (local.get $o) (i32.const 1)))))))
  (i32.store8 (i32.add (i32.const ${OUTBUF}) (local.get $o)) (i32.const 0))
  (call $strdup (i32.const ${OUTBUF})))

 (func $valToStr (param $tag i32) (param $val f64) (result i32)
  (if (i32.eq (local.get $tag) (i32.const ${STR})) (then (return (i32.trunc_f64_u (local.get $val)))))
  (call $numToStr (local.get $val)))

 (func $push (param $tag i32) (param $val f64)
  (f64.store (i32.add (i32.const ${VALUE_BASE}) (i32.mul (global.get $sp) (i32.const 8))) (local.get $val))
  (i32.store (i32.add (i32.const ${TAG_BASE}) (i32.mul (global.get $sp) (i32.const 4))) (local.get $tag))
  (global.set $sp (i32.add (global.get $sp) (i32.const 1))))

 (func $push_num (param $v f64) (call $push (i32.const ${NUM}) (local.get $v)))
 (func $push_str (param $p i32) (call $push (i32.const ${STR}) (f64.convert_i32_u (local.get $p))))

 (func $pop (result i32)
  (global.set $sp (i32.sub (global.get $sp) (i32.const 1)))
  (global.set $tmpval (f64.load (i32.add (i32.const ${VALUE_BASE}) (i32.mul (global.get $sp) (i32.const 8)))))
  (i32.load (i32.add (i32.const ${TAG_BASE}) (i32.mul (global.get $sp) (i32.const 4)))))

 (func $pop_num (result f64) (drop (call $pop)) (global.get $tmpval))

 (func $ctx_find (param $key i32) (param $create i32) (result i32)
  (local $i i32) (local $e i32)
  (block $found (loop $l
   (br_if $found (i32.ge_u (local.get $i) (global.get $ctx_count)))
   (local.set $e (i32.add (i32.const ${CTX_BASE}) (i32.mul (local.get $i) (i32.const 16))))
   (if (call $streq (i32.load (local.get $e)) (local.get $key)) (then (return (local.get $e))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $l)))
  (if (local.get $create)
   (then
    (local.set $e (i32.add (i32.const ${CTX_BASE}) (i32.mul (global.get $ctx_count) (i32.const 16))))
    (i32.store (local.get $e) (local.get $key))
    (i32.store (i32.add (local.get $e) (i32.const 4)) (i32.const 0))
    (f64.store (i32.add (local.get $e) (i32.const 8)) (f64.const 0))
    (global.set $ctx_count (i32.add (global.get $ctx_count) (i32.const 1)))
    (return (local.get $e))))
  (i32.const 0))

 (func $ctx_set (param $key i32) (param $tag i32) (param $val f64)
  (local $e i32)
  (local.set $e (call $ctx_find (local.get $key) (i32.const 1)))
  (i32.store (i32.add (local.get $e) (i32.const 4)) (local.get $tag))
  (f64.store (i32.add (local.get $e) (i32.const 8)) (local.get $val)))

 (func $ctx_get (param $key i32)
  (local $e i32)
  (local.set $e (call $ctx_find (local.get $key) (i32.const 0)))
  (if (local.get $e)
   (then (call $push (i32.load (i32.add (local.get $e) (i32.const 4))) (f64.load (i32.add (local.get $e) (i32.const 8)))))
   (else (call $push_num (f64.const 0)))))

 (func $ctx_has (param $key i32) (result i32)
  (i32.ne (call $ctx_find (local.get $key) (i32.const 0)) (i32.const 0)))

 (func $ctx_del (param $key i32)
  (local $i i32)
  (block $done (loop $l
   (br_if $done (i32.ge_u (local.get $i) (global.get $ctx_count)))
   (if (call $streq (i32.load (i32.add (i32.const ${CTX_BASE}) (i32.mul (local.get $i) (i32.const 16)))) (local.get $key))
    (then
     (global.set $ctx_count (i32.sub (global.get $ctx_count) (i32.const 1)))
     (if (i32.lt_u (local.get $i) (global.get $ctx_count))
      (then (call $memcopy
       (i32.add (i32.const ${CTX_BASE}) (i32.mul (local.get $i) (i32.const 16)))
       (i32.add (i32.const ${CTX_BASE}) (i32.mul (global.get $ctx_count) (i32.const 16)))
       (i32.const 16))))
     (br $done)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $l))))

 (func (export "alloc") (param $n i32) (result i32) (call $alloc (local.get $n)))
 (func (export "stack_size") (result i32) (global.get $sp))
 (func (export "stack_tag") (param $i i32) (result i32)
  (i32.load (i32.add (i32.const ${TAG_BASE}) (i32.mul (local.get $i) (i32.const 4)))))
 (func (export "stack_num") (param $i i32) (result f64)
  (f64.load (i32.add (i32.const ${VALUE_BASE}) (i32.mul (local.get $i) (i32.const 8)))))
 (func (export "ctx_size") (result i32) (global.get $ctx_count))
 (func (export "ctx_key") (param $i i32) (result i32)
  (i32.load (i32.add (i32.const ${CTX_BASE}) (i32.mul (local.get $i) (i32.const 16)))))
 (func (export "ctx_tag") (param $i i32) (result i32)
  (i32.load (i32.add (i32.const ${CTX_BASE + 4}) (i32.mul (local.get $i) (i32.const 16)))))
 (func (export "ctx_num") (param $i i32) (result f64)
  (f64.load (i32.add (i32.const ${CTX_BASE + 8}) (i32.mul (local.get $i) (i32.const 16)))))
 (func (export "get_pc") (result i32) (global.get $pc))
`;
  }

  private heapBase(): number {
    return Math.ceil(this.dataOffset / 16) * 16;
  }

  private pages(): number {
    return Math.max(64, Math.ceil((this.heapBase() + (1 << 20)) / 65536));
  }

  build(): string {
    this.internAll();

    let init = "";
    for (const [key, value] of Object.entries(this.initialContext)) {
      const keyPtr = this.intern(key);
      if (typeof value === "number") {
        init += ` (call $ctx_set (i32.const ${keyPtr}) (i32.const ${NUM}) ${this.num(value)})\n`;
      } else {
        init += ` (call $ctx_set (i32.const ${keyPtr}) (i32.const ${STR}) (f64.convert_i32_u (i32.const ${this.intern(value)})))\n`;
      }
    }

    let dispatch = "";
    this.instructions.forEach((_, i) => {
      dispatch += `(if (i32.eq (global.get $pc) (i32.const ${i})) (then ${this.body(i)}))\n`;
    });

    return `(module${this.importsSection()}
 (memory (export "pagememory") ${this.pages()})
${this.runtime()}
 (func (export "main")
  (local $a f64) (local $b f64) (local $ta i32) (local $va f64) (local $tb i32) (local $vb f64)
  (local $p0 f64) (local $p1 f64) (local $p2 f64) (local $p3 f64)
${init}
  (block $done (loop $tick
   (br_if $done (i32.ge_u (global.get $pc) (i32.const ${this.instructions.length})))
   (br_if $done (global.get $halt))
${dispatch}
   (br $done)))
)
${this.dataSegments()})
`;
  }
}
