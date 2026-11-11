//! RemoteIO output for iOS. The upstream mixer and guest services remain unchanged.
//! This is not AUHAL and never queries a desktop AudioObject/device.
#![allow(unsafe_code)]

/// The mixer's realtime callback: interleaved stereo 48 kHz float32.
pub type Fill = Box<dyn FnMut(&mut [f32]) + Send>;

fn sample_count(frames: u32, buffers: u32, channels: u32, bytes: u32) -> Option<usize> {
    if buffers != 1 || channels != 2 || bytes % 4 != 0 {
        return None;
    }
    let samples = usize::try_from(frames).ok()?.checked_mul(2)?;
    (samples <= bytes as usize / 4).then_some(samples)
}

#[cfg(target_os = "ios")]
mod device {
    use super::{Fill, sample_count};
    use objc2_audio_toolbox::{
        AudioComponentDescription, AudioComponentFindNext, AudioComponentInstance,
        AudioComponentInstanceDispose, AudioComponentInstanceNew, AudioOutputUnitStart,
        AudioOutputUnitStop, AudioUnitInitialize, AudioUnitRenderActionFlags, AudioUnitSetProperty,
        AudioUnitUninitialize,
    };
    use objc2_avf_audio::{AVAudioSession, AVAudioSessionCategoryPlayback};
    use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
    use std::ffi::c_void;
    use std::ptr::NonNull;

    struct Callback {
        fill: Fill,
    }
    #[repr(C)]
    struct RenderCallback {
        proc_: unsafe extern "C-unwind" fn(
            NonNull<c_void>,
            NonNull<AudioUnitRenderActionFlags>,
            NonNull<AudioTimeStamp>,
            u32,
            u32,
            *mut AudioBufferList,
        ) -> i32,
        refcon: *mut c_void,
    }

    /// Owns a RemoteIO instance and its callback; no borrowed callback can escape.
    pub struct Output {
        unit: AudioComponentInstance,
        callback: NonNull<Callback>,
    }
    // SAFETY: AudioUnit operations happen through one owner. The callback's Fill
    // is touched only by the serialized RemoteIO render thread until Stop/Dispose.
    unsafe impl Send for Output {}
    // SAFETY: shared access exposes only join_status(), which reads no raw state.
    unsafe impl Sync for Output {}

    fn checked(operation: &str, status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!("RemoteIO {operation}: OSStatus {status}"))
        }
    }

    unsafe extern "C-unwind" fn render(
        context: NonNull<c_void>,
        _flags: NonNull<AudioUnitRenderActionFlags>,
        _time: NonNull<AudioTimeStamp>,
        _bus: u32,
        frames: u32,
        data: *mut AudioBufferList,
    ) -> i32 {
        let Some(data) = NonNull::new(data) else {
            return -50;
        };
        // SAFETY: AudioUnit supplies the live buffer list for this callback only.
        let list = unsafe { data.as_ref() };
        if list.mNumberBuffers != 1 {
            return -50;
        }
        let buffer = &list.mBuffers[0];
        let Some(samples) = sample_count(
            frames,
            list.mNumberBuffers,
            buffer.mNumberChannels,
            buffer.mDataByteSize,
        ) else {
            return -50;
        };
        if samples == 0 {
            return 0;
        }
        if buffer.mData.is_null() || (buffer.mData as usize) % align_of::<f32>() != 0 {
            return -50;
        }
        // SAFETY: checked size/alignment is inside the AudioUnit-owned output buffer.
        let output = unsafe { std::slice::from_raw_parts_mut(buffer.mData.cast::<f32>(), samples) };
        // SAFETY: the callback Box remains alive until this unit has been disposed,
        // and RemoteIO does not invoke two renders for one unit simultaneously.
        let state = unsafe { &mut *context.as_ptr().cast::<Callback>() };
        (state.fill)(output);
        0
    }

    impl Output {
        /// Configure playback without microphone permission, then start RemoteIO.
        pub fn start(fill: Fill) -> Result<Self, String> {
            // SAFETY: playback uses the process's own AVAudioSession. Each checked
            // API receives a valid string/scalar and returns a retained NSError.
            unsafe {
                let session = AVAudioSession::sharedInstance();
                session
                    .setCategory_error(AVAudioSessionCategoryPlayback)
                    .map_err(|e| e.to_string())?;
                session
                    .setPreferredSampleRate_error(48_000.0)
                    .map_err(|e| e.to_string())?;
                session.setActive_error(true).map_err(|e| e.to_string())?;
            }
            let description = AudioComponentDescription {
                componentType: u32::from_be_bytes(*b"auou"),
                componentSubType: u32::from_be_bytes(*b"rioc"),
                componentManufacturer: u32::from_be_bytes(*b"appl"),
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            // SAFETY: null starts the search; description lives for the call.
            let component = unsafe { AudioComponentFindNext(std::ptr::null_mut(), &description) };
            if component.is_null() {
                return Err("No RemoteIO output component".into());
            }
            let mut unit: AudioComponentInstance = std::ptr::null_mut();
            // SAFETY: component is valid and unit receives the owned instance.
            checked("create", unsafe {
                AudioComponentInstanceNew(component, &mut unit)
            })?;
            if unit.is_null() {
                return Err("RemoteIO returned a null unit".into());
            }
            let callback = NonNull::from(Box::leak(Box::new(Callback { fill })));
            let output = Self { unit, callback };
            let format = AudioStreamBasicDescription {
                mSampleRate: 48_000.0,
                mFormatID: u32::from_be_bytes(*b"lpcm"),
                mFormatFlags: 1 | 8,
                mBytesPerPacket: 8,
                mFramesPerPacket: 1,
                mBytesPerFrame: 8,
                mChannelsPerFrame: 2,
                mBitsPerChannel: 32,
                mReserved: 0,
            };
            let render = RenderCallback {
                proc_: render,
                refcon: callback.as_ptr().cast(),
            };
            // SAFETY: pointers reference complete property values for each call.
            // Bus 0 input scope is the format supplied by the application to output.
            unsafe {
                checked(
                    "format",
                    AudioUnitSetProperty(
                        unit,
                        8,
                        1,
                        0,
                        (&format as *const AudioStreamBasicDescription).cast(),
                        size_of::<AudioStreamBasicDescription>() as u32,
                    ),
                )?;
                checked(
                    "render callback",
                    AudioUnitSetProperty(
                        unit,
                        23,
                        1,
                        0,
                        (&render as *const RenderCallback).cast(),
                        size_of::<RenderCallback>() as u32,
                    ),
                )?;
                checked("initialize", AudioUnitInitialize(unit))?;
                checked("start", AudioOutputUnitStart(unit))?;
            }
            Ok(output)
        }

        /// This adapter does not join an audio workgroup. None never means success.
        pub fn join_status(&self) -> Option<i32> {
            None
        }
    }

    impl Drop for Output {
        fn drop(&mut self) {
            // SAFETY: this is the uniquely owned unit. Disposal ends all callbacks
            // before the Box is released. If disposal fails, leak instead of UAF.
            unsafe {
                let _ = AudioOutputUnitStop(self.unit);
                let _ = AudioUnitUninitialize(self.unit);
                if AudioComponentInstanceDispose(self.unit) == 0 {
                    drop(Box::from_raw(self.callback.as_ptr()));
                }
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod device {
    use super::Fill;
    /// Portable tests have no iOS audio device.
    pub struct Output;
    impl Output {
        pub fn start(_: Fill) -> Result<Self, String> {
            Err("RemoteIO requires iOS".into())
        }
        pub fn join_status(&self) -> Option<i32> {
            None
        }
    }
}
pub use device::Output;

#[cfg(test)]
mod tests {
    use super::sample_count;
    #[test]
    fn stereo_frame_bounds() {
        assert_eq!(sample_count(128, 1, 2, 1024), Some(256));
        assert_eq!(sample_count(128, 1, 2, 512), None);
        assert_eq!(sample_count(128, 2, 1, 1024), None);
        assert_eq!(sample_count(128, 1, 2, 1023), None);
        assert_eq!(sample_count(u32::MAX, 1, 2, u32::MAX), None);
    }
}
