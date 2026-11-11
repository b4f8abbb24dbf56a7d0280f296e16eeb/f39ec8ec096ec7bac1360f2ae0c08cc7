//! iOS composition of unchanged nxkit guest audio services and mixer.
mod engine;
mod host;
mod ipc_out;
mod ipc_ren;
mod ren_cmd;
mod ren_run;
mod ren_scan;
mod ren_state;
mod ren_work;
mod sdk_dev;
mod sdk_out;
mod sdk_ren;
mod sdk_stream;
mod sys;
mod util;

pub use host::{Host, set_host};
use nxkit_abi::{export::Export, ipc::Named};
use std::sync::Arc;

/// Settings supplied before starting the guest.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub master_volume: f32,
    pub silent_sink: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            master_volume: 1.0,
            silent_sink: false,
        }
    }
}
pub fn init(cfg: &Config) {
    engine::mixer().configure(cfg.master_volume, cfg.silent_sink);
}

/// Set foreground playback intent, including before the mixer opens its output.
pub fn set_active(active: bool) -> Result<(), String> {
    sys::au::set_active(active)
}
/// Forward interruption begin/end independently of UIKit focus. Clear only when
/// the interruption-end notification permits resumption.
pub fn set_interrupted(interrupted: bool) -> Result<(), String> {
    sys::au::set_interrupted(interrupted)
}
/// Restart after a route change, preserving focus and interruption state.
pub fn route_changed() -> Result<(), String> {
    sys::au::route_changed()
}

fn lists() -> (Vec<Export>, Vec<Export>) {
    let (mut normal, mut large) = (Vec::new(), Vec::new());
    sdk_out::exports(&mut normal, &mut large);
    sdk_stream::exports(&mut normal, &mut large);
    sdk_dev::exports(&mut normal);
    sdk_ren::exports(&mut normal);
    (normal, large)
}
pub fn exports() -> Vec<Export> {
    lists().0
}
pub fn big_stack_exports() -> Vec<Export> {
    lists().1
}
pub fn services() -> Vec<Named> {
    vec![
        Named {
            name: "audout:u",
            root: Arc::new(ipc_out::AudioOutManager),
        },
        Named {
            name: "audren:u",
            root: Arc::new(ipc_ren::AudioRendererManager),
        },
    ]
}
