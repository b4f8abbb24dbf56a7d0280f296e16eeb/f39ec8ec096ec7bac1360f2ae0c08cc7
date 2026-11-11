//! iOS selects nxkit's existing Apple controller and haptics implementations.
//! Every other source module in this adapter is an unchanged upstream file.
#[cfg(target_os = "ios")]
#[allow(unsafe_code)]
mod apple;
#[cfg(target_os = "ios")]
#[allow(unsafe_code)]
mod haptics;
#[cfg(target_os = "ios")]
pub(crate) use apple::Platform;
#[cfg(not(target_os = "ios"))]
mod stub;
#[cfg(not(target_os = "ios"))]
pub(crate) use stub::Platform;
