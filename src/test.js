'use strict';
const fs = require('fs');
const bytes = fs.readFileSync(process.argv[2]);

(async () => {
  let instance;
  const module = await WebAssembly.compile(bytes);
  const readStringFromMem = (offset) => {
    let str = '';
    let buf = new Uint8Array(instance.exports.pagememory.buffer);
    for (let i = offset; buf[i] > 0; i++) {
      str += String.fromCharCode(buf[i]);
    }
    return str;
  }
  instance = await WebAssembly.instantiate(module, {
    env: {
      memory: new WebAssembly.Memory({ initial: 32767 }),
      table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
    },
    imports: {
      pause: () => {
        console.log("pause")
      },
      loadImage: (a, b, strOffset) => {
        console.log("loadImage", a, b, readStringFromMem(strOffset))
      },
      drawFrame: (a) => {
        console.log("drawFrame", a)
      },
      beginDraw: () => {
        console.log("beginDraw")
      },
      endDraw: () => {
        console.log("endDraw")
      },
      emit: (a) => {
        console.log("emit", a)
      },
      randInt: (i) => {
        return Math.floor(Math.random() * i)
      },
    },
    /*js: {
      mem: new WebAssembly.Memory({ initial: 32767 }),
    }*/
  });
  console.log(instance.exports.main());
})();
