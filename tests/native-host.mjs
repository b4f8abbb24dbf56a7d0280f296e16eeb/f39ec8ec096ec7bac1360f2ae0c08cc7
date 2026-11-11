// Real SDK-linked host + authored NSP, never a game or trusted signing identity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { createIpa, capabilities } from "../dist/nx2ipa.js";
import { sample, signingFixture } from "./fixture.mjs";
import { containerSample } from "./containers.mjs";
import { command } from "../scripts/source.mjs";

const artifact = resolve(process.argv[2] ?? ".build/ios/test");
const receipt = JSON.parse(await readFile(join(artifact, "host-test.json")));
assert.equal(receipt.kind, "unsigned-native-test-host");
assert.equal(receipt.sdkLinked, true);
assert.equal(receipt.unsigned, true);
assert.equal(receipt.runtimeReady, false);
assert.equal(receipt.deviceValidated, false);
const sha = data => createHash("sha256").update(data).digest("hex");
const template = { name: receipt.appName, files: [] };
async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(directory, entry.name), path + "/");
    else {
      assert.ok(entry.isFile(), "Host must contain ordinary files only");
      template.files.push({ path, data: new Uint8Array(await readFile(join(directory, entry.name))), executable: path === receipt.executable });
    }
  }
}
await collect(join(artifact, receipt.appName));
assert.equal(sha(template.files.find(f => f.path === receipt.executable).data), receipt.binarySha256);
assert.equal(sha(template.files.find(f => f.path === "Info.plist").data), receipt.infoPlistSha256);
const signing = await signingFixture("app.nx2ipa.game");
const temporary = await mkdtemp(join(tmpdir(), "nx2ipa-native-contract-"));
try {
  const input = containerSample(sample());
  const result = await createIpa({ ...(capabilities.embeddedHost ? {} : { template }), nsp: input.nsp, keys: input.keys, signing });
  assert.equal(result.signed, true);
  assert.equal(result.deviceValidated, false);
  assert.equal(result.shaderCount, 1);
  if (capabilities.experimental) {
    assert.ok(result.warnings.some(message => /experimental/i.test(message)));
    const unsigned = await createIpa({ nsp: input.nsp, keys: input.keys });
    assert.equal(unsigned.signed, false);
    assert.ok(unsigned.warnings.some(message => /valid.*signing/i.test(message)));
  }
  const files = unzipSync(result.ipa), root = "Payload/" + receipt.appName + "/";
  const game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
  for (const path of [receipt.executable, game.dylib]) {
    assert.ok(files[root + path], "Missing native executable: " + path);
    await signing.verify(files[root + path]);
  }
  for (const [path, data] of Object.entries(files)) {
    assert.ok(path.startsWith(root) && !/[\\\0]/.test(path) && !path.split("/").some(p => p === ".." || p === "."), "Unsafe generated path");
    const destination = join(temporary, path);
    if (path.endsWith("/")) await mkdir(destination, { recursive: true });
    else { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, data); }
  }
  console.log(await command(["cargo", "run", "--locked", "--manifest-path", "ios/Cargo.toml", "-p", "nx2ipa-ios-host", "--example", "validate_bundle", "--", join(temporary, "Payload", receipt.appName)]));
  await writeFile(join(artifact, "integration-test.json"), JSON.stringify({
    schema: 1, nativeHostSha256: receipt.binarySha256, librarySha256: sha(await readFile("dist/nx2ipa.js")),
    authoredEncryptedNsp: true, automaticShaders: true, bundleContractAccepted: true,
    embeddedHostTested: capabilities.embeddedHost,
    syntheticHostAndGuestCmsVerified: true, appleSigningTrustVerified: false,
    deviceValidated: false, gameplayValidated: false, runtimeReady: false,
  }, null, 2) + "\n");
  console.log("Actual host packaging, synthetic signing and native bundle contract passed. No device execution or Apple signing trust established.");
} finally {
  await signing.dispose();
  await rm(temporary, { recursive: true, force: true });
}
