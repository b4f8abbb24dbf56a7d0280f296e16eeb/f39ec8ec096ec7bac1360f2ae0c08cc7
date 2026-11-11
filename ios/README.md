# Fresh Rust iOS boundary

This directory is new nx2ipa code. It does **not** contain the old host or its
patch stack. The pinned `.build/nxkit` checkout is never rewritten.

Implemented and iOS-arm64 type-checked:

- Rust UIKit scene lifecycle, CAMetalLayer sizing, explicit session ownership,
  startup error display, and separate writable save/cache paths.
- A thin input crate selecting the existing GameController/Core Haptics backend.
- A fresh RemoteIO output module selecting 48 kHz stereo float output. The mixer,
  audio services, controller logic and haptics remain upstream modules.

`bun scripts/build-ios.mjs --prepare` assembles separate input/audio module trees
under `.build/ios`. Every reused file is verified against the pinned Git blob
before linking it. Only `ios/input/platform.rs` and `ios/audio/output.rs` replace
platform-boundary modules in those **separate** trees. Their manifests record
all source hashes. No generated text substitutions or source patches are used.
The 48 reused source modules retain their upstream license.

`bun scripts/build-ios.mjs --check` type-checks the complete adapter workspace
for `aarch64-apple-ios`, then runs its portable tests. Rust 1.99 and the iOS target
standard library are required. On a Mac with Xcode,
`bun scripts/build-ios.mjs --link-check` builds the explicitly named `link_probe`
example and checks that it is an arm64 iOS binary without AppKit. That example
contains **no game runtime**, is not a template, and is never embedded by release.

## Still required for NSP/XCI + keys -> runnable IPA

The upstream host crate gates its loader/startup on macOS. Its GPU, Metal and
Core ML crate roots also exclude iOS. Building a UIKit front end cannot remove
those constraints. A real native session must still supply:

1. An iOS loader/kernel/gate startup using dyld-accepted signed code, with no
   executable-file fallback and no writes to the signed application bundle.
2. Downstream Metal/GPU/video adapters that compile unchanged shared modules and
   replace only platform boundaries. Desktop display mode APIs are not iOS APIs.
3. Writable save/temp/cache routing, app suspension/resume, audio-session
   interruption/route recovery, touch/controller integration and safe shutdown.
4. A real iPhoneOS SDK link, provisioning/signing checks, and device execution.
   Compilation or packaging alone is not gameplay evidence.

The shell's `SessionFactory` is the integration point. It has no fake default
implementation. The default build refuses to create a host, and the adapter
checks never write `.build/ios/host.json` or set `runtimeReady: true`.

## Current evidence

The input/audio/shell workspace passed Rust 1.99 `aarch64-apple-ios` type-check
on 2026-11-11. Its 116 portable tests passed: 109 input, 5 audio and 2 path tests.
That is not device evidence. The iPhoneOS SDK link probe and device execution
remain separate checks.
