# Swift iOS shell and Rust runtime

This is downstream nx2ipa code, not the legacy host or its patch stack. The
pinned `.build/nxkit` checkout is never rewritten. Reused modules are unchanged;
new crate compositions and platform implementations are explicit adaptations,
not claims that upstream itself supports iOS.

Implemented:

- Swift UIKit app entry, scene lifecycle, CAMetalLayer sizing, error display
  and 16-point multitouch. A small C ABI connects the shell to the existing Rust
  runtime, including GameController/Core Haptics and display-rate policy.
- Signed guest-dylib loading through dyld only. The host checks ARM64/iOS 26,
  rejects automatic initializers and dependencies except libSystem, validates module segments,
  moves addresses by dyld's slide, and reserves non-executable guest memory.
  No JIT or macOS executable-file mapping fallback is used. Interior image
  padding remains owned by dyld; only the post-image guest tail is newly reserved.
- Real shared guest kernel, imports/relocations, thread gates and SDK boot sequence.
- Metal/MetalFX/CoreML and GPU module compositions. CAMetalDisplayLink feeds the
  actual NVN/GPU presentation path. Desktop display-mode control is excluded.
- VideoToolbox VP9/hardware AV1 decode with explicit unsupported-format/device
  errors. There is no bundled software AV1 fallback.
- RemoteIO stereo audio, foreground gating, independent interruption state,
  asynchronous route/interruption recovery, and callback lifetime protection.
- Canonical bundle asset validation and separate sandbox save/temp/cache paths.
  The app never write-probes its signed bundle. Explicit empty RomFS metadata
  can materialize an empty private directory.

## Build and evidence

`bun scripts/build-ios.mjs --prepare` assembles separate module trees under
`.build/ios`. Each shared file is verified against the pinned Git blob first.
`source.json` receipts list unchanged source hashes and explicit adapter hashes.
The auxiliary nxb-xlate tree supplies unchanged GPU test fixtures. No source text
substitutions are performed, and no generated native binary is committed.
The Swift shell sources live in `ios/shell`; `ios/app/include/nx2ipa.h` is the
main-thread-only engine contract. The old Rust UIKit shell/main is removed.

`--check` type-checks all iOS workspace targets and runs portable tests.
On macOS with Xcode, `--link-check` tests the host/C ABI and pure Swift touch
logic, then links the **real** `nx2ipa` Swift app executable against the Rust static
library, including its loader/kernel/GPU, and checks ARM64, iOS 26.0 and absence of AppKit.
Rust reports its native framework dependencies directly to the Swift link step.
The command does not produce a production readiness receipt.

The Linux Rust check uses `DOCS_RS=1` solely to skip objc2's Objective-C exception
helper compilation, since it has no Xcode/Clang. That is not SDK-link evidence.
Portable tests run with `RUSTFLAGS='--cap-lints warn'` because an unchanged nxkit
non-ARM documentation lint otherwise prevents the Linux test build.

## Remaining verification and limitations

- Swift/UIKit SDK linking is a separate gate from portable touch and Rust tests.
- No physical iPhone install or guest/gameplay run has been verified. Signing,
  provisioning, address-space/memory limits and device GPU/codec support matter.
- Automatic shader discovery/conversion must supply the resources under
  `nxkit/shaders`; native linking cannot replace missing game shader assets.
- The shared kernel has process-lifetime state and detached guest threads. One
  game is allowed per process. Scene disconnect pauses UI/audio and requests
  process shutdown; it does not unsafely unmap guest memory or unload live code.
- Maximum FPS is not proof of adaptive refresh. The initial display-link policy
  is fixed-rate unless adaptive capability is independently established.
- Physical touches, controllers, audio routes/interruption/resume, decoding,
  Metal frame delivery and memory pressure all require device testing.

No command sets `runtimeReady: true` merely because compilation or linking passed.
The browser's default flow remains blocked until an actual built-in host can be
validated and embedded; no separate host upload is part of the intended flow.

## Unsigned test artifact

On macOS, `bun scripts/build-ios.mjs --test-artifact` runs the same real SDK
link checks, then assembles `.build/ios/test/Nx2ipa.app`. It removes only a
confirmed ad-hoc signature from the copied executable and verifies unsigned
status with both its load commands and codesign. The original build is untouched.

`host-test.json` records executable/plist/source hashes and SDK evidence. It
keeps `runtimeReady`, `deviceValidated`, `gameplayValidated`, bundle-contract and
synthetic-signing validation false. It is not `.build/ios/host.json` and does not
pass the production gate. No game or credentials are included.

The same artifact includes `native-source.tar.gz`: exact native sources,
unchanged pinned nxkit source plus offline verification objects, vendored Cargo
dependencies with licenses (including pinned Git monorepo root licenses), Rust notices and rebuild instructions. Keep the
source/notices beside any redistributed test host. Apple SDKs are not included.

The portable `validate_bundle` example checks a converter-generated app against
actual host bundle, guest Mach-O, module-segment and address-layout rules:

```
cargo run --offline --locked --manifest-path ios/Cargo.toml -p nx2ipa-ios-host \
  --example validate_bundle -- /absolute/path/Game.app
```

Success establishes that contract only. It does not execute guest code, verify
Apple signing trust, establish successful installation or prove gameplay.

## Dyld image padding regression

Apple dyld reserves the full image span before overlaying its file segments
([dyld-1330 Loader.cpp](https://github.com/apple-oss-distributions/dyld/blob/dyld-1330/dyld/Loader.cpp#L1501-L1617)).
Attempting another nonfixed mapping in those padding gaps fails because they
are already allocated. The host now only inspects that padding and leaves its
mappings and protections unchanged. Genuine holes are not filled, and the GPU
buffer excludes all image padding. Five portable tests cover reserved padding,
holes, mixed VM regions, overlapping segments and a negative image slide. This is a source-backed
loader correction, not evidence that a game has booted on an iPhone.
