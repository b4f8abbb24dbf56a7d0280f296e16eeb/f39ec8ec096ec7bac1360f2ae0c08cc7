# WASM bridge

Fresh adapter to the exact unmodified nxkit source staged by `scripts/source.mjs`.
It does not provide an iOS application host or establish game compatibility.

Image construction compiles the pinned `nxb-build` standalone source modules directly.
Native and browser builds use the same rewrite, layout, manifest and Mach-O code.
The bridge calls the loader-based rewrite helper and byte writers, not the included
filesystem or native-signing helpers. Update the paths in `src/image.rs` if these
internal modules move upstream.

Exports: `memory`, `nx2ipa_abi_version()` (2), `nx2ipa_alloc(length)`,
`nx2ipa_dealloc(pointer,length)`, `nx2ipa_call(pointer,length)`.
The call result is a u64: output pointer in the high 32 bits, length in the low
32 bits. Inputs and outputs are UTF-8 JSON. The caller frees both allocations
exactly once. Calls are synchronous and intended for a dedicated worker. The WASM import
`nx2ipa.read(source:i32,offset:i64,destination:i32,length:i32)->i32` copies a local container
range into WASM memory (source 0 for base, 1 for update; zero on success). No file bytes are sent over a network.

ABI 2 adds the source index to the read import; the JSON protocol remains version 1.
Every request has `version:1` and `op`. Binary values are standard padded base64.
Every response has `version:1`, `ok`, and either the result fields or `error`.

- `extract`: `sourceSize` for imported random-access reads (or base64 `nsp`/`xci`)
  with optional `updateSize` (or base64 `update`),
  and `keys` (UTF-8 prod.keys encoded as base64). Returns
  `titleId`, `modules:[{name,data}]`, `npdm`, `files:[{path,data}]`, and metadata.
  This is consistency checking, not signature authentication. Only the supported
  single-application NSP/XCI layout is accepted, optionally with one bundled
  matching update, or a separate matching update-only NSP/XCI. Update-only conversion, DLC and multi-title inputs are rejected. Control
  NACP/icon bytes accompany the extracted files for automatic metadata inference.
- `buildRunfolder`: `modules:[{name,data}]`, `npdm`, and `profile`.
  Profile requires `titleId` (hex), `name`, `modules:[{name,buildId}]` in load order.
  Optional fields are `version`, `versionName`, `rules` (patch TOML), `settings`,
  `memory`, `services`, and `nvnFunctions`. Settings/memory explicitly override
  upstream defaults in game.json. The JS adapter infers standard module order and IDs for raw containers;
  title-specific settings/patch rules are not guessed.
- `discoverShaders`: `modules:[{name,data}]` and `files:[{path,data}]` (RomFS-relative
  paths). Runs the unchanged nxkit module, file and archive readers, Unity second
  pass, shader deduplication, compute fact inference and stage pairing, then
  compiles to iOS. Returns `count`, `warnings` and `files`, including shader tables.
  Fragment inputs are available before their vertex/mesh partners translate.
  Graphics queries use upstream defaults where no inferred facts exist.
- `compileShaders`: `jobs:[{job,code}]`, where `job` is an upstream nxkit shader
  job object and `code` is explicit machine-code bytes. Translates and compiles
  with the portable compiler for iOS. Unsupported inputs fail rather than using
  Apple tools or replacement shaders. Explicit jobs override automatic discovery
  and do not infer pairing. Returns `count`, `warnings` and `files`. Both paths
  split fragment alpha/logic entries into the `_bx.metallib` expected by the host.

Build and shader results contain `files:[{path,data}]` using relative runfolder
paths. The dylib declares iOS 26; this is a narrow Mach-O adaptation in this
bridge, not an upstream patch or evidence of native iOS execution. The bridge
also adds a tiny __TEXT,__text marker inside the existing header padding so
zsign can locate room for its signature load command; module offsets stay unchanged. Packaging,
resource placement, provisioning, and signing remain outside the bridge.
