//! iOS uses dyld's signed executable mappings only. No JIT or executable remapping fallback.
use crate::memory::GuestMemory;
use crate::sys::{self, Dylib, Reservation};
use crate::{Game, HostError, Result, image, layout, macho, memory, padding, tail};
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

fn map(game: &Game, dylib: &Dylib) -> Result<(Game, layout::Layout, Reservation)> {
    let mapped = dylib.image()?;
    let commands = mapped.commands()?;
    image::validate(&commands)?;
    let segments = macho::segments(&commands)?;
    for module in &game.modules {
        macho::verify(module, &segments)?;
    }
    let plan = tail::plan(game, &segments, mapped.slide)?;
    let layout = plan.layout;
    if !layout.fits_address_space() {
        return Err(HostError::Memory(
            "dyld placed the game outside the 39-bit guest address space".into(),
        ));
    }
    let gaps = padding::gaps(
        segments
            .iter()
            .filter(|s| s.name != "__NX_HEAP" && s.name != "__LINKEDIT")
            .map(|s| (s.vmaddr, s.vmsize)),
        mapped.slide,
        layout.all.start,
        plan.reserved.start,
    )?;
    // dyld's vm_allocate reserves the entire image, then overlays its segments.
    // Nonfixed mmap over its padding fails; MAP_FIXED would steal its mappings.
    // Padding is unused and excluded from the GPU buffer, so retain it as-is.
    let padding = padding::inspect(&gaps, |at| {
        nxkit_metal::vm_region(at).map(|r| (r.start, r.size))
    })?;
    eprintln!(
        "nx2ipa: retaining {} bytes of dyld padding and leaving {} unmapped/unreported bytes untouched",
        padding.mapped, padding.unreported
    );
    // SAFETY: the mapped commands and actual slide passed the tail contract.
    // The successful session retains the dylib for the rest of the process;
    // failed placement closes it only before any guest view is registered.
    let res =
        unsafe { sys::adopt_dyld_tail(layout.all.start, plan.reserved.start, layout.all.end())? };
    Ok((plan.game, layout, res))
}

pub fn place(game: &Game) -> Result<Placed> {
    let commands = commands(game)?;
    let segs = macho::segments(&commands)?;
    for module in &game.modules {
        macho::verify(module, &segs)?;
    }
    let plan = tail::plan(game, &segs, 0)?;
    if plan.layout.all.len >= layout::SPACE_END {
        return Err(HostError::Memory(
            "Guest span cannot fit the 39-bit address space".into(),
        ));
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
