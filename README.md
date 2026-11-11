# nx2ipa

One self-contained JavaScript library for browsers and Bun, plus an offline HTML page. It uses one thin WASM bridge built from the unmodified, pinned nxkit fork and the npm zsign runtime. No WASM, downloaded source or patch stack is committed.

```js
import { createIpa } from "./nx2ipa.js";
const { ipa, signed } = await createIpa({
  modules: [{ name: "main", data: nsoBytes }],
  npdm: npdmBytes,
  profile: { titleId: "0100000000000000", name: "Example" },
  template: {
    name: "Example.app",
    files: [
      { path: "Info.plist", data: plistBytes },
      { path: "Example", data: hostBytes, executable: true },
    ],
  },
  signing: { identity: p12Bytes, profile: provisioningBytes, password: "..." },
});
```

Inputs are byte arrays. Supply a complete unsigned iOS host template, including its executable. Signing is optional. A single base-application NSP can be supplied as `nsp` with UTF-8 `prod.keys` bytes in `keys` instead of modules/NPDM. Keep a `profile` with at least its display `name`; title ID, version and build IDs are inferred and any supplied values are checked. Updates, DLC merging, NCZ and XCI are not supported. The library accepts up to 256 MiB of binary input; extracted game output is limited to 256 MiB. NSP metadata is consistency-checked, not authenticated as Nintendo-signed content. See the HTML form for explicit shader-job inputs. `AbortSignal` cancellation terminates the worker.

This rewrites supplied game modules, compiles explicit shader jobs, assembles the host bundle, and optionally signs it. It does not supply an iOS host runtime, prove a game is playable, or establish Apple trust or device compatibility.

## Build

Install Bun 1.4.4 and Rust 1.99.0 with `wasm32-unknown-unknown`, then:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run source
bun run build:wasm
bun run build
bun run test
```

CI also tests the same `dist/nx2ipa.js` in Chromium. It publishes JS, offline HTML and a ZIP with licenses and corresponding source as an artifact. Successful main builds publish the package version once as a GitHub release; existing releases and tags are preserved. Tags beginning with `v` can also create a release. Open `dist/nx2ipa.html` directly; no application server is required.
