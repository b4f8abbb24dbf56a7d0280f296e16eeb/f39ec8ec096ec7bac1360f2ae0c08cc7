# Third-party notices

- **nxkit:** GPL-3.0-only, fetched at the exact commit/tree in `nxkit.json`. The bridge uses its existing byte-based APIs without applying patches. The release includes the complete unmodified upstream source, new bridge/library/build sources, and upstream license/notices. The bridge adapts generated Mach-O headers for iOS packaging; it does not add a native application runtime.
- **fflate 0.8.2:** MIT, used for ZIP packaging. Its license accompanies the release.
- **jpeg-js 0.4.4:** BSD-3-Clause package, used to decode extracted game artwork locally for iOS app icons. Its decoder is Copyright 2011 notmasteryet, licensed under Apache-2.0. Both license texts and the unmodified decoder source/header accompany the release.
- **zsign-wasm 0.0.4:** npm package pinned in `bun.lock`, shipped MIT license copyright 2023 DeepSeek. Its Emscripten glue is bundled for Web Workers. The npm binary links OpenSSL, but its precise OpenSSL build and missing upstream notice bundle have not been established. Do not treat this as a complete third-party license audit or substitute another source recipe's provenance.

- **Basecoat CSS 1.1.0:** MIT, used for the static page's accessible UI components. Its standalone stylesheet is embedded at build time, with no runtime CDN request. Its license accompanies the release.

Redistribute the release's corresponding source and notices with its JS/HTML/WASM. Generated IPAs can have separate rights and distribution requirements.

- **NX2Apple / nxnative overlay:** MIT, copyright 2026 seedds, jhaizhou, LNPANDY and NX2Apple contributors. `ios/shell/overlay` adapts NX2Apple's actual single-game virtual controls and geometry, and `ios/shell/GameMenu.swift` adapts its native menu. Exact upstream revisions and source hashes are in `ios/shell/overlay/SOURCE.json`, with the full license in `ios/shell/overlay/LICENSE`. Native test apps and generated apps retain these notices in `ThirdPartyNotices`; the corresponding source archive includes all adaptations and tests. nxkit remains GPL-3.0-only.
