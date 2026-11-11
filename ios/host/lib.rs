//! Fresh iOS host composition. Shared modules are verified, unchanged nxkit sources.
pub mod api;
pub mod bundle;
pub mod error;
pub mod gates;
pub mod image;
pub mod input_file;
pub mod json;
pub mod layout;
pub mod macho;
pub mod manifest;
pub mod module;
pub mod npdm;
mod padding;
pub mod pipecache;
pub mod reloc;
pub mod settings;
pub mod stop;

#[cfg(target_os = "ios")]
pub mod bigstack;
#[cfg(target_os = "ios")]
pub mod boot;
#[cfg(target_os = "ios")]
pub mod frames;
#[cfg(target_os = "ios")]
pub mod gate;
#[cfg(target_os = "ios")]
pub mod guestsym;
#[cfg(target_os = "ios")]
pub mod loader;
#[cfg(target_os = "ios")]
pub mod memory;
#[cfg(target_os = "ios")]
pub mod memreport;
#[cfg(target_os = "ios")]
pub mod place;
#[cfg(target_os = "ios")]
pub mod refresh;
#[cfg(target_os = "ios")]
pub mod seams;
#[cfg(target_os = "ios")]
pub mod session;
#[cfg(target_os = "ios")]
pub mod sys;
#[cfg(target_os = "ios")]
pub mod thread;
#[cfg(target_os = "ios")]
pub mod wire;

pub use error::{HostError, Result};
pub use manifest::Game;
