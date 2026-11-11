//! UIKit-owned CAMetalLayer presentation. iOS always synchronizes to the display.
use crate::{
    device::Context,
    encode::CommandBuffer,
    error::{MetalError, Result},
    format::Format,
    frame::{Frame, PendingPresent},
    texture::{Storage, Texture, TextureDesc},
};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_core_foundation::CGSize;
use objc2_metal::{MTLDrawable, MTLPixelFormat, MTLTexture};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use std::{
    ffi::c_void,
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
};

/// Format of the UIKit layer's drawable textures.
pub const PRESENT_FORMAT: Format = Format::Bgra8Unorm;
static MIN_STAY_US: AtomicU64 = AtomicU64::new(0);
/// Requests a minimum display duration. A display-link refusal disables it upstream.
pub fn set_timed_present(seconds: Option<f64>) {
    MIN_STAY_US.store(
        seconds
            .filter(|s| s.is_finite() && *s > 0.0)
            .map_or(0, |s| (s * 1e6).round() as u64),
        Ordering::Relaxed,
    );
}
/// Configured minimum display duration, in seconds.
pub fn timed_present() -> Option<f64> {
    let us = MIN_STAY_US.load(Ordering::Relaxed);
    (us != 0).then_some(us as f64 / 1e6)
}
unsafe extern "C" {
    fn CACurrentMediaTime() -> f64;
}
/// QuartzCore's monotonic presentation clock, in seconds.
pub fn media_time() -> f64 {
    // SAFETY: this clock has no preconditions; QuartzCore is a linked dependency.
    unsafe { CACurrentMediaTime() }
}
/// An owned drawable. Its texture stays alive until submitted GPU work completes.
pub struct Drawable {
    texture: Texture,
    raw: Retained<ProtocolObject<dyn CAMetalDrawable>>,
}
impl Drawable {
    /// Registers a completion callback before presentation. Zero means not displayed.
    pub fn on_presented(&self, f: impl Fn(f64) + Send + Sync + 'static) {
        type Handler =
            RcBlock<'static, fn(NonNull<ProtocolObject<dyn MTLDrawable>>), dyn Send + Sync>;
        let handler: Handler = RcBlock::new(move |d: NonNull<ProtocolObject<dyn MTLDrawable>>| {
            // SAFETY: Metal keeps the callback's drawable alive during the invocation.
            f(unsafe { d.as_ref() }.presentedTime());
        });
        self.raw.addPresentedHandler(&handler);
    }
    pub(crate) fn wrap(ctx: &Context, raw: Retained<ProtocolObject<dyn CAMetalDrawable>>) -> Self {
        let texture = raw.texture();
        let mut desc = TextureDesc::render_target_2d(
            texture.width() as u32,
            texture.height() as u32,
            PRESENT_FORMAT,
        );
        desc.shader_read = false;
        desc.storage = Storage::Private;
        Self {
            texture: Texture::wrap_external(ctx, texture, desc),
            raw,
        }
    }
    /// Render target for this drawable.
    pub fn texture(&self) -> &Texture {
        &self.texture
    }
}
/// A retained UIKit-owned Metal layer and its device.
pub struct Presenter {
    layer: Retained<CAMetalLayer>,
    ctx: Context,
}
impl Presenter {
    /// Configures and retains the layer supplied by the UIKit host.
    ///
    /// # Safety
    /// `layer` must identify a live CAMetalLayer. Call on the main thread while UIKit
    /// is not concurrently modifying the layer. The caller owns view attachment.
    pub unsafe fn from_raw_layer(ctx: &Context, layer: NonNull<c_void>) -> Result<Self> {
        // SAFETY: guaranteed by the caller; retaining gives the presenter ownership.
        let layer = unsafe { Retained::retain(layer.cast::<CAMetalLayer>().as_ptr()) }
            .ok_or(MetalError::Invalid("null layer"))?;
        Ok(Self::setup(ctx, layer))
    }
    /// Creates an unattached layer. Drawable acquisition can fail until attached.
    pub fn offscreen(ctx: &Context, width: u32, height: u32) -> Self {
        let presenter = Self::setup(ctx, CAMetalLayer::new());
        presenter.resize(width, height);
        presenter
    }
    fn setup(ctx: &Context, layer: Retained<CAMetalLayer>) -> Self {
        layer.setDevice(Some(ctx.device()));
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        layer.setFramebufferOnly(true);
        layer.setMaximumDrawableCount(3);
        ctx.add_layer_residency(&layer.residencySet());
        Self {
            layer,
            ctx: ctx.clone(),
        }
    }
    /// Updates drawable pixel dimensions. Call on the UIKit main thread.
    pub fn resize(&self, width: u32, height: u32) {
        self.layer.setDrawableSize(CGSize {
            width: width.into(),
            height: height.into(),
        });
    }
    /// Validates display-sync requests. iOS does not expose disabling display sync.
    pub fn set_display_sync(&self, on: bool) -> Result<()> {
        if on {
            Ok(())
        } else {
            Err(MetalError::Invalid(
                "iOS cannot disable display synchronization",
            ))
        }
    }
    /// Acquires the next available layer drawable, possibly blocking.
    pub fn acquire(&self) -> Result<Drawable> {
        self.layer
            .nextDrawable()
            .map(|d| Drawable::wrap(&self.ctx, d))
            .ok_or(MetalError::Invalid("the iOS layer gave no drawable"))
    }
    pub(crate) fn layer(&self) -> &CAMetalLayer {
        &self.layer
    }
    pub(crate) fn context(&self) -> &Context {
        &self.ctx
    }
}
impl Frame {
    /// Enqueues presentation when this frame is submitted.
    pub fn present(&mut self, drawable: Drawable) {
        self.set_present(PendingPresent {
            drawable: ProtocolObject::from_retained(drawable.raw),
            keep: Box::new(drawable.texture),
            at: None,
        });
    }
    /// Enqueues presentation at the first display refresh at or after `at`.
    pub fn present_at(&mut self, drawable: Drawable, at: f64) {
        self.set_present(PendingPresent {
            drawable: ProtocolObject::from_retained(drawable.raw),
            keep: Box::new(drawable.texture),
            at: Some(at),
        });
    }
}
impl CommandBuffer {
    /// Keeps the drawable texture resident until this command buffer finishes.
    pub fn retain_drawable(&mut self, drawable: &Drawable) {
        self.retain(drawable.texture.clone());
    }
}
