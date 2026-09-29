import fs from "fs";
import program from "commander";
import { Builder, HostImport } from "./build";
import { Instruction } from "tzo";

program
  .version('0.0.1')
  .option('--input <path>', "Load Tzo VM source .json file", "examples/cookieStore.md")
  .option('--output <path>', "Emit .wat file", "out.wat")
  .parse(process.argv);

const input_file = JSON.parse(fs.readFileSync(program.input).toString());

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

const labelMap: { [key: string]: number } = Object.assign({}, input_file.labelMap);
(input_file.programList as Instruction[]).forEach((instr: any, i: number) => {
  if (instr.label !== undefined) {
    labelMap[instr.label] = i;
  }
});

const builder = new Builder(
  input_file.programList,
  labelMap,
  input_file.context !== undefined ? input_file.context : {},
  hostImports
);
fs.writeFileSync(program.output, builder.build());
