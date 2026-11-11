//! iOS composition of the pinned nxkit video service.
//! VideoToolbox supplies VP9 and hardware AV1 in 8-bit NV12; unsupported codecs return errors.
mod av1;
mod backend;
mod codec;
mod codec_exports;
mod decoder;
mod exports;
mod frame;
mod guest_api;
mod pacing;
mod picture;
mod planar;
#[cfg(target_os = "ios")]
mod sys;
#[cfg(target_os = "ios")]
pub mod texture;
mod vp9;
mod yuv;
pub use codec::{NativeImage, native_image, native_image_blank, native_image_blank_free};
pub use frame::{Frame, Nv12};
use nxkit_abi::{export::Export, ipc::Named};
pub use pacing::playing as movie_playing;
pub use picture::{PictureSink, set_picture_sink};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;
/// Guest services required by movie decoding.
pub trait Host: Send + Sync {
    fn resolve(&self, symbol: &str) -> Option<usize>;
    fn run_on_guest_thread(&self, delay: Duration, job: Box<dyn FnOnce() + Send>);
    fn bind_system_event(&self, event: u64);
    fn signal_system_event(&self, event: u64);
    fn clear_system_event(&self, event: u64);
}
/// Transfers a decoded image to a guest texture and signals completion.
pub trait TextureSink: Send + Sync {
    fn present(&self, texture: u64, frame: &Frame) -> Result<(), String>;
    fn signal_sync(&self, sync: u64) -> Result<(), String>;
}
#[derive(Clone)]
pub struct Config {
    pub host: Arc<dyn Host>,
    pub sink: Option<Arc<dyn TextureSink>>,
}
static SETTINGS: RwLock<Option<Config>> = RwLock::new(None);
static WRITE_HOOK: OnceLock<fn(u64, u64)> = OnceLock::new();
pub fn init(settings: &Config) {
    *SETTINGS.write().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
}
pub(crate) fn config() -> Option<Config> {
    SETTINGS.read().unwrap_or_else(|e| e.into_inner()).clone()
}
pub fn set_guest_write_hook(hook: fn(u64, u64)) {
    let _ = WRITE_HOOK.set(hook);
}
pub(crate) fn guest_wrote(address: u64, length: u64) {
    if let Some(hook) = WRITE_HOOK.get() {
        hook(address, length);
    }
}
pub fn exports() -> Vec<Export> {
    exports::table()
        .into_iter()
        .chain(codec_exports::table())
        .collect()
}
pub fn big_stack_exports() -> Vec<Export> {
    Vec::new()
}
pub fn services() -> Vec<Named> {
    Vec::new()
}
