import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { zipSync } from "fflate";
import { command } from "./source.mjs";
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
await mkdir(join(dist, "licenses"), { recursive: true });
for (const [source, target] of [
  [".build/nxkit/LICENSE", "licenses/nxkit-GPL-3.0.txt"],
  [".build/nxkit/THIRD_PARTY.md", "licenses/nxkit-THIRD_PARTY.md"],
  ["node_modules/zsign-wasm/LICENSE", "licenses/zsign-MIT.txt"],
  ["node_modules/fflate/LICENSE", "licenses/fflate-MIT.txt"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["README.md", "README.md"],
]) await cp(join(root, source), join(dist, target));
// All new bridge/library source and the exact unmodified GPL upstream, once.
await command(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
  "--exclude=bridge/target", "-czf", join(dist, "source.tar.gz"),
  "src", "bridge", "scripts", "tests", ".github", "package.json", "bun.lock",
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
await writeFile(join(dist, "nx2ipa.zip"), zipSync(files));
console.log("Release ZIP includes the JS library, offline HTML, notices and corresponding source.");
