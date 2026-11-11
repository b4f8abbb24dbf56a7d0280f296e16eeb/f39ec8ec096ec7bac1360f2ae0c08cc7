// Opt-in local Apple-silicon regression. Not a CI job or physical iOS test.
// Run after rebuilding dist: bun tests/native-tail.mjs
// It loads only an authored fixture, never a user's game, and calls no guest code.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createIpa } from "../dist/nx2ipa.js";
import { sample } from "./fixture.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This opt-in native dyld test requires a local Apple-silicon Mac and Xcode. It is not an iPhone test.");
const dir = await mkdtemp(join(tmpdir(), "nx2ipa-native-tail-"));
async function run(args) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code) throw new Error(`${args[0]} exited ${code}: ${err || out}`);
  return out.trim();
}
try {
  const request = sample();
  request.shaders = [];
  const result = await createIpa(request);
  assert.equal(result.signed, false);
  const files = unzipSync(result.ipa);
  const root = "Payload/Sample.app/";
  const game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
  const dylib = files[root + game.dylib].slice();
  const view = new DataView(dylib.buffer, dylib.byteOffset, dylib.byteLength);
  const u32 = at => view.getUint32(at, true);
  const u64 = at => view.getBigUint64(at, true);
  const string = (at, len) => new TextDecoder().decode(dylib.subarray(at, at + len)).split("\0")[0];
  assert.equal(u32(0), 0xfeedfacf);
  assert.equal(u32(4), 0x100000c);
  assert.equal(u32(12), 6);
  let at = 32, heap, linkedit, platformCount = 0;
  for (let i = 0; i < u32(16); i++) {
    const cmd = u32(at), size = u32(at + 4);
    assert.ok(size >= 8 && size % 8 === 0 && at + size <= 32 + u32(20));
    // Fail closed: the fixture must not acquire code run automatically at dlopen.
    assert.ok(![0x11, 0x1a, 0x80000034].includes(cmd), "Unexpected routines or chained fixups");
    if (cmd === 0x19) {
      assert.equal(size, 72 + 80 * u32(at + 64));
      for (let n = 0; n < u32(at + 64); n++)
        assert.ok(![0x9, 0xa, 0x15, 0x16].includes(u32(at + 72 + 80 * n + 64) & 0xff));
      const name = string(at + 8, 16);
      if (name === "__NX_HEAP") {
        assert.equal(heap, undefined);
        heap = { start: u64(at + 24), size: u64(at + 32) };
        assert.equal(u64(at + 48), 0n);
        assert.equal(u32(at + 56), 3);
        assert.equal(u32(at + 60), 3);
      }
      if (name === "__LINKEDIT") linkedit = u64(at + 24);
    }
    if (cmd === 0xc) assert.equal(string(at + u32(at + 8), size - u32(at + 8)), "/usr/lib/libSystem.B.dylib");
    if (cmd === 0x32) {
      assert.equal(u32(at + 8), 2);
      platformCount++;
      // This disposable copy is adapted solely to exercise macOS dyld. The
      // converter's untouched iOS output is not represented as Mac-compatible.
      view.setUint32(at + 8, 1, true);
      view.setUint32(at + 12, 13 << 16, true);
      view.setUint32(at + 16, 13 << 16, true);
    }
    at += size;
  }
  assert.equal(at, 32 + u32(20));
  assert.equal(platformCount, 1);
  assert.ok(heap && heap.size >= 3n * 1024n ** 3n, "Exercise the actual multi-GiB default reserve");
  assert.equal(heap.start + heap.size, linkedit);
  const library = join(dir, "nxgame-tail-test.dylib"), probe = join(dir, "probe");
  await writeFile(library, dylib);
  await run(["codesign", "--force", "--sign", "-", library]);
  await run(["codesign", "--verify", "--strict", library]);
  await run(["xcrun", "clang", "-arch", "arm64", "-Wall", "-Wextra", "-Werror", "-o", probe,
    new URL("./native-tail.c", import.meta.url).pathname]);
  for (let pass = 0; pass < 3; pass++) {
    const out = await run([probe, library]);
    assert.match(out, /PASS: anonymous RW dyld tail/);
    console.log(out);
  }
  console.log("Three fresh-process macOS dyld tests passed. iOS loading, Metal acceptance, installation and gameplay remain unverified.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
