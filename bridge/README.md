# WASM bridge

Fresh adapter to the exact unmodified nxkit source staged by `scripts/source.mjs`.
It does not provide an iOS application host or establish game compatibility.

Exports: `memory`, `nx2ipa_abi_version()` (1), `nx2ipa_alloc(length)`,
`nx2ipa_dealloc(pointer,length)`, `nx2ipa_call(pointer,length)`.
The call result is a u64: output pointer in the high 32 bits, length in the low
32 bits. Inputs and outputs are UTF-8 JSON. The caller frees both allocations
exactly once. Calls are synchronous and intended for a dedicated worker.

Every request has `version:1` and `op`. Binary values are standard padded base64.
Every response has `version:1`, `ok`, and either the result fields or `error`.

- `extract`: `nsp` and `keys` (UTF-8 prod.keys encoded as base64). Returns
  `titleId`, `modules:[{name,data}]`, `npdm`, `files:[{path,data}]`, and metadata.
  This is consistency checking, not signature authentication. Only the supported
  single-application NSP layout is accepted; updates/DLC are not merged.
- `buildRunfolder`: `modules:[{name,data}]`, `npdm`, and `profile`.
  Profile requires `titleId` (hex), `name`, `modules:[{name,buildId}]` in load order.
  Optional fields are `version`, `versionName`, `rules` (patch TOML), `settings`,
  `memory`, `services`, and `nvnFunctions`. Settings/memory explicitly override
  upstream defaults in game.json. The caller supplies a profile appropriate for
  the exact game build; there is no automatic title selection.
- `compileShaders`: `jobs:[{job,code}]`, where `job` is an upstream nxkit shader
  job object and `code` is explicit machine-code bytes. Translates and compiles
  with the portable compiler for iOS. Unsupported inputs fail rather than using
  Apple tools or replacement shaders. Shader discovery and pairing are not inferred.

Build and shader results contain `files:[{path,data}]` using relative runfolder
paths. The dylib declares iOS 26; this is a narrow Mach-O adaptation in this
bridge, not an upstream patch or evidence of native iOS execution. The bridge
also adds a tiny __TEXT,__text marker inside the existing header padding so
zsign can locate room for its signature load command; module offsets stay unchanged. Packaging,
resource placement, provisioning, and signing remain outside the bridge.
