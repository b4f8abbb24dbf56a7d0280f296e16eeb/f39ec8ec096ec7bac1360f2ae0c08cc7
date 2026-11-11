import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync, unzlibSync, unzipSync, zipSync } from "fflate";
import jpeg from "jpeg-js";
import { appIcons, installMetadata, nameFromNacp } from "../src/metadata.js";
import { sample, signingFixture } from "./fixture.mjs";
import { containerSample, gameIcon } from "./containers.mjs";

const text = new TextDecoder(), utf8 = new TextEncoder();
const title = "Authored <game> & 🎮";
const nacp = new Uint8Array(0x4000);
nacp.set(utf8.encode(title), 2 * 0x300);
nacp.set(utf8.encode("Invalid \ufffe title"));
assert.equal(nameFromNacp(nacp), title);
assert.equal(nameFromNacp(new Uint8Array(0x4000)), undefined);
const names = new Uint8Array(0x6000);
names.set(utf8.encode(title), 18 * 0x300);
const compressed = deflateSync(names), packed = new Uint8Array(0x4000);
new DataView(packed.buffer).setUint16(0, compressed.length, true);
packed.set(compressed, 2);
assert.equal(nameFromNacp(packed), title);

// Verify the PNG container and raw pixels independently of the encoder.
function verifyIcon(bytes, size) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let rows, at = 8;
  const types = [];
  while (at < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
    const type = text.decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(at + 4, at + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset + at + 8 + length).getUint32(0), (crc ^ 0xffffffff) >>> 0);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset);
      assert.equal(header.getUint32(0), size); assert.equal(header.getUint32(4), size);
      assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]); // Opaque RGB, no alpha.
    }
    if (type === "IDAT") rows = unzlibSync(data);
    types.push(type); at += 12 + length;
  }
  assert.equal(at, bytes.length);
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  assert.equal(rows.length, size * (size * 3 + 1));
  // The authored JPEG is red on the left and blue on the right.
  const left = rows.subarray(1, 4), right = rows.subarray(1 + (size - 1) * 3, 4 + (size - 1) * 3);
  assert.ok(left[0] > 240 && left[2] < 15);
  assert.ok(right[2] > 240 && right[0] < 15);
}
const sizes = [120, 180, 76, 152, 167];
const icons = appIcons(gameIcon);
assert.deepEqual(icons.map((icon) => icon.path), [
  "Nx2ipaGameIcon60x60@2x.png", "Nx2ipaGameIcon60x60@3x.png",
  "Nx2ipaGameIcon76x76.png", "Nx2ipaGameIcon76x76@2x.png", "Nx2ipaGameIcon83.5x83.5@2x.png",
]);
icons.forEach((icon, i) => verifyIcon(icon.data, sizes[i]));
assert.throws(() => appIcons(new Uint8Array([1, 2, 3])));
assert.throws(() => appIcons(new Uint8Array(4 * 1024 ** 2 + 1)), /size/);
assert.throws(() => appIcons(jpeg.encode({ width: 2, height: 1, data: new Uint8Array(8) }).data), /square/);
assert.throws(() => appIcons(jpeg.encode({ width: 1024, height: 1024, data: new Uint8Array(1024 ** 2 * 4) }).data), /maxResolution/);
const hostPlist = await readFile(new URL("../ios/Info.plist", import.meta.url), "utf8");
const plist = installMetadata(hostPlist, title, true);
assert.match(plist, /<string>Authored &lt;game&gt; &amp; 🎮<\/string>/);
assert.equal(plist.match(/<key>CFBundleDisplayName<\/key>/g).length, 1);
assert.match(plist, /<key>CFBundleIcons~ipad<\/key>/);
for (const [key, names] of [
  ["CFBundleIcons", ["Nx2ipaGameIcon60x60"]],
  ["CFBundleIcons~ipad", ["Nx2ipaGameIcon76x76", "Nx2ipaGameIcon83.5x83.5"]],
]) {
  const prefix = `<key>${key}</key><dict><key>CFBundlePrimaryIcon</key><dict><key>CFBundleIconFiles</key><array>`;
  const list = plist.split(prefix)[1]?.split("</array>")[0];
  assert.equal(list, names.map((name) => `<string>${name}</string>`).join(""));
  for (const name of names) assert.ok(icons.some((icon) => icon.path === `${name}.png` || icon.path.startsWith(`${name}@`)));
}
assert.doesNotMatch(installMetadata(hostPlist, title, false), /CFBundleIcons/);
for (const name of ["Bad\x00name", "Bad\x01name", "Bad\ufffename", "Bad\uffffname"])
  assert.throws(() => installMetadata(hostPlist, name, true), /invalid XML characters/);

// Exercise the actual built-in-host worker branch with an explicitly authored
// structural host. This is a test-only bundle, never a release/native host.
const fixture = sample(), raw = containerSample(fixture);
const hostFiles = Object.fromEntries(fixture.template.files.map(({ path, data }) => [path === "Sample" ? "nx2ipa" : path, data]));
hostFiles["Info.plist"] = utf8.encode(hostPlist);
const host = { appName: "Sample.app", executable: "nx2ipa", zip: Buffer.from(zipSync(hostFiles)).toString("base64") };
const bridge = await readFile(new URL("../bridge/target/wasm32-unknown-unknown/release/nx2ipa_bridge.wasm", import.meta.url));
const signerWasm = await readFile(new URL("../node_modules/zsign-wasm/binary/zsign-wasm.wasm", import.meta.url));
let signer = await readFile(new URL("../node_modules/zsign-wasm/binary/zsign-wasm.js", import.meta.url), "utf8");
const marker = signer.indexOf("// Export using a UMD style export");
assert.ok(marker > 0);
signer = "const require = undefined;\n" + signer.slice(0, marker) + "\nexport default createZsignModule;";
const bundle = await Bun.build({
  entrypoints: [new URL("../src/worker.js", import.meta.url).pathname], target: "browser", format: "iife",
  define: { "globalThis.process": "undefined", "globalThis.window": "undefined",
    "globalThis.WorkerGlobalScope": "true", "self.location.href": '"blob:nx2ipa"', "__filename": "undefined" },
  plugins: [{ name: "metadata-test-host", setup(build) {
    build.onResolve({ filter: /^nx2ipa:/ }, ({ path }) => ({ path, namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ loader: "js", contents:
      path === "nx2ipa:host" ? `export default ${JSON.stringify(host)}`
        : path === "nx2ipa:signer" ? signer
        : `export const bridgeWasm=${JSON.stringify(bridge.toString("base64"))}; export const zsignWasm=${JSON.stringify(signerWasm.toString("base64"))};`,
    }));
  } }],
});
assert.equal(bundle.success, true, String(bundle.logs));
const source = await bundle.outputs[0].text();
const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
async function run(input) {
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.error) reject(new Error(data.error));
        else if (data.result) resolve(data.result);
      };
      worker.onerror = reject;
      worker.postMessage({ resources: [], ...input });
    });
  } finally { worker.terminate(); }
}
async function exerciseWorker(run) {
  for (const kind of ["nsp", "xci"]) {
    const result = await run({ [kind]: raw[kind], keys: raw.keys });
    const files = unzipSync(result.ipa), root = "Payload/Sample.app/";
    assert.equal(result.name, "Authored encrypted sample");
    assert.match(text.decode(files[root + "Info.plist"]), /<key>CFBundleDisplayName<\/key><string>Authored encrypted sample<\/string>/);
    assert.match(text.decode(files[root + "Info.plist"]), /CFBundleIcons~ipad/);
    icons.forEach((icon, i) => verifyIcon(files[root + icon.path], sizes[i]));
    assert.deepEqual(files[root + "nxkit/icon.jpg"], gameIcon);
    assert.ok(!result.warnings.some((warning) => /icon/.test(warning)));
  }
  for (const icon of [null, new Uint8Array([1, 2, 3])]) {
    const input = containerSample(fixture, { icon });
    const result = await run({ nsp: input.nsp, keys: input.keys, profile: { name: title } });
    const files = unzipSync(result.ipa), plist = text.decode(files["Payload/Sample.app/Info.plist"]);
    assert.match(plist, /Authored &lt;game&gt; &amp; 🎮/);
    assert.doesNotMatch(plist, /CFBundleIcons/);
    assert.ok(!Object.keys(files).some((path) => /Nx2ipaGameIcon/.test(path)));
    assert.ok(result.warnings.some((warning) => /icon/.test(warning)));
  }
}
try {
  await exerciseWorker(run);
  await assert.rejects(run({ nsp: raw.nsp, keys: raw.keys, profile: { name: "Invalid\ufffe title" } }), /invalid XML characters/);
  const signing = await signingFixture("app.nx2ipa.game");
  try {
    const result = await run({ nsp: raw.nsp, keys: raw.keys, signing: {
      identity: signing.identity, profile: signing.profile, password: signing.password,
    } });
    assert.equal(result.signed, true);
    const files = unzipSync(result.ipa), root = "Payload/Sample.app/";
    await signing.verify(files[root + "nx2ipa"]);
    await signing.verify(files[root + "Frameworks/nxgame.dylib"]);
    const resources = text.decode(files[root + "_CodeSignature/CodeResources"]);
    for (const icon of icons) {
      assert.deepEqual(files[root + icon.path], icon.data);
      assert.ok(resources.includes(`<key>${icon.path}</key>`));
      assert.ok(resources.includes(createHash("sha256").update(icon.data).digest("base64")));
    }
    assert.match(text.decode(files[root + "Info.plist"]), /CFBundleDisplayName/);
  } finally { await signing.dispose(); }
} finally { URL.revokeObjectURL(url); }
if (process.env.CHROMIUM_PATH) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await exerciseWorker(async (input) => {
      const result = await page.evaluate(async ({ source, input }) => {
        for (const key of ["nsp", "xci", "keys"]) if (input[key]) input[key] = new Uint8Array(input[key]);
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url);
        try {
          const result = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : data.result && resolve(data.result);
            worker.onerror = reject; worker.postMessage({ resources: [], ...input });
          });
          return { ...result, ipa: Array.from(result.ipa) };
        } finally { worker.terminate(); URL.revokeObjectURL(url); }
      }, { source, input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value instanceof Uint8Array ? [...value] : value])) });
      return { ...result, ipa: new Uint8Array(result.ipa) };
    });
    console.log("Chromium: encrypted NSP/XCI → built-in-host display name and PNG icons, missing/malformed icon fallbacks.");
  } finally { await browser.close(); }
}
console.log("Passed: Control titles, bounded JPEG decoding, five opaque RGB PNGs with CRC/pixels, encrypted NSP/XCI → built-in-host metadata, missing/malformed icon fallbacks, synthetic signing with icon resource hashes. Authored structural host only, no device claim.");
