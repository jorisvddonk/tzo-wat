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
      callback: (a) => {
        console.log("CB", a)
      }
    }
  });
  console.log(instance.exports.add(1, 5));
})();
