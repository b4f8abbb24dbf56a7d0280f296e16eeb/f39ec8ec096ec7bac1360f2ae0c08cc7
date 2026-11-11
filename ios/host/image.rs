//! Validate the guest dynamic library before dyld is allowed to execute it.
use crate::{HostError, Result};

fn bad(message: &str) -> HostError {
    HostError::Load(format!("iOS guest library: {message}"))
}
fn word(bytes: &[u8], offset: usize) -> Result<u32> {
    bytes
        .get(offset..offset + 4)
        .and_then(|v| v.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| bad("truncated header or command"))
}
/// Only thin ARM64 iOS 26 dylibs with no automatic initializer are accepted.
/// Signing is enforced by dyld, not replaced with an ad-hoc executable mapping.
pub fn validate(bytes: &[u8]) -> Result<()> {
    if word(bytes, 0)? != 0xfeedfacf || word(bytes, 4)? != 0x0100000c || word(bytes, 12)? != 6 {
        return Err(bad("expected a thin ARM64 MH_DYLIB"));
    }
    let end = 32usize
        .checked_add(word(bytes, 20)? as usize)
        .ok_or_else(|| bad("size overflow"))?;
    if end > bytes.len() || end > 16 * 1024 * 1024 {
        return Err(bad("invalid command length"));
    }
    let mut at = 32usize;
    let mut platform = false;
    for _ in 0..word(bytes, 16)? {
        let cmd = word(bytes, at)?;
        let size = word(bytes, at + 4)? as usize;
        let next = at
            .checked_add(size)
            .ok_or_else(|| bad("command size overflow"))?;
        if size < 8 || size % 8 != 0 || next > end {
            return Err(bad("invalid load command"));
        }
        if cmd == 0x32 {
            if platform
                || size < 24
                || word(bytes, at + 8)? != 2
                || word(bytes, at + 12)? != 26 << 16
            {
                return Err(bad("expected exactly one iOS 26.0 build-version command"));
            }
            platform = true;
        }
        // An nxgame is data and rewritten code only. dyld must not execute game code before our gates exist.
        if cmd == 0x8000001c
            || cmd == 0xc
            || cmd == 0x80000018
            || cmd == 0x8000001f
            || cmd == 0x20
            || cmd == 0x80000023
        {
            return Err(bad(
                "guest library must not load dependencies or use rpaths",
            ));
        }
        if cmd == 0x19 {
            if size < 72 {
                return Err(bad("truncated segment"));
            }
            let sections = word(bytes, at + 64)? as usize;
            if 72usize.checked_add(
                sections
                    .checked_mul(80)
                    .ok_or_else(|| bad("section overflow"))?,
            ) != Some(size)
            {
                return Err(bad("invalid section table"));
            }
            for n in 0..sections {
                let kind = word(bytes, at + 72 + n * 80 + 64)? & 0xff;
                if matches!(kind, 0x9 | 0xa | 0x15 | 0x16) {
                    return Err(bad(
                        "automatic initializer/terminator sections are not allowed",
                    ));
                }
            }
        }
        if cmd == 0x1a || cmd == 0x11 {
            return Err(bad("LC_ROUTINES_64 is not allowed"));
        }
        at = next;
    }
    if at != end || !platform {
        return Err(bad("missing iOS platform or inconsistent command table"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file() -> Vec<u8> {
        let mut b = vec![0; 56];
        for (at, v) in [
            (0, 0xfeedfacf_u32),
            (4, 0x0100000c),
            (12, 6),
            (16, 1),
            (20, 24),
            (32, 0x32),
            (36, 24),
            (40, 2),
            (44, 26 << 16),
        ] {
            b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        b
    }
    #[test]
    fn accepts_ios_dylib() {
        validate(&file()).unwrap();
    }
    #[test]
    fn rejects_wrong_arch_type_platform_and_version() {
        for (at, v) in [
            (4, 0x01000007_u32),
            (12, 2),
            (40, 7),
            (44, 10 << 16),
            (32, 0x25),
            (16, 0),
            (20, 25),
        ] {
            let mut b = file();
            b[at..at + 4].copy_from_slice(&v.to_le_bytes());
            assert!(validate(&b).is_err());
        }
    }
    #[test]
    fn truncated_inputs_never_pass() {
        let b = file();
        for len in 0..b.len() {
            assert!(validate(&b[..len]).is_err());
        }
    }
}
