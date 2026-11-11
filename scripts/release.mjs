import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { zipSync } from "fflate";
import { command } from "./source.mjs";
import { experimentalHost, sha256 } from "./host.mjs";
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const preview = Bun.argv.includes("--preview");
const experimental = Bun.argv.includes("--experimental-host");
if (preview && experimental) throw new Error("Choose one release mode");
const native = experimental ? await experimentalHost() : null;
if (!preview && !experimental) {
  const host = JSON.parse(await readFile(join(root, ".build/ios/host.json"), "utf8"));
  if (host.runtimeReady !== true) throw new Error("Cannot release without a functional built-in iOS runtime");
}
const built = JSON.parse(await readFile(join(dist, "build.json")));
if (built.mode !== (experimental ? "experimental" : preview ? "preview" : "release") ||
    built.jsSha256 !== sha256(await readFile(join(dist, "nx2ipa.js"))) ||
    built.htmlSha256 !== sha256(await readFile(join(dist, "nx2ipa.html"))) ||
    (native && (built.nativeHostSha256 !== native.manifest.binarySha256 ||
                built.nativeSourceSha256 !== native.manifest.source.sha256 ||
                native.test.embeddedHostTested !== true || native.test.librarySha256 !== built.jsSha256)))
  throw new Error("Build output does not match this release mode and native artifact");
await mkdir(join(dist, "licenses"), { recursive: true });
for (const name of ["nx2ipa.zip", "nx2ipa-preview.zip", "nx2ipa-experimental.zip", "PREVIEW.txt", "EXPERIMENTAL.txt", "native-source.tar.gz", "native-host.json", "native-integration.json"])
  await rm(join(dist, name), { force: true });
if (preview) await writeFile(join(dist, "PREVIEW.txt"), "Development preview. The built-in iOS guest runtime is not complete; the game + keys conversion UI is disabled. This is not a working game runtime or device-validated IPA converter.\n");
if (experimental) {
  await writeFile(join(dist, "EXPERIMENTAL.txt"), "Experimental iOS 26 converter with a real SDK-built native host. Game and keys stay local. Default output is unsigned and needs valid Apple signing/provisioning before installation. SDK linking, synthetic signing and bundle-contract checks passed; actual device installation, dyld placement, rendering, audio and gameplay are unverified. The generic virtual-memory profile needs roughly a 3.8 GiB Metal buffer; devices with a smaller maxBufferLength will reject startup. Unsupported games and shader formats may fail. No device or Apple signing trust is claimed. Keep both source archives and notices with redistribution.\n");
  for (const [from, to] of [["native-source.tar.gz", "native-source.tar.gz"], ["host-test.json", "native-host.json"], ["integration-test.json", "native-integration.json"]])
    await cp(join(native.directory, from), join(dist, to));
}
for (const [source, target] of [
  [".build/nxkit/LICENSE", "licenses/nxkit-GPL-3.0.txt"],
  [".build/nxkit/THIRD_PARTY.md", "licenses/nxkit-THIRD_PARTY.md"],
  ["node_modules/zsign-wasm/LICENSE", "licenses/zsign-MIT.txt"],
  ["node_modules/fflate/LICENSE", "licenses/fflate-MIT.txt"],
  ["node_modules/jpeg-js/LICENSE", "licenses/jpeg-js-BSD-3-Clause.txt"],
  ["licenses/Apache-2.0.txt", "licenses/jpeg-js-Apache-2.0.txt"],
  ["node_modules/jpeg-js/lib/decoder.js", "licenses/jpeg-js-decoder.js"],
  ["node_modules/basecoat-css/LICENSE.md", "licenses/basecoat-MIT.txt"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["README.md", "README.md"],
]) await cp(join(root, source), join(dist, target));
// All new bridge/library source and the exact unmodified GPL upstream, once.
await command([process.platform === "darwin" ? "gtar" : "tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
  "--exclude=bridge/target", "--exclude=ios/target", "-czf", join(dist, "source.tar.gz"),
  "src", "bridge", "ios", "scripts", "tests", "licenses", ".github", "package.json", "bun.lock",
  "rust-toolchain.toml", "nxkit.json", "index.html", "README.md", "THIRD_PARTY_NOTICES.md", ".build/nxkit"]);
const files = {};
async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(directory, entry.name), name + "/");
    else if (name !== "nx2ipa.zip") files[name] = new Uint8Array(await readFile(join(directory, entry.name)));
  }
}
await collect(dist);
await writeFile(join(dist, experimental ? "nx2ipa-experimental.zip" : preview ? "nx2ipa-preview.zip" : "nx2ipa.zip"), zipSync(files));
console.log(`${experimental ? "Experimental" : preview ? "Development preview" : "Release"} ZIP includes the JS library, offline HTML, notices and corresponding source.`);
