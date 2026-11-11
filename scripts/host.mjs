import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
export const sha256 = data => createHash("sha256").update(data).digest("hex");

// Experimental is a separate, explicit build mode. Never turn test evidence into
// runtimeReady or device/gameplay validation, and never silently use a fake host.
export async function experimentalHost() {
  const directory = resolve(root, ".build/ios/test");
  const manifest = JSON.parse(await readFile(resolve(directory, "host-test.json")));
  const test = JSON.parse(await readFile(resolve(directory, "integration-test.json")));
  const pin = JSON.parse(await readFile(resolve(root, "nxkit.json")));
  if (manifest.kind !== "unsigned-native-test-host" || manifest.sdkLinked !== true ||
      manifest.unsigned !== true || manifest.runtimeReady !== false ||
      manifest.deviceValidated !== false || manifest.gameplayValidated !== false ||
      test.runtimeReady !== false || test.deviceValidated !== false || test.gameplayValidated !== false ||
      test.bundleContractAccepted !== true || test.syntheticHostAndGuestCmsVerified !== true ||
      test.nativeHostSha256 !== manifest.binarySha256 ||
      manifest.source?.nxkit?.commit !== pin.commit || manifest.source?.nxkit?.tree !== pin.tree ||
      (process.env.GITHUB_SHA && manifest.source?.commit !== process.env.GITHUB_SHA))
    throw new Error("Experimental host lacks matching SDK and package-contract evidence");
  if (!/^[\w.-]+\.app$/.test(manifest.appName) || !/^[\w.-]+$/.test(manifest.executable) ||
      manifest.source.file !== "native-source.tar.gz") throw new Error("Invalid native artifact paths");
  for (const [path, expected] of [
    [`${manifest.appName}/${manifest.executable}`, manifest.binarySha256],
    [`${manifest.appName}/Info.plist`, manifest.infoPlistSha256],
    [manifest.source.file, manifest.source.sha256],
  ]) if (sha256(await readFile(resolve(directory, path))) !== expected)
    throw new Error("Experimental host artifact hash mismatch: " + path);
  return { directory, manifest, test };
}
