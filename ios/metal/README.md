# iOS Metal adapter

The crate composes the pinned upstream Metal modules through the separately prepared `.build/ios/metal` symlink tree. The source checkout is never edited. `lib.rs` and `present.rs` are the only downstream module boundaries.

- Metal 4 device, command queues, buffers, pipeline compilation, residency, frame scheduling, MetalFX and encoding are upstream code, not substitute implementations.
- The presenter retains the UIKit host's actual `CAMetalLayer`; frame submission owns its drawable and texture. The host must attach and resize the layer on the main thread.
- Desktop `CGDisplay` mode switching is absent. iOS pacing uses the unchanged `CAMetalDisplayLink` implementation. Disabling display synchronization returns an explicit error.
- iOS 26 and a Metal 4-capable physical device are required. Successful cross-compilation cannot establish hardware feature support or working guest graphics.
- The Core ML and GPU sibling crates likewise compose unchanged shared modules under an iOS root. GPU video frames come from the downstream video adapter, so there is only one video-service state.

Neither these crates nor their type checks produce a host IPA or claim a successful game boot. SDK linking, UIKit lifecycle integration, device GPU/ANE validation and real guest execution are separate gates.

## Verification

On the Linux cloud executor, Rust 1.99 successfully checked all three crates for `aarch64-apple-ios` with `IPHONEOS_DEPLOYMENT_TARGET=26.0`:

```
DOCS_RS=1 CARGO_INCREMENTAL=0 cargo check --offline --manifest-path ios/Cargo.toml \
  -p nx2ipa-ios-metal -p nx2ipa-ios-coreml -p nx2ipa-ios-gpu \
  --target aarch64-apple-ios
```

`DOCS_RS=1` uses the upstream `objc2-exception-helper` build script's supported skip of its Objective-C archive because this executor has no Apple SDK, `xcrun`, or Clang. The Rust implementation is type-checked normally, but this is **not** a link check. The ordinary macOS SDK build must omit this variable and compile/link that helper. No generated source changes or fake framework implementations are used.
