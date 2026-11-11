import { createHash } from "node:crypto";
import { mkdir, readFile, lstat, symlink, mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, join } from "node:path";
import { command } from "./source.mjs";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, ".build/nxkit");
const git = resolve(root, ".build/nxkit.git");
const sha = (data) => createHash("sha256").update(data).digest("hex");

/** Assemble an explicitly separate adapter, never modify nxkit's files.
 * Only the explicit platform boundaries are ours; shared source stays byte-identical. */
async function prepareAdapter(name, crateName, replaced, adapter) {
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
      const original = item.relative === replaced
        ? resolve(root, adapter) : resolve(source, item.path);
      await symlink(relative(dirname(output), original), output);
    }
    await writeFile(join(temp, "source.json"), JSON.stringify({
      nxkit: pin,
      adapter: { path: adapter, sha256: sha(await readFile(resolve(root, adapter))) },
      unchanged: files.filter(f => f.relative !== replaced).map(({ path, sha256 }) => ({ path, sha256 })),
    }, null, 2) + "\n");
    const output = join(parent, name);
    await rm(output, { recursive: true, force: true });
    await rename(temp, output);
    return { output, reusedModules: files.length - 1 };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export const prepareIosInput = () => prepareAdapter("input", "nxkit-svc-input", "sys/mod.rs", "ios/input/platform.rs");
export const prepareIosAudio = () => prepareAdapter("audio", "nxkit-svc-audio", "sys/au.rs", "ios/audio/output.rs");

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
  if (process.argv[2] !== "--check" && process.argv[2] !== "--prepare" && process.argv[2] !== "--link-check") {
    throw new Error("No complete iOS guest runtime is linked. --check verifies the Rust UIKit/input/audio adapters only; it cannot produce a production host template.");
  }
  const input = await prepareIosInput(), audio = await prepareIosAudio();
  console.log(`Prepared iOS input/audio adapters with ${input.reusedModules + audio.reusedModules} unchanged nxkit modules`);
  if (process.argv[2] === "--link-check") {
    if (process.platform !== "darwin") throw new Error("The iOS SDK link check requires macOS with Xcode");
    process.env.SDKROOT = await command(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"]);
    process.env.IPHONEOS_DEPLOYMENT_TARGET = "26.0";
    console.log(await command(["cargo", "build", "--locked", "--manifest-path", "ios/Cargo.toml", "--example", "link_probe", "--target", "aarch64-apple-ios", "--release"]));
    const binary = resolve(root, "ios/target/aarch64-apple-ios/release/examples/link_probe");
    const build = await command(["xcrun", "vtool", "-show-build", binary]);
    const libraries = await command(["otool", "-L", binary]);
    const arch = await command(["lipo", "-archs", binary]);
    // Print the SDK evidence before asserting so CI failures identify the exact boundary.
    console.log(`Native probe architectures: ${JSON.stringify(arch)}\n${build}\n${libraries}`);
    verifyIosProbe(arch, build, libraries);
    console.log("Linked Rust UIKit/input/audio SDK probe only. No production host or runtimeReady receipt was produced.");
  }
  if (process.argv[2] === "--check") {
    console.log(await command(["cargo", "check", "--locked", "--manifest-path", "ios/Cargo.toml", "--workspace", "--all-targets", "--target", "aarch64-apple-ios"]));
    console.log(await command(["cargo", "test", "--locked", "--manifest-path", "ios/Cargo.toml", "--workspace"]));
    console.log("Rust iOS adapters type-checked. No app, IPA, or runtimeReady receipt was produced.");
  }
}
