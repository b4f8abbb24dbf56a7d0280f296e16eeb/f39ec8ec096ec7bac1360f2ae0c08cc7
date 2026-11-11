// Portable converter -> real signer -> native host contract, using authored
// fixtures and a disposable test identity. No Apple trust or device claim.
// Run after rebuilding WASM/dist and preparing the iOS adapter source tree.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { createIpa } from "../dist/nx2ipa.js";
import { sample, signingFixture } from "./fixture.mjs";
const repository = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "nx2ipa-tail-contract-"));
const signing = await signingFixture("org.example.sample");
try {
  const variants = [
    { name: "default-16m-stack", memory: undefined },
    { name: "hex-override", memory: {
      reserve: "0x80000000", alias: "0x8000000", stack: "0x8000000",
      app_pool: "0x60000000", mem_used: "0x4000000",
    } },
  ];
  for (const variant of variants) {
    const request = sample();
    request.shaders = [];
    new DataView(request.npdm.buffer).setUint32(0x1c, 16 << 20, true);
    if (variant.memory) request.profile.memory = variant.memory;
    const result = await createIpa({ ...request, signing });
    assert.equal(result.signed, true);
    assert.equal(result.deviceValidated, false);
    const files = unzipSync(result.ipa), root = "Payload/Sample.app/";
    const game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
    assert.equal(game.main_thread.stack_size, 16 << 20);
    for (const file of ["Sample", game.dylib]) await signing.verify(files[root + file]);
    const directory = join(temporary, variant.name);
    for (const [path, data] of Object.entries(files)) {
      assert.ok(path.startsWith(root) && !/[\\\0]/.test(path) && !path.split("/").some(p => p === ".." || p === "."));
      const destination = join(directory, path);
      if (path.endsWith("/")) await mkdir(destination, { recursive: true });
      else { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, data); }
    }
    const child = Bun.spawn(["cargo", "run", "--offline", "--locked", "--manifest-path", "ios/Cargo.toml",
      "-p", "nx2ipa-ios-host", "--example", "validate_bundle", "--", join(directory, "Payload/Sample.app")],
      { cwd: repository, stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert.equal(code, 0, `${variant.name}: ${err || out}`);
    assert.match(out, /Native bundle contract accepted/);
    console.log(`${variant.name}: host and guest CMS signatures verified; ${out.trim()}`);
  }
  console.log("Signed authored bundles passed converter/host tail contracts. Apple signing trust, iOS loading, Metal and gameplay remain unverified.");
} finally {
  await signing.dispose();
  await rm(temporary, { recursive: true, force: true });
}
