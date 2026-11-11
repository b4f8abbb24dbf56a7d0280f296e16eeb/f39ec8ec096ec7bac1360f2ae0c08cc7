//! Clock, calendar and guest-call boundary. libc selects the Darwin ABI on iOS.
#![allow(unsafe_code)]
use std::ffi::CStr;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tm {
    pub(crate) year: i32,
    pub(crate) month: u32,
    pub(crate) day: u32,
    pub(crate) hour: u32,
    pub(crate) minute: u32,
    pub(crate) second: u32,
    pub(crate) wday: u32,
    pub(crate) yday: u32,
    pub(crate) dst: bool,
    pub(crate) offset: i32,
    pub(crate) zone: [u8; 8],
}
pub(crate) fn monotonic_ns() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: the pointer refers to a valid output timespec. libc's constant is platform-specific (6 on Darwin).
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return 0;
    }
    (time.tv_sec.max(0) as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(time.tv_nsec.max(0) as u64)
}
fn calendar(timestamp: i64, utc: bool) -> Option<Tm> {
    let mut result = std::mem::MaybeUninit::<libc::tm>::uninit();
    let timestamp: libc::time_t = timestamp.try_into().ok()?;
    // SAFETY: timestamp and the uninitialized output have the libc ABI and are valid for the call.
    let ptr = unsafe {
        if utc {
            libc::gmtime_r(&timestamp, result.as_mut_ptr())
        } else {
            libc::localtime_r(&timestamp, result.as_mut_ptr())
        }
    };
    if ptr.is_null() {
        return None;
    }
    // SAFETY: successful libc conversion initialized the complete tm output.
    let result = unsafe { result.assume_init() };
    let mut zone = [0; 8];
    if !result.tm_zone.is_null() {
        // SAFETY: successful conversion supplies a static NUL-terminated timezone abbreviation.
        let name = unsafe { CStr::from_ptr(result.tm_zone) }.to_bytes();
        let length = name.len().min(7);
        zone[..length].copy_from_slice(&name[..length]);
    }
    Some(Tm {
        year: result.tm_year.checked_add(1900)?,
        month: (result.tm_mon + 1).try_into().ok()?,
        day: result.tm_mday.try_into().ok()?,
        hour: result.tm_hour.try_into().ok()?,
        minute: result.tm_min.try_into().ok()?,
        second: result.tm_sec.try_into().ok()?,
        wday: result.tm_wday.try_into().ok()?,
        yday: result.tm_yday.try_into().ok()?,
        dst: result.tm_isdst > 0,
        offset: result.tm_gmtoff.try_into().ok()?,
        zone,
    })
}
pub(crate) fn local_time(t: i64) -> Option<Tm> {
    calendar(t, false)
}
pub(crate) fn utc_time(t: i64) -> Option<Tm> {
    calendar(t, true)
}
fn posix(fields: [i32; 9], utc: bool) -> Option<i64> {
    // SAFETY: all-zero libc::tm is valid; it contains only integers and nullable pointers.
    let mut time: libc::tm = unsafe { std::mem::zeroed() };
    time.tm_sec = fields[0];
    time.tm_min = fields[1];
    time.tm_hour = fields[2];
    time.tm_mday = fields[3];
    time.tm_mon = fields[4];
    time.tm_year = fields[5];
    time.tm_wday = fields[6];
    time.tm_yday = fields[7];
    time.tm_isdst = fields[8];
    // SAFETY: these functions normalize the valid, writable tm structure.
    let seconds = unsafe {
        if utc {
            libc::timegm(&mut time)
        } else {
            libc::mktime(&mut time)
        }
    };
    (seconds != -1).then_some(seconds as i64)
}
fn fields(t: &Tm) -> Option<[i32; 9]> {
    Some([
        t.second.try_into().ok()?,
        t.minute.try_into().ok()?,
        t.hour.try_into().ok()?,
        t.day.try_into().ok()?,
        i32::try_from(t.month).ok()?.checked_sub(1)?,
        t.year.checked_sub(1900)?,
        0,
        0,
        -1,
    ])
}
pub(crate) fn to_posix(t: &Tm) -> Option<i64> {
    posix(fields(t)?, false)
}
pub(crate) fn to_posix_utc(t: &Tm) -> Option<i64> {
    posix(fields(t)?, true)
}
pub(crate) fn mktime_fields(f: [i32; 9]) -> Option<i64> {
    posix(f, false)
}
pub(crate) fn call_guest(address: u64, args: [u64; 6]) -> u64 {
    call_guest8(address, args, [0; 2])
}
pub(crate) fn call_guest7(address: u64, args: [u64; 6], last: u64) -> u64 {
    call_guest8(address, args, [last, 0])
}
pub(crate) fn call_guest8(address: u64, args: [u64; 6], tail: [u64; 2]) -> u64 {
    type Entry = extern "C" fn(u64, u64, u64, u64, u64, u64, u64, u64) -> u64;
    let Ok(address) = usize::try_from(address) else {
        return 0;
    };
    if address == 0 {
        return 0;
    }
    // SAFETY: the host resolver supplies a live native guest C-ABI entry; execution occurs on a guest thread.
    let entry = unsafe { std::mem::transmute::<usize, Entry>(address) };
    entry(
        args[0], args[1], args[2], args[3], args[4], args[5], tail[0], tail[1],
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clock_advances() {
        let before = monotonic_ns();
        std::thread::sleep(std::time::Duration::from_millis(1));
        assert!(before > 0 && monotonic_ns() > before);
    }
    #[test]
    fn calendar_roundtrips() {
        let timestamp = 1_700_000_000;
        assert_eq!(
            utc_time(timestamp).as_ref().and_then(to_posix_utc),
            Some(timestamp)
        );
        assert_eq!(
            local_time(timestamp).as_ref().and_then(to_posix),
            Some(timestamp)
        );
        assert_eq!(utc_time(timestamp).unwrap().year, 2023);
    }
    #[test]
    fn null_guest_is_not_callable() {
        assert_eq!(call_guest(0, [0; 6]), 0);
    }
    #[cfg(target_os = "ios")]
    #[test]
    fn darwin_monotonic_id() {
        assert_eq!(libc::CLOCK_MONOTONIC, 6);
    }
}
