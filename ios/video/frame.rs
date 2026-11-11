//! Decoded NV12 storage for iOS, with checked copy sizes.
use std::sync::atomic::{AtomicU64, Ordering};
static SERIAL: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nv12 {
    pub y: Vec<u8>,
    pub y_stride: usize,
    pub uv: Vec<u8>,
    pub uv_stride: usize,
}
pub(crate) enum Pixels {
    Memory(Nv12),
    #[cfg(target_os = "ios")]
    Buffer(crate::sys::vt::PixelBuffer),
}
pub struct Frame {
    serial: u64,
    dimensions: (u32, u32),
    color: u32,
    pub(crate) pixels: Pixels,
}
impl Frame {
    fn new(width: u32, height: u32, color: u32, pixels: Pixels) -> Self {
        Self {
            serial: SERIAL.fetch_add(1, Ordering::Relaxed),
            dimensions: (width, height),
            color,
            pixels,
        }
    }
    pub fn from_nv12(width: u32, height: u32, colorspace: u32, planes: Nv12) -> Self {
        Self::new(width, height, colorspace, Pixels::Memory(planes))
    }
    #[cfg(target_os = "ios")]
    pub(crate) fn from_buffer(
        width: u32,
        height: u32,
        colorspace: u32,
        buffer: crate::sys::vt::PixelBuffer,
    ) -> Self {
        Self::new(width, height, colorspace, Pixels::Buffer(buffer))
    }
    pub fn id(&self) -> u64 {
        self.serial
    }
    pub fn width(&self) -> u32 {
        self.dimensions.0
    }
    pub fn height(&self) -> u32 {
        self.dimensions.1
    }
    pub fn colorspace(&self) -> u32 {
        self.color
    }
    pub fn with_planes<R>(
        &self,
        f: impl FnOnce(&[u8], usize, &[u8], usize) -> R,
    ) -> Result<R, String> {
        match &self.pixels {
            Pixels::Memory(p) => Ok(f(&p.y, p.y_stride, &p.uv, p.uv_stride)),
            #[cfg(target_os = "ios")]
            Pixels::Buffer(p) => p.with_planes(f),
        }
    }
    pub fn copy_nv12(&self, dst: &mut [u8], stride: usize, slice: usize) -> Result<(), String> {
        let luma = stride.checked_mul(slice).ok_or("NV12 size overflow")?;
        let chroma = stride.checked_mul(slice / 2).ok_or("NV12 size overflow")?;
        let length = luma.checked_add(chroma).ok_or("NV12 size overflow")?;
        let target = dst
            .get_mut(..length)
            .ok_or("NV12 destination is too small")?;
        let width = self.width() as usize;
        let height = self.height() as usize;
        self.with_planes(|y, ys, uv, uvs| {
            let (dy, duv) = target.split_at_mut(luma);
            rows(y, ys, dy, stride, width.min(stride), height.min(slice))?;
            rows(
                uv,
                uvs,
                duv,
                stride,
                (width.div_ceil(2) * 2).min(stride),
                height.div_ceil(2).min(slice / 2),
            )
        })?
    }
    pub fn to_nv12(&self) -> Result<Nv12, String> {
        let stride = (self.width() as usize).div_ceil(2) * 2;
        let slice = (self.height() as usize).div_ceil(2) * 2;
        let luma = stride.checked_mul(slice).ok_or("NV12 size overflow")?;
        let length = luma.checked_add(luma / 2).ok_or("NV12 size overflow")?;
        let mut data = Vec::new();
        data.try_reserve_exact(length)
            .map_err(|e| format!("NV12 allocation failed: {e}"))?;
        data.resize(length, 0);
        self.copy_nv12(&mut data, stride, slice)?;
        let uv = data.split_off(luma);
        Ok(Nv12 {
            y: data,
            y_stride: stride,
            uv,
            uv_stride: stride,
        })
    }
    pub fn to_rgba(&self, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let planes = self.to_nv12()?;
        let length = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("RGBA size overflow")?;
        let mut rgba = Vec::new();
        rgba.try_reserve_exact(length)
            .map_err(|e| format!("RGBA allocation failed: {e}"))?;
        rgba.resize(length, 0);
        crate::yuv::nv12_to_rgba(
            &planes,
            self.width() as usize,
            self.height() as usize,
            self.color,
            &mut rgba,
            width as usize,
            height as usize,
        );
        Ok(rgba)
    }
}
fn rows(
    src: &[u8],
    ss: usize,
    dst: &mut [u8],
    ds: usize,
    width: usize,
    count: usize,
) -> Result<(), String> {
    for row in 0..count {
        let start = row.checked_mul(ss).ok_or("NV12 row overflow")?;
        let end = start
            .checked_add(width.min(ss))
            .ok_or("NV12 row overflow")?;
        let input = src
            .get(start..end)
            .ok_or("NV12 source plane is truncated")?;
        let start = row.checked_mul(ds).ok_or("NV12 row overflow")?;
        let end = start.checked_add(input.len()).ok_or("NV12 row overflow")?;
        dst.get_mut(start..end)
            .ok_or("NV12 destination plane is truncated")?
            .copy_from_slice(input);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> Frame {
        Frame::from_nv12(
            2,
            2,
            3,
            Nv12 {
                y: vec![1, 2, 3, 4],
                y_stride: 2,
                uv: vec![5, 6],
                uv_stride: 2,
            },
        )
    }
    #[test]
    fn stride_and_padding() {
        let mut output = [99; 12];
        frame().copy_nv12(&mut output, 4, 2).unwrap();
        assert_eq!(output, [1, 2, 99, 99, 3, 4, 99, 99, 5, 6, 99, 99]);
    }
    #[test]
    fn invalid_sizes_are_errors() {
        assert!(frame().copy_nv12(&mut [], usize::MAX, 4).is_err());
        assert!(frame().copy_nv12(&mut [0; 5], 2, 2).is_err());
    }
    #[test]
    fn planes_round_trip() {
        assert_eq!(frame().to_nv12().unwrap().uv, vec![5, 6]);
        assert_ne!(frame().id(), frame().id());
    }
}
