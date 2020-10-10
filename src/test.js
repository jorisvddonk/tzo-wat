'use strict';
const fs = require('fs');
const bytes = fs.readFileSync(process.argv[2]);

(async () => {
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {
    env: {
      memory: new WebAssembly.Memory({ initial: 256 }),
      table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
    },
    imports: {
      pause: () => {
        console.log("pause")
      },
      loadImage: (a, b, c) => {
        console.log("loadImage", a, b, c)
      },
      drawFrame: () => {
        console.log("drawFrame")
      },
      beginDraw: () => {
        console.log("beginDraw")
      },
      endDraw: () => {
        console.log("endDraw")
      },
      randInt: (i) => {
        return Math.floor(Math.random() * i)
      },
    },
    js: {
      mem: new WebAssembly.Memory({ initial: 256 }),
    }
  });
  console.log(instance.exports.main(1, 5));
})();
