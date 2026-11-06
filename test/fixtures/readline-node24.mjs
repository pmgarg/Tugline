// Preload (`node --import`) that gives Node 20/22 the Node 24+ readline behaviour
// behind R7's D13 AC1 / G7 AC2 failures on the user's Mac (Node 26): prompt()
// and setPrompt() on a closed interface throw ERR_USE_AFTER_CLOSE.
import rlp from 'node:readline/promises';

const proto = Object.getPrototypeOf(rlp.Interface.prototype);
for (const name of ['prompt', 'setPrompt']) {
  const orig = proto[name];
  proto[name] = function (...args) {
    if (this.closed) {
      const e = new Error('readline was closed');
      e.code = 'ERR_USE_AFTER_CLOSE';
      throw e;
    }
    return orig.apply(this, args);
  };
}
