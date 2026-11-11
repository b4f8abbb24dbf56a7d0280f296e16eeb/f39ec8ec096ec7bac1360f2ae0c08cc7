# nx2ipa

One self-contained JavaScript library for browsers and Bun, plus a local drag-and-drop HTML page. A thin WASM bridge uses the unmodified, pinned nxkit fork and npm zsign runtime. No WASM, keys, game data or downloaded source is committed.

**Experimental:** drop one NSP/XCI and `prod.keys` to create an IPA locally. The optional **Sign this IPA locally** section accepts your own P12/PFX signing identity, matching `.mobileprovision` profile and certificate password. Leave signing off to create an unsigned IPA. The real iOS 26 native runtime is included automatically; no host, game profile or shader upload is required. Valid Apple signing/provisioning is still required before installation. SDK linking, package validation and synthetic signing have passed, but actual device installation, rendering, audio and gameplay remain unverified. `capabilities.experimental` and `deviceValidated:false` keep that distinction explicit.

```js
import { createIpa, capabilities } from "./nx2ipa.js";
const { ipa, name, signed, warnings } = await createIpa({
  nsp: gameFile, // Browser File/Blob or Uint8Array; use xci for a cartridge dump.
  keys: new Uint8Array(await keysFile.arrayBuffer()),
  // template: { name, files } is available for integration tests/custom hosts.
});
```

Raw input infers the title ID, display name/version, NPDM, module build IDs and standard module load order. Optional `profile` values override metadata, with supplied title ID/numeric version checked against the container. Extracted-module callers can instead supply `modules:[{name,data}]`, `npdm`, `profile` and `resources:[{path,data}]`. Shaders are discovered automatically in NSO modules and supported RomFS containers using nxkit’s unchanged readers. Compute threadgroup facts, shader keys, vertex/fragment pairs, reflection and iOS Metal libraries are generated locally. Advanced callers may override discovery with explicit `shaders:[{job,code}]`. The result reports `shaderCount`, warnings and `deviceValidated:false`.

Discovery includes nxkit’s BNSH/BAHS, compressed and archive readers, zstd dictionaries and Unity type-tree second pass. Unknown formats may contain shaders the readers cannot find; a zero count produces a warning. Recognized malformed or unsupported shaders fail conversion, rather than silently leaving out a failed shader. Title-specific graphics query facts are not inferred, and the portable compiler has no Apple compiler fallback or device validation. Discovery does not establish gameplay compatibility.

A single base application with at most one bundled update is accepted from NSP or the XCI secure partition. Update-only inputs, DLC, multi-title packages and NCZ are unsupported. Extraction checks section hashes and metadata consistency, not Nintendo signatures or CNMT content hashes. XCI HFS0 hashes are not authenticated.

Browser workers read File/Blob slices on demand, so container padding does not require a full memory copy. Byte-array inputs and Blob inputs in runtimes without `FileReaderSync` are limited to 256 MiB; extracted game data is also limited to 256 MiB. Rewriting and ZIP packaging still run in memory, so this is not support for arbitrary multi-gigabyte games. `AbortSignal` cancellation terminates the worker.

Unsigned output needs no signing credentials. The page signs entirely in its local worker and clears credential fields on submission, then releases its credential buffers after success, failure or cancellation. It does not upload or save them. Each signing file must be nonempty and under 4 MiB. A signing failure does not produce an unsigned fallback. API callers may optionally supply `signing:{identity,profile,password}` using P12/provisioning bytes. An unsigned or cryptographically signed archive does not establish Apple trust, installation, or gameplay.

The generic runtime uses a 4 GiB virtual reserve and 3 GiB application budget, not a promise of available device RAM. Its Metal backend requires roughly a 3.8 GiB single-buffer limit; smaller `maxBufferLength` devices will reject startup. Actual dyld placement, memory limits and title-specific compatibility still need device evidence.

Authored encrypted NSP/XCI fixtures exercise extraction, automatic shader discovery/compilation, rewriting and packaging in Bun; the same suite is configured for Chromium. Local base-container and bundled-update game diagnostics also completed with a structural test host, without shaders. Neither is a runnable-device test.

## Build

Install Bun 1.4.4 and Rust 1.99.0 with `wasm32-unknown-unknown`, then:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run source
bun run build:wasm
bun scripts/build.mjs --allow-missing-host # integration tests only
bun run test
```

CI builds the WASM on Linux, builds the actual unsigned host against the iOS SDK, and checks authored NSP packaging, synthetic host/guest signing and the native bundle reader. It then embeds that exact host using `--experimental-host`, tests the final JS in Bun and Chromium (including NSP/XCI drag-and-drop and synthetic signed output from the actual page), and publishes the successful HTML/JS to GitHub Pages. Pull requests only validate. The experimental release keeps `runtimeReady`, device and gameplay flags false; it never invents signing credentials. Both exact source archives, dependency notices and validation receipts accompany the release. Open `dist/nx2ipa.html` directly for offline use.

## Native app shell

The iOS app shell is Swift/UIKit. It owns the window, scene lifecycle, Metal view
and touch input, and calls the existing Rust nxkit runtime through a small C ABI.
CI builds the runtime static library, runs portable Rust/Swift checks, and links
the Swift executable with the iPhoneOS SDK. See [ios/README.md](ios/README.md).
This does not establish installation, guest boot or gameplay on a physical device.
