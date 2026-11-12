import { zipSync, unzipSync } from "fflate";
import { nameFromNacp, appIcons, installMetadata } from "./metadata.js";
import { bridgeWasm, zsignWasm } from "nx2ipa:assets";
import embeddedHost from "nx2ipa:host";
import createSigner from "nx2ipa:signer";

const decode = (text) => {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const encode = (bytes) => {
  if (bytes.toBase64) return bytes.toBase64();
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
function inferModules(modules) {
  // ExeFS physical/PFS0 order is not necessarily the loader's module order.
  const rank = (name) => name === "main" ? 0
    : /^subsdk[0-9]$/.test(name) ? 1 + Number(name.slice(6))
    : name === "sdk" ? 11 : -1;
  const selected = modules.filter((module) => module.name !== "rtld");
  if (selected.some((module) => rank(module.name) < 0))
    throw new Error("Unknown ExeFS module name; explicit module load order is required");
  return selected.sort((a, b) => rank(a.name) - rank(b.name)).map((module) => ({
    name: module.name,
    buildId: [...module.data.subarray(0x40, 0x50)]
      .map((value) => value.toString(16).padStart(2, "0")).join(""),
  }));
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
function appEntitlements(xml, identifier) {
  // zsign serializes the profile's entitlements. Only rewrite root App ID and
  // keychain strings, leaving unrelated capabilities and nested values alone.
  const strings = (visit) => {
    let depth = 0, key;
    return xml.replace(/<\/?(?:dict|array)>|<key>([^<]+)<\/key>|<string>([^<]*)<\/string>/g, (token, name, value) => {
      if (name !== undefined) { if (depth === 1) key = name; }
      else if (value !== undefined) {
        if ((depth === 1 && key === "application-identifier") || (depth === 2 && key === "keychain-access-groups"))
          return `<string>${visit(key, value)}</string>`;
      } else if (token[1] === "/") depth--;
      else depth++;
      return token;
    });
  };
  let applicationId;
  strings((key, value) => { if (key === "application-identifier") applicationId = value; return value; });
  const prefix = applicationId?.match(/^([^.]+)\./)?.[1];
  const expected = `${prefix}.${identifier}`;
  const matches = (value) => value === expected || (value.endsWith("*") && expected.startsWith(value.slice(0, -1)));
  if (!identifier || !prefix || !matches(applicationId))
    throw new Error(`Signing requires a provisioning App ID matching ${identifier || "the app bundle ID"}`);
  return strings((key, value) => {
    if (key === "application-identifier") return expected;
    if (!value.includes("*")) return value;
    if (!matches(value)) throw new Error("Provisioning keychain wildcard does not match the app's App ID");
    return expected;
  });
}
function signedMachO(bytes, expand) {
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
      let cms = false, identifier, entitlements;
      for (let row = 0; row < view.getUint32(start + 8); row++) {
        const index = start + 12 + row * 8;
        if (index + 8 > start + length) return false;
        const slot = view.getUint32(index), blob = start + view.getUint32(index + 4);
        if (blob + 8 > start + length) return false;
        const magic = view.getUint32(blob), size = view.getUint32(blob + 4);
        if (size < 8 || blob + size > start + length) return false;
        if (slot === 0x10000 && magic === 0xfade0b01 && size > 8) cms = true;
        if (slot === 0 && magic === 0xfade0c02 && size >= 44) {
          const offset = blob + view.getUint32(blob + 20), end = bytes.indexOf(0, offset);
          if (offset < blob + 44 || end < offset || end >= blob + size) return false;
          identifier = text.decode(bytes.subarray(offset, end));
        }
        if (slot === 5 && magic === 0xfade7171) entitlements = text.decode(bytes.subarray(blob + 8, blob + size));
      }
      if (cms && view.getUint32(12, true) === 2) {
        const prepared = appEntitlements(entitlements ?? "", identifier);
        if (prepared !== entitlements) {
          if (!expand) throw new Error("Signer did not apply the app's expanded entitlements");
          expand(prepared);
        }
      }
      return cms;
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
    const signBundle = (entitlements = "") => call(
      root,
      "",
      "/credentials/identity.p12",
      "/credentials/profile.mobileprovision",
      credentials.password,
      entitlements,
      "",
      "",
      "",
      0,
      1,
      1,
      0,
      0,
    );
    if (signBundle() !== 0) throw new Error("Signing failed");
    let expanded;
    for (const [name, file] of files) {
      if (!ios(file.data) || new DataView(file.data.buffer, file.data.byteOffset).getUint32(12, true) !== 2) continue;
      signedMachO(fs.readFile(root + "/" + name), (xml) => {
        if (expanded && expanded !== xml) throw new Error("Nested apps need separate provisioning entitlements");
        expanded = xml;
      });
    }
    if (expanded) {
      // Re-sign, rather than patching signed bytes: XML/DER entitlements and
      // their CodeDirectory hashes must all be regenerated together.
      write("/credentials/entitlements.plist", utf8.encode(expanded));
      if (signBundle("/credentials/entitlements.plist") !== 0) throw new Error("Signing failed");
    }
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
    const builtInHost = !input.template && !!embeddedHost;
    const experimental = builtInHost && embeddedHost.experimental === true;
    if (!input.template && embeddedHost) input.template = {
      name: embeddedHost.appName,
      files: Object.entries(unzipSync(decode(embeddedHost.zip)))
        .filter(([path]) => !path.endsWith("/"))
        .map(([path, data]) => ({ path, data, executable: path === embeddedHost.executable || ios(data) })),
    };
    if (!input.template) throw new Error("This build does not include an iOS host runtime");
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
    const warnings = [];
    if (experimental) {
      warnings.push("Experimental native iOS runtime: device execution and gameplay have not been validated.");
      if (!input.signing)
        warnings.push("Unsigned IPA: valid external signing and provisioning are required before installation.");
    }
    let shaderCount = 0;
    if (input.nsp || input.xci || input.modules) {
      const sources = [input.nsp ?? input.xci, input.update];
      const reader = typeof FileReaderSync === "function" ? new FileReaderSync() : undefined;
      let bufferedSize = 0;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source) continue;
        if (!(source instanceof Blob) || !reader) {
          bufferedSize += source instanceof Blob ? source.size : source.length;
          if (bufferedSize > 256 * 1024 ** 2)
            throw new Error("This runtime buffers container inputs; their combined limit is 256 MiB. Use a browser with FileReaderSync for larger containers");
        }
      }
      for (let i = 0; i < sources.length; i++)
        if (sources[i] instanceof Blob && !reader)
          sources[i] = new Uint8Array(await sources[i].arrayBuffer());
      let wasm, instance;
      ({ instance } = await WebAssembly.instantiate(decode(bridgeWasm), {
        nx2ipa: { read(sourceIndex, offset, destination, length) {
          const source = sources[sourceIndex];
          const start = Number(offset), end = start + length;
          const size = source instanceof Blob ? source.size : source?.length;
          if (!Number.isSafeInteger(start) || start < 0 || end > size) return 1;
          try {
            const bytes = source instanceof Blob
              ? new Uint8Array(reader.readAsArrayBuffer(source.slice(start, end)))
              : source.subarray(start, end);
            new Uint8Array(wasm.memory.buffer, destination, length).set(bytes);
            return 0;
          } catch { return 1; }
        } },
      }));
      wasm = instance.exports;
      if (wasm.nx2ipa_abi_version() !== 2) throw new Error("Incompatible extraction bridge; rebuild the JS and WASM together");
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
          if (!result.ok) throw new Error(result.error || "Conversion input rejected");
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
      if (sources[0]) {
        progress("extract");
        const extracted = invoke({
          op: "extract",
          sourceSize: sources[0] instanceof Blob ? sources[0].size : sources[0].length,
          ...(sources[1] ? { updateSize: sources[1] instanceof Blob ? sources[1].size : sources[1].length } : {}),
          keys: encode(input.keys),
        });
        input.profile ??= {};
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
        const control = extracted.files.find((file) => file.path === "control.nacp");
        input.profile.name ??= (control && nameFromNacp(decode(control.data))) || `Game ${extracted.titleId}`;
        input.profile.versionName ??= extracted.metadata.versionName;
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
        sources.fill(undefined);
        input.nsp = input.xci = input.update = undefined;
      }
      if (!input.profile.modules) input.profile.modules = inferModules(modules);
      progress("build");
      const generated = invoke({
        op: "buildRunfolder",
        profile: input.profile,
        modules: modules.map((module) => ({ name: module.name, data: encode(module.data) })),
        npdm: encode(npdm),
      });
      progress("shaders");
      const shaders = invoke(input.shaders?.length ? {
        op: "compileShaders",
        jobs: input.shaders.map((shader) => ({ job: shader.job, code: encode(shader.code) })),
      } : {
        op: "discoverShaders",
        modules: modules.map((module) => ({ name: module.name, data: encode(module.data) })),
        files: resources.filter((file) => file.path.startsWith("romfs/")).map((file) => ({
          path: file.path.slice(6), data: encode(file.data),
        })),
      });
      generated.files.push(...shaders.files);
      shaderCount = shaders.count;
      warnings.push(...shaders.warnings);
      if (!shaderCount)
        warnings.push("No shaders were found in the supported containers. Gameplay compatibility is not verified.");
      // Let the engine reclaim the large linear memory before decoding and
      // packaging the generated files. Never retain both base64 and bytes.
      wasm = instance = modules = npdm = input.modules = input.npdm = undefined;
      progress("assemble");
      for (const file of generated.files) file.data = decode(file.data);
      const guestFile = generated.files.find((file) => file.path === "nxgame.dylib");
      const guest = guestFile.data;
      if (!ios(guest)) throw new Error("Expected iOS guest image");
      const gameFile = generated.files.find((file) => file.path === "game.json");
      const game = JSON.parse(text.decode(gameFile.data));
      if (builtInHost) {
        const icon = resources.find((file) => file.path === "icon.jpg");
        let icons = [];
        if (icon) {
          try { icons = appIcons(icon.data); }
          catch { warnings.push("The game icon is invalid or exceeds the image limits; the IPA has no game app icon."); }
        } else warnings.push("No game icon was found in Control metadata; the IPA has no game app icon.");
        for (const image of icons) add(files, image.path, image.data);
        const plist = files.get("Info.plist");
        plist.data = utf8.encode(installMetadata(text.decode(plist.data), game.name, icons.length > 0));
      }
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
        ...generated.files,
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
    self.postMessage({ result: {
      ipa, signed: !!input.signing, deviceValidated: false, warnings, shaderCount,
      name: input.profile?.name || input.template.name.slice(0, -4),
      titleId: input.profile?.titleId,
    } }, [
      ipa.buffer,
    ]);
  } catch (error) {
    const reason = String(error?.message || "Check the selected inputs.").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
    self.postMessage({
      error: `Conversion failed during ${stage ?? "startup"}. ${reason}`,
    });
  } finally {
    input.keys?.fill(0);
    input.signing?.identity.fill(0);
    input.signing?.profile.fill(0);
    if (input.signing) input.signing.password = "";
  }
};
