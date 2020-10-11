import fs from "fs";
import program from "commander";
import { Builder } from "./build";

program
  .version('0.0.1')
  .option('--input <path>', "Load Tzo VM source .json file", "examples/cookieStore.md")
  .option('--output <path>', "Emit .wat file", "out.wat")
  .parse(process.argv);

const input_file = JSON.parse(fs.readFileSync(program.input).toString());

const builder = new Builder(input_file.programList);
builder.declareImport("pause");
builder.declareImport("loadImage", [`(param i32)`, `(param i32)`, `(param i32)`]);
builder.declareImport("beginDraw");
builder.declareImport("drawFrame", [`(param i32)`]);
builder.declareImport("randInt", [`(param i32)`], [`(result i32)`]);
builder.declareImport("endDraw");
builder.declareImport("getResponse");
builder.declareImport("emit", [`(param i32)`]);
builder.declareImport("response", [`(param i32)`, `(param i32)`]);
fs.writeFileSync(program.output, builder.build().toString());