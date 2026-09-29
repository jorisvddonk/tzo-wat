'use strict';
const fs = require('fs');
const { TextDecoder } = require('util');
const bytes = fs.readFileSync(process.argv[2]);

const decoder = new TextDecoder('utf-8');

(async () => {
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {
    imports: {
      pause: () => console.log('pause'),
      loadImage: (a, b, c) => console.log('loadImage', a, b, c),
      drawFrame: (a) => console.log('drawFrame', a),
      beginDraw: () => console.log('beginDraw'),
      endDraw: () => console.log('endDraw'),
      emit: (v) => console.log('emit', v),
      response: (a, b) => console.log('response', a, b),
      getResponse: () => 0,
      randInt: (max) => Math.floor(Math.random() * max),
      optionEnabled: () => 0,
      optionDisabled: () => 0,
      disableOption: () => {},
      enableOption: () => {},
    },
  });

  const readStringFromMem = (offset) => {
    const buf = new Uint8Array(instance.exports.pagememory.buffer);
    let end = offset;
    while (buf[end] !== 0) end++;
    return decoder.decode(buf.subarray(offset, end));
  };

  instance.exports.main();

  const stack = [];
  const stackSize = instance.exports.stack_size();
  for (let i = 0; i < stackSize; i++) {
    const tag = instance.exports.stack_tag(i);
    const val = instance.exports.stack_num(i);
    stack.push(tag === 1 ? readStringFromMem(val) : val);
  }

  const context = {};
  const ctxSize = instance.exports.ctx_size();
  for (let i = 0; i < ctxSize; i++) {
    const key = readStringFromMem(instance.exports.ctx_key(i));
    const tag = instance.exports.ctx_tag(i);
    const val = instance.exports.ctx_num(i);
    context[key] = tag === 1 ? readStringFromMem(val) : val;
  }

  console.log('stack:', JSON.stringify(stack));
  console.log('context:', JSON.stringify(context));
})();
