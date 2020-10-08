# Tzo-Wat

This is an experimental compiler that compiles [Tzo](https://github.com/jorisvddonk/tzo) bytecode into a WebAssembly .wat file!

## Running

1. make sure you have dependencies installed: `npm i`
2. `npm run start -- --input <path to Tzo VMState .json> --output out.wat`
3. `npx wat2wasm ./out.wat` // will likely not work!
4. `node src/test.js ./out.wasm` // will likely not work!

