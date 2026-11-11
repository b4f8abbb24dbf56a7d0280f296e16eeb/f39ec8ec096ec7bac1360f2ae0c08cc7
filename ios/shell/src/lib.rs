//! Rust-only UIKit lifecycle boundary for a separately supplied native session.
//! This library is not a guest runtime and cannot produce a playable app alone.
#![deny(unsafe_op_in_unsafe_fn)]
mod paths;
#[cfg(any(target_os = "ios", test))]
mod touch;
pub use paths::Paths;
#[cfg(any(target_os = "ios", test))]
pub use touch::Touch;
#[cfg(target_os = "ios")]
mod ui;
#[cfg(target_os = "ios")]
pub use ui::{Session, SessionFactory, run};
