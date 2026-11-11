import assert from 'node:assert/strict';
import { hasMachOSignature, copyOverlayNotices } from '../artifact.mjs';
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

const { mkdtemp, readFile, rm } = await import('node:fs/promises');
const { join, resolve } = await import('node:path');
const { tmpdir } = await import('node:os');
const temporary = await mkdtemp(join(tmpdir(), 'nx2ipa-notices-'));
try {
  await copyOverlayNotices(temporary);
  assert.equal(await readFile(join(temporary, 'ThirdPartyNotices/NX2Apple.txt'), 'utf8'),
    await readFile(resolve(import.meta.dir, '../shell/overlay/LICENSE'), 'utf8'));
  assert.equal(await readFile(join(temporary, 'ThirdPartyNotices/NX2Apple-source.json'), 'utf8'),
    await readFile(resolve(import.meta.dir, '../shell/overlay/SOURCE.json'), 'utf8'));
  console.log('Native app retains the complete overlay license and source attribution');
} finally { await rm(temporary, { recursive: true, force: true }); }
