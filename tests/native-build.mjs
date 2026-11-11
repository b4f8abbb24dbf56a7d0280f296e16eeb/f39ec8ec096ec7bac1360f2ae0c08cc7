import assert from "node:assert/strict";
import { command } from "../scripts/source.mjs";
import { verifyIosProbe } from "../scripts/build-ios.mjs";

// Bun may inherit its initial environment unless an explicit env is supplied.
// The SDK and deployment floor are selected after process startup in build-ios.
const previous = process.env.NX2IPA_TEST_ENV;
try {
  process.env.NX2IPA_TEST_ENV = "set-after-start";
  assert.equal(await command([process.execPath, "-e", "console.log(process.env.NX2IPA_TEST_ENV ?? 'missing')"]), "set-after-start");
} finally {
  if (previous === undefined) delete process.env.NX2IPA_TEST_ENV;
  else process.env.NX2IPA_TEST_ENV = previous;
}
const build = "cmd LC_BUILD_VERSION\n platform IOS\n minos 26.0\n sdk 26.5";
const libraries = "/System/Library/Frameworks/UIKit.framework/UIKit";
assert.doesNotThrow(() => verifyIosProbe("arm64", build, libraries));
for (const [arch, metadata, dylibs] of [
  ["x86_64", build, libraries],
  ["arm64 arm64e", build, libraries],
  ["arm64", build.replace("IOS", "IOSSIMULATOR"), libraries],
  ["arm64", build.replace("IOS", "MACOS"), libraries],
  ["arm64", build.replace("26.0", "10.0"), libraries],
  ["arm64", "cmd LC_VERSION_MIN_IPHONEOS\n version 10.0\n sdk 26.5", libraries],
  ["arm64", build, "/System/Library/Frameworks/AppKit.framework/AppKit"],
]) assert.throws(() => verifyIosProbe(arch, metadata, dylibs));
console.log("Native build environment and strict iOS target checks passed");
