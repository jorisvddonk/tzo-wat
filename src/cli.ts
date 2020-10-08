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

fs.writeFileSync(program.output, builder.build().toString());