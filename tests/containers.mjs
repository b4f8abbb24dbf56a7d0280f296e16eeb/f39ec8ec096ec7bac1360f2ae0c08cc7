// Entirely authored test data and public, artificial keys. No Nintendo game data.
import { createCipheriv, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import jpeg from "jpeg-js";
import { shaderContainer } from "./fixture.mjs";
const enc = new TextEncoder();
const title = 0x0100000000000000n;
const headerKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const areaKey = Buffer.alloc(16, 0x43), sectionKey = Buffer.alloc(16, 0x71);
const keys = enc.encode(`header_key = ${headerKey.toString("hex")}\nkey_area_key_application_00 = ${areaKey.toString("hex")}\n`);
const pixels = new Uint8Array(256 * 256 * 4);
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  pixels[(y * 256 + x) * 4 + (x < 128 ? 0 : 2)] = 255;
  pixels[(y * 256 + x) * 4 + 3] = 255;
}
export const gameIcon = new Uint8Array(jpeg.encode({ width: 256, height: 256, data: pixels }, 90).data);
const hash = (b) => createHash("sha256").update(b).digest();
const align = (n, size = 0x200) => Math.ceil(n / size) * size;
const u32 = (b, o, n) => b.writeUInt32LE(n, o);
const u64 = (b, o, n) => b.writeBigUInt64LE(BigInt(n), o);
function crypt(algorithm, key, iv, input) {
  const c = createCipheriv(algorithm, key, iv); c.setAutoPadding(false);
  return Buffer.concat([c.update(input), c.final()]);
}
function xtsHeaderSector(input, sector) {
  const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(sector), 8);
  const tweak = crypt("aes-128-ecb", headerKey.subarray(16), null, iv);
  const out = Buffer.alloc(input.length);
  for (let at = 0; at < input.length; at += 16) {
    const block = Buffer.from(input.subarray(at, at + 16));
    for (let j = 0; j < 16; j++) block[j] ^= tweak[j];
    const encrypted = crypt("aes-128-ecb", headerKey.subarray(0, 16), null, block);
    for (let j = 0; j < 16; j++) out[at + j] = encrypted[j] ^ tweak[j];
    let carry = 0;
    for (let j = 0; j < 16; j++) {
      const next = tweak[j] >>> 7; tweak[j] = ((tweak[j] << 1) | carry) & 255; carry = next;
    }
    if (carry) tweak[0] ^= 0x87;
  }
  return out;
}
function partition(files, hfs = false) {
  const width = hfs ? 64 : 24;
  const names = Buffer.from(files.map(([name]) => name + "\0").join(""));
  const head = Buffer.alloc(16 + width * files.length + names.length);
  head.write(hfs ? "HFS0" : "PFS0"); u32(head, 4, files.length); u32(head, 8, names.length);
  let offset = 0, nameOffset = 0;
  files.forEach(([name, data], i) => {
    const at = 16 + i * width;
    u64(head, at, offset); u64(head, at + 8, data.length); u32(head, at + 16, nameOffset);
    if (hfs) { u32(head, at + 20, data.length); hash(data).copy(head, at + 32); }
    offset += data.length; nameOffset += Buffer.byteLength(name) + 1;
  });
  names.copy(head, 16 + width * files.length);
  return Buffer.concat([head, ...files.map(([, data]) => data)]);
}
function pfsSection(files) {
  const data = partition(files), bs = 4096;
  const table = Buffer.concat(Array.from({ length: Math.ceil(data.length / bs) }, (_, i) => hash(data.subarray(i * bs, (i + 1) * bs))));
  const at = align(table.length), section = Buffer.alloc(align(at + data.length));
  table.copy(section); data.copy(section, at);
  const fs = Buffer.alloc(512); fs[2] = 1; fs[3] = 2; fs[4] = 3;
  hash(table).copy(fs, 8); u32(fs, 0x28, bs); u32(fs, 0x2c, 2);
  u64(fs, 0x38, table.length); u64(fs, 0x40, at); u64(fs, 0x48, data.length);
  return { fs, section };
}
function romSection(files) {
  const entries = files.map(([name, data]) => {
    const entry = Buffer.alloc(align(32 + Buffer.byteLength(name), 4));
    u32(entry, 4, 0xffffffff); u64(entry, 16, data.length); u32(entry, 24, 0xffffffff);
    u32(entry, 28, Buffer.byteLength(name)); entry.write(name, 32); return entry;
  });
  let offset = 0, dataOffset = 0;
  entries.forEach((entry, i) => {
    if (i + 1 < entries.length) u32(entry, 4, offset + entry.length);
    u64(entry, 8, dataOffset); offset += entry.length; dataOffset += files[i][1].length;
  });
  const head = Buffer.alloc(0x68); u64(head, 0, 0x50); u64(head, 0x18, 0x50); u64(head, 0x20, 24);
  u64(head, 0x38, head.length); u64(head, 0x40, offset); u64(head, 0x48, head.length + offset);
  u32(head, 0x54, 0xffffffff); u32(head, 0x58, 0xffffffff); u32(head, 0x60, 0xffffffff);
  const data = Buffer.concat([head, ...entries, ...files.map(([, b]) => b)]);
  // A valid one-block IVFC data level rooted directly in the FS master hash.
  const size = 2 ** Math.ceil(Math.log2(data.length));
  const section = Buffer.alloc(align(size)); data.copy(section);
  const fs = Buffer.alloc(512); fs[3] = 3; fs[4] = 3; fs.write("IVFC", 8);
  u32(fs, 0x10, 32); u32(fs, 0x14, 2); u64(fs, 0x20, data.length); u32(fs, 0x28, Math.log2(size));
  hash(section.subarray(0, size)).copy(fs, 0xc8);
  return { fs, section };
}
function nca(type, sections, titleId = title) {
  const head = Buffer.alloc(0xc00); head.write("NCA3", 0x200); head[0x205] = type;
  u64(head, 0x210, titleId); crypt("aes-128-ecb", areaKey, null, sectionKey).copy(head, 0x320);
  let at = head.length;
  const data = sections.map(({ fs, section }, i) => {
    u32(head, 0x240 + i * 16, at / 512); u32(head, 0x244 + i * 16, (at + section.length) / 512);
    u64(fs, 0x140, 0x12345678n + BigInt(i)); fs.copy(head, 0x400 + i * 512);
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(0x12345678n + BigInt(i)); iv.writeBigUInt64BE(BigInt(at / 16), 8);
    at += section.length; return crypt("aes-128-ctr", sectionKey, iv, section);
  });
  u64(head, 0x208, at);
  // NX uses a big-endian sector number as the XTS tweak input.
  for (let i = 0; i < 6; i++) {
    xtsHeaderSector(head.subarray(i * 512, (i + 1) * 512), i).copy(head, i * 512);
  }
  return Buffer.concat([head, ...data]);
}
export function containerSample(sample, { update = false, updateOnly = false, wrongPatchTitle = false, icon = gameIcon } = {}) {
  const programId = "11".repeat(16), controlId = "22".repeat(16), metaId = "33".repeat(16);
  const nacp = Buffer.alloc(0x4000); nacp.write("Authored encrypted sample"); nacp.write("Test publisher", 0x200); nacp.write("1.2.3", 0x3060);
  const program = nca(0, [pfsSection([["main", sample.modules[0].data], ["main.npdm", sample.npdm]]), romSection([["message.txt", Buffer.from("encrypted authored resource")], ["shader.bnsh", shaderContainer(sample.shaders[0].code)]])]);
  const control = nca(2, [romSection([["control.nacp", nacp], ...(icon ? [["icon_AmericanEnglish.dat", icon]] : [])])]);
  const cnmt = Buffer.alloc(0x20 + 0x10 + 2 * 0x38);
  u64(cnmt, 0, title); u32(cnmt, 8, 65536); cnmt[0xc] = 0x80; cnmt.writeUInt16LE(0x10, 0xe); cnmt.writeUInt16LE(2, 0x10);
  [[programId, program, 1], [controlId, control, 3]].forEach(([id, bytes, type], i) => {
    const at = 0x30 + i * 0x38; hash(bytes).copy(cnmt, at); Buffer.from(id, "hex").copy(cnmt, at + 32);
    cnmt.writeUIntLE(bytes.length, at + 48, 6); cnmt[at + 54] = type;
  });
  const meta = nca(1, [pfsSection([["Application.cnmt", cnmt]])]);
  const members = [[programId + ".nca", program], [controlId + ".nca", control], [metaId + ".cnmt.nca", meta]];
  if (update || updateOnly || wrongPatchTitle) {
    const updateId = "44".repeat(16), patchId = "55".repeat(16);
    const patchTitle = title | (wrongPatchTitle ? 0x1800n : 0x800n);
    const main = sample.modules[0].data.slice();
    // Distinct build ID proves the selected executable came from the update.
    main.fill(2, 0x40, 0x50);
    const updatedProgram = nca(0, [pfsSection([["main", main], ["main.npdm", sample.npdm]])]);
    const patch = Buffer.alloc(0x20 + 0x18 + 2 * 0x38);
    u64(patch, 0, patchTitle); u32(patch, 8, 131072); patch[0xc] = 0x81;
    patch.writeUInt16LE(0x18, 0xe); patch.writeUInt16LE(2, 0x10); u64(patch, 0x20, title);
    [[updateId, updatedProgram, 1], [controlId, control, 3]].forEach(([id, bytes, type], i) => {
      const at = 0x38 + i * 0x38; hash(bytes).copy(patch, at); Buffer.from(id, "hex").copy(patch, at + 32);
      patch.writeUIntLE(bytes.length, at + 48, 6); patch[at + 54] = type;
    });
    const patchMeta = nca(1, [pfsSection([["Patch.cnmt", patch]])], patchTitle);
    if (updateOnly) members.splice(0, members.length, [controlId + ".nca", control]);
    members.push([updateId + ".nca", updatedProgram], [patchId + ".cnmt.nca", patchMeta]);
  }
  const card = Buffer.alloc(0x200); card.write("HEAD", 0x100); u64(card, 0x130, card.length);
  return { keys: new Uint8Array(keys), nsp: new Uint8Array(partition(members)), xci: new Uint8Array(Buffer.concat([card, partition([["secure", partition(members, true)]], true)])) };
}
export async function exerciseContainers(run, sample) {
  const fixture = containerSample(sample), root = "Payload/Sample.app/";
  const base = { template: sample.template, keys: fixture.keys };
  for (const kind of ["nsp", "xci"]) {
    const input = { ...base, [kind]: fixture[kind] }, saved = structuredClone(input);
    const result = await run(input); assert.deepEqual(input, saved);
    const files = unzipSync(result.ipa), game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
    assert.equal(game.name, "Authored encrypted sample");
    assert.equal(game.version_number, 65536); assert.equal(game.version, "1.2.3");
    assert.equal(new TextDecoder().decode(files[root + "nxkit/romfs/message.txt"]), "encrypted authored resource");
    assert.equal(result.signed, false); assert.equal(result.deviceValidated, false);
    assert.equal(result.shaderCount, 1);
    assert.ok(Object.keys(files).some((name) => /nxkit\/shaders\/[0-9a-f]{16}_b\.metallib$/.test(name)));
    assert.ok(files[root + "Frameworks/nxgame.dylib"]);
    assert.equal(game.title_id, "0100000000000000");
    assert.deepEqual(files[root + "nxkit/main.npdm"], sample.npdm);
    assert.deepEqual(files[root + "nxkit/icon.jpg"], gameIcon);
    await assert.rejects(run({ ...input, keys: enc.encode(`header_key = ${"99".repeat(32)}\n`) }), /during extract/);
    await assert.rejects(run({ ...input, keys: enc.encode(`header_key = ${headerKey.toString("hex")}\nkey_area_key_application_00 = ${"99".repeat(16)}\n`) }), /during extract/);
    await assert.rejects(run({ ...input, [kind]: fixture[kind].slice(0, 700) }), /during extract/);
    const fromBlob = await run({ ...input, [kind]: new Blob([fixture[kind]]) });
    assert.deepEqual(fromBlob.ipa, result.ipa);
    await assert.rejects(run({ ...input, profile: { titleId: "0100000000000001" } }), /during extract.*Title mismatch/);
    await assert.rejects(run({ ...input, profile: { version: 65537 } }), /during extract.*Version mismatch/);
    await assert.rejects(run(input, { abortAt: "extract" }), { name: "AbortError" });
  }
  const merged = containerSample(sample, { update: true });
  const updateOnly = containerSample(sample, { updateOnly: true });
  const wrongPatch = containerSample(sample, { wrongPatchTitle: true });
  for (const kind of ["nsp", "xci"]) {
    const result = await run({ ...base, [kind]: merged[kind] });
    const files = unzipSync(result.ipa);
    const game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
    assert.equal(result.shaderCount, 1);
    assert.equal(game.version_number, 131072);
    assert.equal(game.title_id, "0100000000000000");
    assert.equal(game.name, "Authored encrypted sample");
    assert.equal(game.modules[0].build_id.toLowerCase(), "02".repeat(16));
    assert.equal(new TextDecoder().decode(files[root + "nxkit/romfs/message.txt"]), "encrypted authored resource");
    await assert.rejects(run({ ...base, [kind]: updateOnly[kind] }), /during extract.*update-only/);
    await assert.rejects(run({ ...base, [kind]: wrongPatch[kind] }), /during extract.*update does not match/);
  }
  console.log("Passed: authored merged NSP/XCI selects code-only update ExeFS/version and preserves base RomFS; update-only and wrong-title updates rejected. BKTR not tested.");
  const badRoot = fixture.xci.slice();
  new DataView(badRoot.buffer).setBigUint64(0x130, BigInt(badRoot.length + 1), true);
  await assert.rejects(run({ ...base, xci: badRoot }), /during extract/);
  const noSecure = fixture.xci.slice();
  noSecure.set(enc.encode("absent"), 0x200 + 16 + 64);
  await assert.rejects(run({ ...base, xci: noSecure }), /during extract/);
  const damaged = fixture.nsp.slice(); damaged[damaged.length - 512] ^= 1;
  await assert.rejects(run({ ...base, nsp: damaged }), /during extract/);
  await assert.rejects(run({ ...base, nsp: fixture.nsp, xci: fixture.xci }));
  console.log("Passed: authored encrypted NSP and XCI → IPA, inferred Control metadata, RomFS bytes, wrong header/area keys, truncation, hash corruption, Blob input, profile mismatch and extract cancellation. No real-game/device claim.");
}
