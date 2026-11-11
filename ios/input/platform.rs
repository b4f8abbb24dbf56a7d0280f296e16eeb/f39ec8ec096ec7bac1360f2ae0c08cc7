//! iOS composition: unchanged Apple controllers plus a virtual player-one pad.
//! Physical slots, haptics, motion, keyboard and mouse remain upstream-owned.
#[cfg(target_os = "ios")]
#[allow(unsafe_code)]
mod apple;
#[cfg(target_os = "ios")]
#[allow(unsafe_code)]
mod haptics;
#[cfg(target_os = "ios")]
use apple::Platform as Physical;
#[cfg(not(target_os = "ios"))]
mod stub;
#[cfg(not(target_os = "ios"))]
use stub::Platform as Physical;
pub(crate) mod virtual_pad;

use crate::{config::Config, keys::KeySet, npad::RawPad, rumble::PlayerLevels, slots::Slots};

pub(crate) struct Platform(Physical);
impl Platform {
    pub(crate) fn new(config: &Config) -> Self {
        Self(Physical::new(config))
    }
    pub(crate) fn refresh(&mut self, slots: &mut Slots) {
        // Do not reserve a synthetic slot: physical connect/disconnect and the
        // upstream single-player/controller assignment rules must stay intact.
        self.0.refresh(slots);
    }
    pub(crate) fn read_pad(&self, slot: usize) -> Option<RawPad> {
        virtual_pad::merge_player(slot, self.0.read_pad(slot), virtual_pad::snapshot())
    }
    pub(crate) fn read_motion(&self, slot: usize) -> Option<([f32; 3], [f32; 3])> {
        self.0.read_motion(slot)
    }
    pub(crate) fn read_keys(&self) -> Option<KeySet> {
        self.0.read_keys()
    }
    pub(crate) fn read_mouse(&self) -> Option<u32> {
        self.0.read_mouse()
    }
    pub(crate) fn rumble(&mut self, slot: usize, levels: &PlayerLevels) {
        self.0.rumble(slot, levels);
    }
}
