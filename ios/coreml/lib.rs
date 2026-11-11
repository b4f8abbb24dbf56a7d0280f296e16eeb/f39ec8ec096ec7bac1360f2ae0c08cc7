//! iOS composition of the pinned, unchanged nxkit Core ML implementation.
#![cfg(target_os = "ios")]
mod cache;
mod error;
mod model;
mod plan;
mod predict;
mod tensor;
pub use cache::os_build_tag;
pub use error::{CoreMlError, Result};
pub use model::{Model, TensorInfo};
pub use objc2_io_surface::IOSurfaceRef;
pub use plan::{ComputeDevice, PlanReport};
pub use tensor::SharedTensor;
