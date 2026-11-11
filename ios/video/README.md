# iOS video boundary

Fresh downstream composition of pinned nxkit service modules. `lib.rs`, `backend.rs`,
`frame.rs`, and `sys.rs` are the only overrides. The assembly script verifies and
symlinks all other modules, including VideoToolbox and Metal texture handling,
without changing upstream bytes.

- VP9: asks VideoToolbox to register its supplemental decoder, then opens a real
  decompression session. The session error is returned if the device cannot decode it.
- AV1: requires hardware decode support. An unsupported device, missing sequence
  header, unsupported format, or session/decode failure returns an error. No software
  fallback is bundled. Both codecs currently require 8-bit 4:2:0 NV12.
- Native pictures retain their CoreVideo buffer and can use the unchanged Metal
  texture cache. Guest memory output checks copy sizes and arithmetic overflow.
- Non-iOS builds have no decoder and return an explicit platform error. They exist
  to run the shared service and memory-frame regression tests.

Cross-target checking does not establish that Apple SDK linkage or physical-device
playback works. Those require the macOS SDK check and real-device codec tests.
