import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { zipSync } from "fflate";
import { command } from "./source.mjs";
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const preview = Bun.argv.includes("--preview");
if (!preview) {
  const host = JSON.parse(await readFile(join(root, ".build/ios/host.json"), "utf8"));
  if (host.runtimeReady !== true) throw new Error("Cannot release without a functional built-in iOS runtime");
}
await mkdir(join(dist, "licenses"), { recursive: true });
for (const name of ["nx2ipa.zip", "nx2ipa-preview.zip", "PREVIEW.txt"])
  await rm(join(dist, name), { force: true });
if (preview) await writeFile(join(dist, "PREVIEW.txt"), "Development preview. The built-in iOS guest runtime is not complete; the game + keys conversion UI is disabled. This is not a working game runtime or device-validated IPA converter.\n");
for (const [source, target] of [
  [".build/nxkit/LICENSE", "licenses/nxkit-GPL-3.0.txt"],
  [".build/nxkit/THIRD_PARTY.md", "licenses/nxkit-THIRD_PARTY.md"],
  ["node_modules/zsign-wasm/LICENSE", "licenses/zsign-MIT.txt"],
  ["node_modules/fflate/LICENSE", "licenses/fflate-MIT.txt"],
  ["node_modules/basecoat-css/LICENSE.md", "licenses/basecoat-MIT.txt"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["README.md", "README.md"],
]) await cp(join(root, source), join(dist, target));
// All new bridge/library source and the exact unmodified GPL upstream, once.
await command(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
  "--exclude=bridge/target", "--exclude=ios/target", "-czf", join(dist, "source.tar.gz"),
  "src", "bridge", "ios", "scripts", "tests", ".github", "package.json", "bun.lock",
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
await writeFile(join(dist, preview ? "nx2ipa-preview.zip" : "nx2ipa.zip"), zipSync(files));
console.log(`${preview ? "Development preview" : "Release"} ZIP includes the JS library, offline HTML, notices and corresponding source.`);
