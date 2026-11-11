//! Minimal base NSP extraction. Section hashes are checked by nxkit; signatures
//! and CNMT content hashes are not authenticated by this adapter.
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{byte_value, bytes, field};
use nxb_extract::{
    cache::BlockCache,
    keys::KeySet,
    meta,
    nca::{ContentType, Nca, read_pfs0},
    storage::{MemStorage, Storage, SubStorage},
    version,
};
use nxb_pyjson::Value;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn file(key: &str, name: &str, data: &[u8]) -> Value {
    Value::Object(vec![
        (key.into(), Value::Str(name.into())),
        ("data".into(), byte_value(data)),
    ])
}

// The portable crate does not expose its host-only NPDM identity helper.
fn program_id(npdm: &[u8]) -> Result<u64, String> {
    if npdm.len() < 0x80 || npdm.get(..4) != Some(b"META") {
        return Err("main.npdm: missing META header".into());
    }
    let offset = u32::from_le_bytes(npdm[0x70..0x74].try_into().unwrap()) as usize;
    let size = u32::from_le_bytes(npdm[0x74..0x78].try_into().unwrap()) as usize;
    let end = offset.checked_add(size).ok_or("main.npdm: ACI0 overflow")?;
    let aci = npdm
        .get(offset..end)
        .ok_or("main.npdm: ACI0 outside file")?;
    if aci.len() < 0x18 || aci.get(..4) != Some(b"ACI0") {
        return Err("main.npdm: missing ACI0 header".into());
    }
    Ok(u64::from_le_bytes(aci[0x10..0x18].try_into().unwrap()))
}

pub fn extract(input: &Value) -> Result<Value, String> {
    let nsp = bytes(field(input, "nsp")?)?;
    if nsp.len() > 512 * 1024 * 1024 {
        return Err("NSP exceeds the minimal bridge 512 MiB limit".into());
    }
    let raw: Arc<dyn Storage> = Arc::new(MemStorage(nsp));
    let key_bytes = bytes(field(input, "keys")?)?;
    let mut keys = KeySet::parse(
        std::str::from_utf8(&key_bytes).map_err(|_| "keys must be UTF-8 prod.keys bytes")?,
    );
    let entries = read_pfs0(raw.as_ref()).map_err(err)?;
    let mut names = BTreeSet::new();
    for e in &entries {
        let name = e.name.to_ascii_lowercase();
        if !names.insert(name.clone()) {
            return Err("duplicate NSP member".into());
        }
        if name.ends_with(".ncz") {
            return Err("compressed NCZ is not supported".into());
        }
        if name.ends_with(".tik") {
            let ticket = raw
                .read_vec(e.offset, usize::try_from(e.size).map_err(err)?)
                .map_err(err)?;
            if ticket.len() < 0x2c0 || ticket[..4] != [4, 0, 1, 0] || ticket[0x281] != 0 {
                return Err("only common RSA-2048/SHA-256 tickets are supported".into());
            }
            keys.add_title_key(
                ticket[0x2a0..0x2b0].try_into().unwrap(),
                ticket[0x180..0x190].try_into().unwrap(),
            );
        }
    }
    let mut ncas = Vec::new();
    for e in &entries {
        let name = e.name.to_ascii_lowercase();
        if name.ends_with(".nca") {
            let id = name.split('.').next().unwrap_or("");
            if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("NCA filenames must retain their 32-digit content IDs".into());
            }
            let storage = Arc::new(SubStorage::new(raw.clone(), e.offset, e.size).map_err(err)?);
            ncas.push(Nca::open(&keys, id.into(), storage).map_err(err)?);
        }
    }
    let cache = Arc::new(BlockCache::new(16));
    let metas = meta::metas(&keys, &ncas, &cache).map_err(err)?;
    if metas.len() != 1 || metas[0].kind != meta::APPLICATION {
        return Err(
            "expected one base Application CNMT; updates and multi-title NSPs are unsupported"
                .into(),
        );
    }
    let app = &metas[0];
    let programs: Vec<_> = ncas
        .iter()
        .filter(|n| n.content_type == ContentType::Program)
        .collect();
    if programs.len() != 1 {
        return Err("expected exactly one Program NCA".into());
    }
    let program = programs[0];
    if program.title_id != app.title || !app.contents.contains(&program.id) {
        return Err("Program NCA does not match the Application CNMT".into());
    }
    let exefs = version::read_exefs(&keys, program, &cache).map_err(err)?;
    let npdms: Vec<_> = exefs.iter().filter(|(n, _)| n == "main.npdm").collect();
    if npdms.len() != 1 {
        return Err("expected one main.npdm".into());
    }
    let npdm = &npdms[0].1;
    if program_id(npdm)? != app.title {
        return Err("NPDM program ID does not match Application CNMT and NCA".into());
    }
    let mut modules = Vec::new();
    let mut module_names = BTreeSet::new();
    for (name, data) in &exefs {
        if data.starts_with(b"NSO0") {
            if !module_names.insert(name) {
                return Err("duplicate NSO module".into());
            }
            modules.push(file("name", name, data));
        }
    }
    if !module_names.contains(&"main".to_string()) {
        return Err("ExeFS has no main NSO module".into());
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut total = exefs.iter().map(|(_, b)| b.len() as u64).sum::<u64>();
    if let Some(base) = version::base_data(&keys, program, &cache).map_err(err)? {
        let rom = version::open_romfs(&keys, Some(base), None, &cache).map_err(err)?;
        directories.push(Value::Str("romfs".into()));
        for e in &rom.entries {
            let path = std::str::from_utf8(&e.path).map_err(|_| "RomFS filenames must be UTF-8")?;
            nxb_extract::safe_path::rel("RomFS", path, false).map_err(err)?;
            if path.contains('\\') {
                return Err("RomFS filename contains backslash".into());
            }
            if e.dir {
                directories.push(Value::Str(format!(
                    "romfs/{}",
                    path.trim_start_matches('/')
                )));
                continue;
            }
            total = total.checked_add(e.size).ok_or("extracted size overflow")?;
            if total > 256 * 1024 * 1024 {
                return Err("extracted game exceeds the minimal bridge 256 MiB limit".into());
            }
            let data = rom
                .fs
                .read_vec(e.offset, usize::try_from(e.size).map_err(err)?)
                .map_err(err)?;
            files.push(file(
                "path",
                &format!("romfs/{}", path.trim_start_matches('/')),
                &data,
            ));
        }
    }
    if total > 256 * 1024 * 1024 {
        return Err("extracted game exceeds the minimal bridge 256 MiB limit".into());
    }
    Ok(Value::Object(vec![
        ("titleId".into(), Value::Str(format!("{:016x}", app.title))),
        ("modules".into(), Value::List(modules)),
        ("npdm".into(), byte_value(npdm)),
        ("files".into(), Value::List(files)),
        ("directories".into(), Value::List(directories)),
        (
            "metadata".into(),
            Value::Object(vec![
                ("titleId".into(), Value::Str(format!("{:016x}", app.title))),
                ("version".into(), Value::Int(app.version as i64)),
                (
                    "verification".into(),
                    Value::Str("consistency-checked".into()),
                ),
                ("authenticationVerified".into(), Value::Bool(false)),
            ]),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_npdm_identity_and_rejects_truncation() {
        let mut b = vec![0; 0x98];
        b[..4].copy_from_slice(b"META");
        b[0x70..0x74].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x74..0x78].copy_from_slice(&0x18u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"ACI0");
        b[0x90..0x98].copy_from_slice(&42u64.to_le_bytes());
        assert_eq!(program_id(&b).unwrap(), 42);
        assert!(program_id(&b[..0x97]).is_err());
    }
}
