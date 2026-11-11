//! Portable converter/host contract check. Does not execute guest code or trust signatures.
use nxkit_host::{HostError, Result, bundle, image, layout, macho};
use std::path::Path;
fn validate(app: &Path, data: &Path) -> Result<()> {
    let game = bundle::read(app, data)?;
    let path = game.path(&game.dylib);
    let dylib = std::fs::read(&path).map_err(|e| HostError::io(&path, &e))?;
    image::validate(&dylib)?;
    let segments = macho::segments(&dylib)?;
    for module in &game.modules {
        macho::verify(module, &segments)?;
    }
    let floor = segments.iter().try_fold(0u64, |end, s| {
        s.vmaddr
            .checked_add(s.vmsize)
            .map(|v| end.max(v))
            .ok_or_else(|| HostError::Memory("Guest segment address overflow".into()))
    })?;
    // nxkit's preferred base is relocatable and can exceed 39 bits. Only dyld
    // can establish the actual slide; place.rs checks that real mapped layout.
    // Here verify the required span, not a runtime address we cannot observe.
    if layout::plan(&game, floor)?.all.len >= layout::SPACE_END {
        return Err(HostError::Memory(
            "Guest span cannot fit the 39-bit address space".into(),
        ));
    }
    println!(
        "Native bundle contract accepted: title {}, {} modules. Actual dyld placement, signing trust, execution and gameplay remain unverified.",
        game.title_id,
        game.modules.len()
    );
    Ok(())
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 {
        eprintln!("Usage: validate_bundle /absolute/path/Game.app");
        std::process::exit(2);
    }
    let data = std::env::temp_dir().join(format!(
        "nx2ipa-contract-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = validate(Path::new(&args[1]), &data);
    if data.exists() {
        if let Err(e) = std::fs::remove_dir_all(&data) {
            eprintln!("Cannot remove test data {}: {e}", data.display());
        }
    }
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
