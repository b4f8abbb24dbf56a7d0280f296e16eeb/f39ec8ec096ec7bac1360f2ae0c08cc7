import { createHash } from "node:crypto";
import { mkdir, readFile, lstat, symlink, mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, join } from "node:path";
import { command } from "./source.mjs";
import { createTestArtifact } from "../ios/artifact.mjs";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, ".build/nxkit");
const git = resolve(root, ".build/nxkit.git");
const sha = (data) => createHash("sha256").update(data).digest("hex");

/** Assemble an explicitly separate adapter, never modify nxkit's files.
 * Only the explicit platform boundaries are ours; shared source stays byte-identical. */
async function prepareAdapter(name, crateName, overrides) {
  const pin = JSON.parse(await readFile(resolve(root, "nxkit.json")));
  if (await command(["git", "-C", git, "rev-parse", `${pin.commit}^{tree}`]) !== pin.tree)
    throw new Error("nxkit checkout does not match the pin; run bun run source");
  const base = `crates/${crateName}/src`;
  const tracked = (await command(["git", "-C", git, "ls-tree", "-r", pin.commit, base]))
    .split("\n").filter(Boolean).map(line => {
      const [mode, kind, oid, path] = line.split(/[ \t]+/);
      if (mode !== "100644" || kind !== "blob") throw new Error("Unexpected source file kind");
      return { oid, path, relative: path.slice(base.length + 1) };
    });
  if (!tracked.some(f => f.relative === "lib.rs")) throw new Error("Missing pinned adapter source crate");
  const files = [];
  for (const item of tracked) {
    const path = resolve(source, item.path);
    if (!(await lstat(path)).isFile()) throw new Error(`Not an ordinary source file: ${item.path}`);
    const data = await readFile(path);
    const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
    if (oid !== item.oid) throw new Error(`nxkit source differs from pin: ${item.path}`);
    files.push({ ...item, sha256: sha(data) });
  }
  const parent = resolve(root, ".build/ios");
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, `.${name}-`));
  try {
    for (const item of files) {
      const output = join(temp, "src", item.relative);
      await mkdir(dirname(output), { recursive: true });
      const original = overrides[item.relative]
        ? resolve(root, overrides[item.relative]) : resolve(source, item.path);
      await symlink(relative(dirname(output), original), output);
    }
    for (const [module, adapter] of Object.entries(overrides)) {
      if (files.some(f => f.relative === module)) continue;
      const output = join(temp, "src", module);
      await mkdir(dirname(output), { recursive: true });
      await symlink(relative(dirname(output), resolve(root, adapter)), output);
    }
    const adapters = await Promise.all(Object.entries(overrides).map(async ([module, path]) => ({
      module, path, sha256: sha(await readFile(resolve(root, path))),
    })));
    await writeFile(join(temp, "source.json"), JSON.stringify({
      nxkit: pin, adapters,
      unchanged: files.filter(f => !overrides[f.relative]).map(({ path, sha256 }) => ({ path, sha256 })),
    }, null, 2) + "\n");
    const output = join(parent, name);
    await rm(output, { recursive: true, force: true });
    await rename(temp, output);
    return { output, reusedModules: files.filter(f => !overrides[f.relative]).length };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

const adapters = {
  input: ["nxkit-svc-input", { "sys/mod.rs": "ios/input/platform.rs" }],
  audio: ["nxkit-svc-audio", { "lib.rs": "ios/audio/lib.rs", "sys/au.rs": "ios/audio/output.rs" }],
  metal: ["nxkit-metal", { "lib.rs": "ios/metal/lib.rs", "present.rs": "ios/metal/present.rs" }],
  coreml: ["nxkit-coreml", { "lib.rs": "ios/coreml/lib.rs" }],
  gpu: ["nxkit-gpu", { "lib.rs": "ios/gpu/lib.rs" }],
  video: ["nxkit-svc-video", { "lib.rs": "ios/video/lib.rs", "backend.rs": "ios/video/backend.rs", "frame.rs": "ios/video/frame.rs", "sys/mod.rs": "ios/video/sys.rs" }],
  system: ["nxkit-svc-system", { "sys.rs": "ios/system/platform.rs" }],
  runtime: ["nxkit-rt", {}],
  "nxb-xlate": ["nxb-xlate", {}],
  host: ["nxkit-host", { "lib.rs": "ios/host/lib.rs", "place.rs": "ios/host/place.rs", "refresh.rs": "ios/host/refresh.rs", "pipecache.rs": "ios/host/pipecache.rs", "sys/appkit.rs": "ios/host/window.rs", "sys/mouse.rs": "ios/host/pointer.rs", "session.rs": "ios/host/session.rs", "bundle.rs": "ios/host/bundle.rs", "image.rs": "ios/host/image.rs", "padding.rs": "ios/host/padding.rs" }],
};
export const prepareIosAdapter = (name) => {
  if (!Object.hasOwn(adapters, name)) throw new Error(`Unknown iOS adapter: ${name}`);
  return prepareAdapter(name, ...adapters[name]);
};
export const prepareIosInput = () => prepareIosAdapter("input");
export const prepareIosAudio = () => prepareIosAdapter("audio");

/** Reject the wrong architecture, simulator/desktop targets, or a lost deployment floor. */
export function verifyIosProbe(arch, build, libraries) {
  const failures = [];
  if (arch !== "arm64") failures.push(`architecture is ${JSON.stringify(arch)}, expected arm64`);
  if (!/^\s*platform\s+IOS\s*$/m.test(build)) failures.push("vtool does not report platform IOS");
  if (!/^\s*minos\s+26\.0(?:\.0)?\s*$/m.test(build)) failures.push("the deployment target is not iOS 26.0");
  if (/AppKit/.test(libraries)) failures.push("the probe links AppKit");
  if (failures.length) throw new Error(`The native probe is not an arm64 iOS 26.0 link: ${failures.join("; ")}`);
}

if (import.meta.main) {
  if (process.argv[2] !== "--check" && process.argv[2] !== "--prepare" && process.argv[2] !== "--link-check" && process.argv[2] !== "--test-artifact") {
    throw new Error("The native runtime has not passed installation/gameplay validation. Use --check, --link-check or --test-artifact for build verification; no production host receipt is generated.");
  }
  const prepared = [];
  for (const name of Object.keys(adapters)) prepared.push(await prepareIosAdapter(name));
  console.log(`Prepared iOS adapters with ${prepared.reduce((sum, item) => sum + item.reusedModules, 0)} unchanged nxkit source files`);
  if (process.argv[2] === "--link-check" || process.argv[2] === "--test-artifact") {
    if (process.platform !== "darwin") throw new Error("The iOS SDK link check requires macOS with Xcode");
    process.env.SDKROOT = await command(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"]);
    process.env.IPHONEOS_DEPLOYMENT_TARGET = "26.0";
    if (process.argv[2] === "--test-artifact") {
      // Vendor all lockfile dependencies, including portable validator/test targets.
      await command(["cargo", "fetch", "--locked", "--manifest-path", "ios/Cargo.toml"]);
    }
    console.log(await command(["cargo", "build", "--locked", "--manifest-path", "ios/Cargo.toml", "--package", "nx2ipa-ios-app", "--bin", "nx2ipa", "--target", "aarch64-apple-ios", "--release"]));
    const binary = resolve(root, "ios/target/aarch64-apple-ios/release/nx2ipa");
    const build = await command(["xcrun", "vtool", "-show-build", binary]);
    const libraries = await command(["otool", "-L", binary]);
    const arch = await command(["lipo", "-archs", binary]);
    // Print the SDK evidence before asserting so CI failures identify the exact boundary.
    console.log(`Native app architectures: ${JSON.stringify(arch)}\n${build}\n${libraries}`);
    verifyIosProbe(arch, build, libraries);
    console.log("Linked the real Rust iOS app, guest loader/kernel and GPU/service adapters. Installation and gameplay are unverified; no runtimeReady receipt was produced.");
    if (process.argv[2] === "--test-artifact") {
      console.log("Unsigned test artifact: " + await createTestArtifact(binary, { architecture: arch, build, libraries }, Object.keys(adapters), verifyIosProbe));
    }
  }
  if (process.argv[2] === "--check") {
    console.log(await command(["cargo", "check", "--locked", "--manifest-path", "ios/Cargo.toml", "--workspace", "--all-targets", "--target", "aarch64-apple-ios"]));
    console.log(await command(["cargo", "test", "--locked", "--manifest-path", "ios/Cargo.toml", "--workspace"]));
    console.log("Rust iOS adapters type-checked. No app, IPA, or runtimeReady receipt was produced.");
  }
}
