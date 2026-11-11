import { zipSync } from "fflate";
import { bridgeWasm, zsignWasm } from "nx2ipa:assets";
import createSigner from "nx2ipa:signer";

const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
const encode = (bytes) => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 32768)
    text += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(text);
};
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });
const path = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe file path");
  return value;
};
function add(files, name, data, executable = false) {
  path(name);
  const key = name.normalize("NFC").toLowerCase();
  const index = (files.index ??= { files: new Set(), directories: new Set() });
  if (index.files.has(key) || index.directories.has(key)) throw new Error("Conflicting file paths");
  const parts = key.split("/");
  for (let end = 1; end < parts.length; end++) {
    const parent = parts.slice(0, end).join("/");
    if (index.files.has(parent)) throw new Error("Conflicting file paths");
    index.directories.add(parent);
  }
  index.files.add(key);
  files.set(name, { data, executable });
}
function directory(files, directories, name) {
  path(name);
  const key = name.normalize("NFC").toLowerCase();
  const index = (files.index ??= { files: new Set(), directories: new Set() });
  const parts = key.split("/");
  for (let end = 1; end <= parts.length; end++) {
    const parent = parts.slice(0, end).join("/");
    if (index.files.has(parent)) throw new Error("Conflicting file paths");
    index.directories.add(parent);
  }
  directories.add(name);
}
function ios(bytes) {
  if (bytes.length < 32) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0xfeedfacf || view.getUint32(4, true) !== 0x100000c) return false;
  let at = 32;
  for (let i = 0; i < view.getUint32(16, true); i++) {
    if (at + 8 > bytes.length) return false;
    const command = view.getUint32(at, true),
      size = view.getUint32(at + 4, true);
    if (size < 8 || at + size > bytes.length) return false;
    if (command === 0x25) return true;
    if (command === 0x32 && size >= 24 && view.getUint32(at + 8, true) === 2) return true;
    at += size;
  }
  return false;
}
function signedMachO(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 32;
  for (let i = 0; i < view.getUint32(16, true); i++) {
    if (at + 8 > bytes.length) return false;
    const command = view.getUint32(at, true),
      size = view.getUint32(at + 4, true);
    if (size < 8 || at + size > bytes.length) return false;
    if (command === 0x1d && size >= 16) {
      const start = view.getUint32(at + 8, true),
        length = view.getUint32(at + 12, true);
      if (start + length > bytes.length || length < 12 || view.getUint32(start) !== 0xfade0cc0)
        return false;
      for (let row = 0; row < view.getUint32(start + 8); row++) {
        const index = start + 12 + row * 8;
        if (index + 8 > start + length) return false;
        const blob = start + view.getUint32(index + 4);
        if (
          view.getUint32(index) === 0x10000 &&
          blob + 8 < start + length &&
          view.getUint32(blob) === 0xfade0b01 &&
          view.getUint32(blob + 4) > 8
        )
          return true;
      }
    }
    at += size;
  }
  return false;
}
async function sign(files, directories, appName, credentials) {
  const compiled = await WebAssembly.compile(decode(zsignWasm));
  const native = await createSigner({
    noInitialRun: true,
    print() {},
    printErr() {},
    locateFile() {
      throw new Error("Unexpected runtime fetch");
    },
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports);
      receive(instance, compiled);
      return instance.exports;
    },
  });
  const fs = native.FS,
    root = "/Payload/" + appName;
  const write = (name, data) => {
    fs.mkdirTree(name.slice(0, name.lastIndexOf("/")));
    fs.writeFile(name, data);
  };
  try {
    native._zsign_set_log_level(0);
    for (const name of directories) fs.mkdirTree(root + "/" + name);
    for (const [name, file] of files) write(root + "/" + name, file.data);
    write("/credentials/identity.p12", credentials.identity);
    write("/credentials/profile.mobileprovision", credentials.profile);
    const call = native.cwrap("zsign_sign_bundle", "number", [
      ...Array(9).fill("string"),
      ...Array(5).fill("number"),
    ]);
    const result = call(
      root,
      "",
      "/credentials/identity.p12",
      "/credentials/profile.mobileprovision",
      credentials.password,
      "",
      "",
      "",
      "",
      0,
      1,
      1,
      0,
      0,
    );
    if (result !== 0) throw new Error("Signing failed");
    const output = new Map();
    const walk = (directory, prefix = "") => {
      for (const name of fs.readdir(directory).filter((name) => name !== "." && name !== "..")) {
        const full = directory + "/" + name,
          relative = prefix + name,
          details = fs.stat(full);
        if (fs.isDir(details.mode)) walk(full, relative + "/");
        else
          add(
            output,
            relative,
            new Uint8Array(fs.readFile(full)),
            files.get(relative)?.executable ?? false,
          );
      }
    };
    walk(root);
    if (!output.has("_CodeSignature/CodeResources") || !output.has("embedded.mobileprovision"))
      throw new Error("Signer returned an incomplete bundle");
    for (const [name, file] of files)
      if (ios(file.data) && (!output.has(name) || !signedMachO(output.get(name).data)))
        throw new Error("Signer did not sign every Mach-O image");
    return output;
  } finally {
    credentials.identity.fill(0);
    credentials.profile.fill(0);
    credentials.password = "";
    native.HEAPU8.fill(0);
  }
}

let stage;
self.onmessage = async ({ data: input }) => {
  const progress = (value) => {
    stage = value;
    self.postMessage({ stage });
  };
  try {
    progress("prepare");
    if (!/^[A-Za-z0-9_-]+\.app$/.test(input.template.name)) throw new Error("Invalid app name");
    let files = new Map();
    const directories = new Set();
    for (const file of input.template.files) {
      if (
        /\.p12$|\.pfx$|\.keys$|\.mobileprovision$|(?:^|\/)_CodeSignature(?:\/|$)/i.test(file.path)
      )
        throw new Error("Template must be unsigned and contain no credentials");
      add(files, file.path, file.data, file.executable);
    }
    if (
      !files.has("Info.plist") ||
      ![...files.values()].some((file) => file.executable && ios(file.data))
    )
      throw new Error("An unsigned arm64 iOS host template is required");
    if (input.nsp || input.modules) {
      const { instance } = await WebAssembly.instantiate(decode(bridgeWasm), {}),
        wasm = instance.exports;
      const invoke = (request) => {
        const bytes = utf8.encode(JSON.stringify({ version: 1, ...request }));
        const pointer = wasm.nx2ipa_alloc(bytes.length);
        let output, size;
        try {
          new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
          const packed = wasm.nx2ipa_call(pointer, bytes.length);
          output = Number(packed >> 32n);
          size = Number(packed & 0xffffffffn);
          const result = JSON.parse(text.decode(new Uint8Array(wasm.memory.buffer, output, size)));
          if (!result.ok) throw new Error("Conversion input rejected");
          return result;
        } finally {
          bytes.fill(0);
          wasm.nx2ipa_dealloc(pointer, bytes.length);
          if (output) wasm.nx2ipa_dealloc(output, size);
        }
      };
      let modules = input.modules,
        npdm = input.npdm,
        resources = input.resources;
      directory(files, directories, "nxkit/romfs");
      if (input.nsp) {
        progress("extract");
        const extracted = invoke({
          op: "extract",
          nsp: encode(input.nsp),
          keys: encode(input.keys),
        });
        if (
          input.profile.titleId &&
          input.profile.titleId.toLowerCase() !== extracted.titleId.toLowerCase()
        )
          throw new Error("Title mismatch");
        input.profile.titleId = extracted.titleId;
        if (
          input.profile.version !== undefined &&
          input.profile.version !== extracted.metadata.version
        )
          throw new Error("Version mismatch");
        input.profile.version = extracted.metadata.version;
        modules = extracted.modules.map((module) => ({
          name: module.name,
          data: decode(module.data),
        }));
        npdm = decode(extracted.npdm);
        for (const name of extracted.directories) directory(files, directories, "nxkit/" + name);
        resources = [
          ...extracted.files.map((file) => ({ path: file.path, data: decode(file.data) })),
          ...resources,
        ];
        input.keys.fill(0);
      }
      if (!input.profile.modules)
        input.profile.modules = modules
          .filter((module) => module.name !== "rtld")
          .map((module) => ({
            name: module.name,
            buildId: [...module.data.subarray(0x40, 0x50)]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join(""),
          }));
      progress("build");
      const generated = invoke({
        op: "buildRunfolder",
        profile: input.profile,
        modules: modules.map((module) => ({ name: module.name, data: encode(module.data) })),
        npdm: encode(npdm),
      });
      if (input.shaders?.length) {
        progress("shaders");
        generated.files.push(
          ...invoke({
            op: "compileShaders",
            jobs: input.shaders.map((shader) => ({ job: shader.job, code: encode(shader.code) })),
          }).files,
        );
      }
      progress("assemble");
      if (!ios(decode(generated.files.find((file) => file.path === "nxgame.dylib").data)))
        throw new Error("Expected iOS guest image");
      const gameFile = generated.files.find((file) => file.path === "game.json");
      const game = JSON.parse(text.decode(decode(gameFile.data)));
      game.dylib = "Frameworks/nxgame.dylib";
      game.romfs = "nxkit/romfs";
      game.romfs_empty =
        !resources.some((file) => file.path.startsWith("romfs/")) && directories.size === 1;
      for (const field of ["npdm", "patches", "input"])
        if (game[field]) game[field] = "nxkit/" + path(game[field]);
      if (game.settings?.shared_font)
        game.settings.shared_font = "nxkit/" + path(game.settings.shared_font);
      for (const module of game.modules)
        for (const field of ["image", "imports", "exports", "gates", "fixups"])
          if (module[field]) module[field] = "nxkit/" + path(module[field]);
      for (const file of [
        ...generated.files.map((file) => ({ path: file.path, data: decode(file.data) })),
        ...resources,
      ]) {
        const name =
          file.path === "nxgame.dylib"
            ? "Frameworks/nxgame.dylib"
            : file.path === "game.json"
              ? "game.json"
              : "nxkit/" + file.path;
        add(
          files,
          name,
          file.path === "game.json" ? utf8.encode(JSON.stringify(game)) : file.data,
          file.path === "nxgame.dylib",
        );
      }
    }
    if (input.signing) {
      progress("sign");
      files = await sign(files, directories, input.template.name, input.signing);
    }
    progress("package");
    const archive = Object.create(null);
    for (const [name, file] of files)
      archive[`Payload/${input.template.name}/${name}`] = [
        file.data,
        {
          os: 3,
          attrs: ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0,
          mtime: new Date("2000-01-01T00:00:00Z"),
        },
      ];
    // ZIP must retain empty RomFS directories as well as files.
    for (const name of directories)
      archive[`Payload/${input.template.name}/${name}/`] = [
        new Uint8Array(),
        { os: 3, attrs: (0o40755 << 16) >>> 0, mtime: new Date("2000-01-01T00:00:00Z") },
      ];
    const ipa = zipSync(archive, { level: 0 });
    self.postMessage({ result: { ipa, signed: !!input.signing, deviceValidated: false } }, [
      ipa.buffer,
    ]);
  } catch {
    self.postMessage({
      error: `Conversion failed during ${stage ?? "startup"}. Check the selected inputs.`,
    });
  } finally {
    input.keys?.fill(0);
    input.signing?.identity.fill(0);
    input.signing?.profile.fill(0);
    if (input.signing) input.signing.password = "";
  }
};
