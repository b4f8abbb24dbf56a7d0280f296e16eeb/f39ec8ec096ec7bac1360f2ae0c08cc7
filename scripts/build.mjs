import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";
const root = resolve(import.meta.dir, "..");
const file = (path) => resolve(root, path);
let host = null;
try {
  const manifest = JSON.parse(await readFile(file(".build/ios/host.json"), "utf8"));
  if (manifest.runtimeReady !== true || !/^[\w.-]+\.app$/.test(manifest.appName) ||
      !/^[\w.-]+$/.test(manifest.executable)) throw new Error("The built-in iOS host is not a functional runtime");
  const files = {};
  async function collect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await collect(resolve(directory, entry.name), path + "/");
      else if (entry.isFile()) files[path] = new Uint8Array(await readFile(resolve(directory, entry.name)));
      else throw new Error(`Unsupported host entry: ${path}`);
    }
  }
  await collect(file(`.build/ios/${manifest.appName}`));
  if (!files[manifest.executable]?.length || !files["Info.plist"]?.length) throw new Error("Incomplete iOS host");
  host = { appName: manifest.appName, executable: manifest.executable, zip: Buffer.from(zipSync(files)).toString("base64") };
} catch (error) {
  if (error.code !== "ENOENT" || !Bun.argv.includes("--allow-missing-host")) throw error;
  console.warn("Development build: no built-in iOS runtime; game conversion needs an explicit host template.");
}
const assets = {
  bridgeWasm: (await readFile(file("bridge/target/wasm32-unknown-unknown/release/nx2ipa_bridge.wasm"))).toString("base64"),
  zsignWasm: (await readFile(file("node_modules/zsign-wasm/binary/zsign-wasm.wasm"))).toString("base64"),
};
let signer = await readFile(file("node_modules/zsign-wasm/binary/zsign-wasm.js"), "utf8");
const marker = signer.indexOf("// Export using a UMD style export");
if (marker < 0) throw new Error("Unexpected zsign package format");
signer = "const require = undefined;\n" + signer.slice(0, marker) + "\nexport default createZsignModule;";
let worker;
const plugin = {
  name: "embedded-runtime",
  setup(build) {
    build.onResolve({ filter: /^nx2ipa:/ }, ({ path }) => ({ path, namespace: "nx2ipa" }));
    build.onLoad({ filter: /.*/, namespace: "nx2ipa" }, ({ path }) => ({
      loader: "js",
      contents: path === "nx2ipa:signer" ? signer
        : path === "nx2ipa:worker" ? `export default ${JSON.stringify(worker)};`
        : path === "nx2ipa:host" ? `export default ${JSON.stringify(host)};`
        : path === "nx2ipa:capabilities" ? `export default {embeddedHost:${!!host}};`
        : `export const bridgeWasm=${JSON.stringify(assets.bridgeWasm)}; export const zsignWasm=${JSON.stringify(assets.zsignWasm)}; export default {bridgeWasm,zsignWasm};`,
    }));
  },
};
async function bundle(path, format = "esm", define = {}) {
  const result = await Bun.build({
    entrypoints: [file(path)], target: "browser", format, minify: true,
    write: false, plugins: [plugin], define,
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  return result.outputs[0].text();
}
// Compile the npm signer for a Web Worker in both hosts. It receives wasmBinary,
// so no script location, Node filesystem, or runtime network fetch is needed.
worker = await bundle("src/worker.js", "iife", {
  "globalThis.process": "undefined", "globalThis.window": "undefined",
  "globalThis.WorkerGlobalScope": "true", "self.location.href": '"blob:nx2ipa"',
  "__filename": "undefined",
});
await mkdir(file("dist"), { recursive: true });
await writeFile(file("dist/nx2ipa.js"), "/*! Includes GPL-3.0-only nxkit. See release source and notices. */\n" + await bundle("src/index.js"));
const script = (await bundle("src/app.js", "iife")).replace(/<\/script/gi, "<\\/script");
let html = await readFile(file("index.html"), "utf8");
for (const path of ["node_modules/basecoat-css/dist/basecoat.cdn.min.css", "src/app.css"]) {
  const link = `<link rel="stylesheet" href="./${path}" />`;
  if (!html.includes(link)) throw new Error(`Missing stylesheet: ${path}`);
  const css = (await readFile(file(path), "utf8")).replace(/<\/style/gi, "<\\/style");
  html = html.replace(link, () => `<style>${css}</style>`);
}
if (!/<script type="module" src=["']\.\/src\/app\.js["']><\/script>/.test(html)) throw new Error("Missing HTML entrypoint");
await writeFile(file("dist/nx2ipa.html"), html.replace(/<script type="module" src=["']\.\/src\/app\.js["']><\/script>/, () => `<script>${script}</script>`));
console.log("Built self-contained dist/nx2ipa.js and dist/nx2ipa.html");
