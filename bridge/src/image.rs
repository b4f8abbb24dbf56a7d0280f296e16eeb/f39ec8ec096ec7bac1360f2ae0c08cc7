//! Source adapters for the pinned nxkit standalone build.

#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/bundle.rs"]
pub(crate) mod bundle;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/elf.rs"]
pub(crate) mod elf;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/layout.rs"]
pub(crate) mod layout;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/link.rs"]
pub(crate) mod link;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/macho.rs"]
pub(crate) mod macho;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/manifest.rs"]
pub(crate) mod manifest;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/modules.rs"]
pub(crate) mod modules;
#[allow(dead_code)]
#[path = "../../.build/nxkit/crates/nxb-build/src/standalone/npdm.rs"]
pub(crate) mod npdm;

pub(crate) use link::dylib;
pub(crate) use modules::rewrite_with_loader;
