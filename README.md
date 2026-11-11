# nx2ipa

One self-contained JavaScript library for browsers and Bun, plus a local drag-and-drop HTML page. A thin WASM bridge uses the unmodified, pinned nxkit fork and npm zsign runtime. No WASM, keys, game data or downloaded source is committed.

**The clean fork does not yet provide a functional iOS host runtime.** The default game + keys flow is blocked until that runtime is built and embedded. Development builds expose `capabilities.embeddedHost === false`; production builds refuse to publish without a real host. A structural test host is not a playable application.

```js
import { createIpa, capabilities } from "./nx2ipa.js";
const { ipa, name, signed, warnings } = await createIpa({
  nsp: gameFile, // Browser File/Blob or Uint8Array; use xci for a cartridge dump.
  keys: new Uint8Array(await keysFile.arrayBuffer()),
  // template: { name, files } is available for integration tests/custom hosts.
});
```

Raw input infers the title ID, display name/version, NPDM, module build IDs and standard module load order. Optional `profile` values override metadata, with supplied title ID/numeric version checked against the container. Extracted-module callers can instead supply `modules:[{name,data}]`, `npdm`, `profile` and `resources:[{path,data}]`. Shader jobs remain explicit `shaders:[{job,code}]`; automatic shader discovery is not implemented. The result reports warnings and `deviceValidated:false`.

A single base application with at most one bundled update is accepted from NSP or the XCI secure partition. Update-only inputs, DLC, multi-title packages and NCZ are unsupported. Extraction checks section hashes and metadata consistency, not Nintendo signatures or CNMT content hashes. XCI HFS0 hashes are not authenticated.

Browser workers read File/Blob slices on demand, so container padding does not require a full memory copy. Byte-array inputs and Blob inputs in runtimes without `FileReaderSync` are limited to 256 MiB; extracted game data is also limited to 256 MiB. Rewriting and ZIP packaging still run in memory, so this is not support for arbitrary multi-gigabyte games. `AbortSignal` cancellation terminates the worker.

Unsigned output needs no signing credentials. API callers may optionally supply `signing:{identity,profile,password}` using P12/provisioning bytes. An unsigned or cryptographically signed archive does not establish Apple trust, installation, or gameplay.

Authored encrypted NSP/XCI fixtures exercise the real extraction, rewriting and packaging pipeline in Bun; the same suite is configured for Chromium. Local base-container and bundled-update game diagnostics also completed with a structural test host, without shaders. Neither is a runnable-device test.

## Build

Install Bun 1.4.4 and Rust 1.99.0 with `wasm32-unknown-unknown`, then:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run source
bun run build:wasm
bun scripts/build.mjs --allow-missing-host # integration tests only
bun run test
```

The release build additionally requires a functional built-in iOS runtime at `.build/ios/host.json` and its app folder. Until that is implemented, CI publishes a clearly marked development preview with game conversion disabled. It tests the same JS in Bun and Chromium and links the fresh UIKit/input/audio adapters against the iOS SDK; that probe is not a guest runtime. Main builds update GitHub Pages with the preview HTML, JS, licenses and source. Pull requests only validate. Open `dist/nx2ipa.html` directly for offline use.
