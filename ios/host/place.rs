//! iOS uses dyld's signed executable mappings only. No JIT or executable remapping fallback.
use crate::memory::GuestMemory;
use crate::sys::{self, Dylib, PROT_RW, Reservation};
use crate::{Game, HostError, Result, image, layout, macho, memory};
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Dylib,
}
#[derive(Debug)]
pub struct Placed {
    pub game: Game,
    pub placement: Placement,
    pub dylib: Option<Dylib>,
    pub mem: &'static GuestMemory,
    pub images: Vec<Vec<u8>>,
}

fn commands(game: &Game) -> Result<Vec<u8>> {
    let path = game.path(&game.dylib);
    let mut file = std::fs::File::open(&path).map_err(|e| HostError::io(&path, &e))?;
    let mut head = [0; 32];
    file.read_exact(&mut head)
        .map_err(|e| HostError::io(&path, &e))?;
    let end = macho::commands_end(&head)?;
    if !(32..=16 * 1024 * 1024).contains(&end) {
        return Err(HostError::Load("Invalid guest Mach-O command size".into()));
    }
    let mut bytes = vec![0; end];
    bytes[..32].copy_from_slice(&head);
    file.read_exact(&mut bytes[32..])
        .map_err(|e| HostError::io(&path, &e))?;
    image::validate(&bytes)?;
    Ok(bytes)
}

fn gaps(segs: &[macho::Segment], slide: i64, from: u64, to: u64) -> Result<Vec<(u64, u64)>> {
    let mut spans = Vec::new();
    for s in segs {
        let start = s
            .vmaddr
            .checked_add_signed(slide)
            .ok_or_else(|| HostError::Memory("Slid segment address overflow".into()))?;
        let end = start
            .checked_add(s.vmsize)
            .ok_or_else(|| HostError::Memory("Segment end overflow".into()))?;
        spans.push((start, end));
    }
    spans.sort_unstable();
    let mut out = Vec::new();
    let mut cursor = from;
    for (start, end) in spans {
        if start > cursor {
            out.push((cursor, start.min(to) - cursor));
        }
        cursor = cursor.max(end);
        if cursor >= to {
            break;
        }
    }
    if cursor < to {
        out.push((cursor, to - cursor));
    }
    Ok(out)
}

fn map(game: &Game, dylib: &Dylib) -> Result<(Game, layout::Layout, Reservation)> {
    let mapped = dylib.image()?;
    let commands = mapped.commands()?;
    image::validate(&commands)?;
    let segments = macho::segments(&commands)?;
    for module in &game.modules {
        macho::verify(module, &segments)?;
    }
    let moved = game.moved(mapped.slide)?;
    let mut floor = 0;
    for segment in &segments {
        floor = floor.max(
            segment
                .vmaddr
                .checked_add_signed(mapped.slide)
                .and_then(|s| s.checked_add(segment.vmsize))
                .ok_or_else(|| HostError::Memory("Slid segment range overflow".into()))?,
        );
    }
    let layout = layout::plan(&moved, floor)?;
    if !layout.fits_address_space() {
        return Err(HostError::Memory(
            "dyld placed the game outside the 39-bit guest address space".into(),
        ));
    }
    let gaps = gaps(&segments, mapped.slide, layout.all.start, floor)?;
    let res = sys::reserve_tail(layout.all.start, floor, layout.all.end())?;
    let mut done = Vec::new();
    for (at, len) in gaps {
        if let Err(error) = res.map_anon(at, len, PROT_RW) {
            for (at, len) in done {
                let _ = res.unmap(at, len);
            }
            let _ = res.unmap(floor, layout.all.end() - floor);
            return Err(error);
        }
        done.push((at, len));
    }
    Ok((moved, layout, res))
}

pub fn place(game: &Game) -> Result<Placed> {
    let commands = commands(game)?;
    let segs = macho::segments(&commands)?;
    for module in &game.modules {
        macho::verify(module, &segs)?;
    }
    let images = game
        .modules
        .iter()
        .map(|m| {
            let p = game.path(&m.image);
            std::fs::read(&p).map_err(|e| HostError::io(&p, &e))
        })
        .collect::<Result<Vec<_>>>()?;
    let dylib = Dylib::open(&game.path(&game.dylib))?;
    let (game, layout, res) = match map(game, &dylib) {
        Ok(v) => v,
        Err(e) => {
            dylib.close();
            return Err(e);
        }
    };
    // The session permits one initialization. Once registered, guest mappings and the
    // dylib live until process exit, never while detached guest threads could use them.
    let mem = memory::init(layout, res)?;
    Ok(Placed {
        game,
        placement: Placement::Dylib,
        dylib: Some(dylib),
        mem,
        images,
    })
}
