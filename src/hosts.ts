import { HostImport } from "./build";

export interface HostCtx {
  readString(ptr: number): string;
  writeString(s: string): number;
}

export interface TestHost extends HostImport {
  /**
   * Which parameters should be decoded from a memory pointer to a string when
   * recording the call for `expected.calls`. Defaults to "number" for all.
   */
  argKinds?: ("number" | "string")[];
  impl: (args: number[], ctx: HostCtx) => number | void;
}

/**
 * Host functions used by the host-import conformance tests. These are not the
 * game-engine calls from the CLI; they are test doubles we control, chosen to
 * exercise every aspect of the host-call ABI: zero/one/many params, argument
 * order, void and value results, string pointers in, and string pointers out.
 */
export const testHosts: { [key: string]: TestHost } = {
  noop: {
    params: [],
    impl: () => {},
  },
  addOne: {
    params: ["f64"],
    result: "f64",
    impl: (args) => args[0] + 1,
  },
  sub: {
    params: ["f64", "f64"],
    result: "f64",
    impl: (args) => args[0] - args[1],
  },
  echoStr: {
    params: ["f64"],
    argKinds: ["string"],
    impl: () => {},
  },
  greet: {
    params: ["f64"],
    argKinds: ["string"],
    result: "i32",
    resultKind: "string",
    impl: (args, ctx) => ctx.writeString("Hello, " + ctx.readString(args[0])),
  },
  repeat: {
    params: ["f64", "f64"],
    argKinds: ["string", "number"],
    result: "i32",
    resultKind: "string",
    impl: (args, ctx) => ctx.writeString(ctx.readString(args[0]).repeat(args[1])),
  },
  randInt: {
    params: ["f64"],
    result: "f64",
    impl: (args) => Math.floor(Math.random() * args[0]),
  },
};
