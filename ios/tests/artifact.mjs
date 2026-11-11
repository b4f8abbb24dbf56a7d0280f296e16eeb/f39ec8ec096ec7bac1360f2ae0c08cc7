import assert from 'node:assert/strict';
import { hasMachOSignature } from '../artifact.mjs';
const image = (signed = false) => {
  const b = Buffer.alloc(signed ? 64 : 32);
  b.writeUInt32LE(0xfeedfacf, 0);
  if (signed) {
    b.writeUInt32LE(1, 16); b.writeUInt32LE(16, 20);
    b.writeUInt32LE(0x1d, 32); b.writeUInt32LE(16, 36);
    b.writeUInt32LE(48, 40); b.writeUInt32LE(16, 44);
  }
  return b;
};
assert.equal(hasMachOSignature(image()), false);
assert.equal(hasMachOSignature(image(true)), true);
for (const [offset, value] of [[0,0],[16,2],[20,100],[36,8],[40,0],[40,65],[44,0],[44,100]]) {
  const b=image(true);b.writeUInt32LE(value,offset);assert.throws(()=>hasMachOSignature(b));
}
for(let n=0;n<32;n++) assert.throws(()=>hasMachOSignature(image().subarray(0,n)));
console.log('Native test-artifact signature detection regressions passed');
