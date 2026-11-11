//! iOS Metal 4 composition. Shared modules are verified against the upstream pin.
//!
//! Desktop display-mode switching is deliberately not part of this API. UIKit owns
//! the display; CAMetalDisplayLink requests frame pacing without changing its mode.
#![cfg(target_os = "ios")]
mod address;
mod barrier;
mod batch;
mod blocklinear;
mod compute;
mod compute_copy;
mod compute_icb;
mod databuf;
mod deswizzle;
mod device;
mod encode;
mod error;
mod format;
mod frame;
mod guest;
mod icb;
mod interpolate;
mod memstats;
mod metrics;
mod pacing;
mod pipeline;
mod policy;
mod present;
mod render;
mod resample;
mod residency;
mod sampler;
mod scale;
mod schedule;
mod scratch;
mod state;
mod stats;
mod table;
mod texture;
pub mod thread;
mod timestamp;
mod upscale;
mod vmregion;
pub use address::AddressMap;
pub use barrier::{Dependency, Scope, Stages, Use, Visibility};
pub use batch::{
    BATCH_SCRATCH_BYTES, BATCH_SCRATCH_MAX_BYTES, BATCHES_IN_FLIGHT, Batch, BatchRing,
    SubmittedBatch,
};
pub use blocklinear::{GobOrder, LevelLayout, SurfaceLayout};
pub use compute::{ComputeCommand, ComputePass};
pub use compute_icb::{
    ComputeIcbCommand, ComputeIcbDesc, ComputeIndirectCommandBuffer, ExecutionRange,
};
pub use databuf::DataBuffer;
pub use deswizzle::{DESWIZZLE_MSL, DeswizzleParams, Deswizzler, Swizzler};
pub use device::{Context, autorelease_pool};
pub use encode::CommandBuffer;
pub use error::{MetalError, Result};
pub use format::{
    BcKind, Format, FormatClass, IndexType, LoadAction, Primitive, SampleType, StoreAction,
};
pub use frame::{FRAMES_IN_FLIGHT, Frame, FrameRing, SCRATCH_BYTES, Submitted};
pub use guest::{GuestMemory, PAGE_SIZE};
pub use icb::{IcbBuffer, IcbCommand, IcbDesc, IndirectCommandBuffer, Inherit};
pub use interpolate::{Camera, FrameInterpolator, InterpolateDesc, InterpolateInputs};
pub use memstats::{MemStats, mem_stats, texture_evicted, texture_reuploaded};
pub use metrics::{CommandBufferStats, FrameHooks, Metrics, MetricsSnapshot};
pub use pacing::{DisplayLink, DisplayTick, FrameInterval, LinkRate, Pacer, RateRange, TickSink};
pub use pipeline::{
    ArchiveConfig, BaseStats, ComputePipeline, MeshPipelineDesc, MissWhy, PipelineCache,
    RenderPipeline, RenderPipelineDesc, ShaderLibrary, Source,
};
pub use policy::{FrameSource, GameRate, PolicyInput, PresentPlan, choose_present_plan};
pub use present::{
    Drawable, PRESENT_FORMAT, Presenter, media_time, set_timed_present, timed_present,
};
pub use render::{
    ColorAttachment, CullMode, DepthAttachment, RenderCommand, RenderPass, RenderPassDesc, Scissor,
    StencilAttachment, Viewport,
};
pub use resample::{RESAMPLE_MSL, Resampler};
pub use residency::ResidentGuard;
pub use sampler::{Border, Filter, MipFilter, Reduction, Sampler, SamplerDesc, Wrap};
pub use scale::{
    MAX_SCALE, METALFX_RATIO, MIN_SCALE, RenderScale, SCALE_STEP, ScaleChoice, ScaleInput,
    UpscaleMode, choose_render_scale,
};
pub use schedule::{Shown, TickAction, TickScheduler};
pub use scratch::{SCRATCH_ALIGN, Scratch};
pub use state::{
    BlendFactor, BlendOp, BlendState, ColorTarget, CompareFn, DepthBias, DepthClip,
    DepthStencilDesc, DepthStencilState, FillMode, StencilFace, StencilOp, StepFunction,
    TopologyClass, VertexAttribute, VertexDescriptor, VertexFormat, VertexLayout, Winding,
};
pub use stats::{
    INTERVAL_BOUNDS_US, INTERVAL_BUCKETS, INTERVAL_LABELS, PacingSnapshot, PacingStats,
    interval_bucket,
};
pub use table::ArgumentTable;
pub use texture::{Storage, Texture, TextureDesc, TextureKind, TextureRegion, ViewDesc};
pub use timestamp::TimestampHeap;
pub use upscale::{SpatialUpscaler, UpscaleDesc};
pub use vmregion::{VmRegion, vm_region};
