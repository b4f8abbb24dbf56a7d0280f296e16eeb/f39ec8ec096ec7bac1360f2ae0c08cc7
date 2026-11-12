//! Single-application NSP/XCI extraction. Section hashes are checked by nxkit; signatures
//! and CNMT content hashes are not authenticated by this adapter.
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{byte_value, bytes, field};
use nxb_extract::{
    cache::BlockCache,
    keys::KeySet,
    meta,
    nca::{ContentType, Nca, read_hfs0, read_pfs0, xci_secure},
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

// A browser worker can read local Blob slices synchronously. Keeping the
// container outside WASM avoids base64 copies and permits sparse reads of XCI.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "nx2ipa")]
unsafe extern "C" {
    fn read(source: u32, offset: u64, destination: *mut u8, length: usize) -> i32;
}
#[cfg(target_arch = "wasm32")]
struct InputStorage(u64, u32);
#[cfg(target_arch = "wasm32")]
impl Storage for InputStorage {
    fn size(&self) -> u64 {
        self.0
    }
    fn read_at(&self, offset: u64, output: &mut [u8]) -> nxb_extract::Result<()> {
        if offset
            .checked_add(output.len() as u64)
            .is_none_or(|end| end > self.0)
        {
            return Err(nxb_extract::ExtractError::format(
                "input read outside container",
            ));
        }
        if unsafe { read(self.1, offset, output.as_mut_ptr(), output.len()) } != 0 {
            return Err(nxb_extract::ExtractError::format(
                "could not read local container",
            ));
        }
        Ok(())
    }
    fn read_vec(&self, offset: u64, length: usize) -> nxb_extract::Result<Vec<u8>> {
        if length > 256 * 1024 * 1024
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > self.0)
        {
            return Err(nxb_extract::ExtractError::format(
                "container read exceeds 256 MiB working limit",
            ));
        }
        let mut output = vec![0; length];
        self.read_at(offset, &mut output)?;
        Ok(output)
    }
}

fn input_storage(
    input: &Value,
    size_key: &str,
    data_key: &str,
    index: u32,
) -> Result<Arc<dyn Storage>, String> {
    if let Some(size) = input.get(size_key).and_then(Value::as_i64) {
        if size <= 0 || size > (1i64 << 53) - 1 {
            return Err("invalid container size".into());
        }
        #[cfg(target_arch = "wasm32")]
        {
            Ok(Arc::new(InputStorage(size as u64, index)))
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = index;
            Err("external container reads require WASM".into())
        }
    } else {
        Ok(Arc::new(MemStorage(bytes(field(input, data_key)?)?)))
    }
}

pub fn extract(input: &Value) -> Result<Value, String> {
    let base_key = if input.get("nsp").is_some() {
        "nsp"
    } else {
        "xci"
    };
    let mut sources = vec![input_storage(input, "sourceSize", base_key, 0)?];
    let separate_update = input.get("updateSize").is_some() || input.get("update").is_some();
    if separate_update {
        sources.push(input_storage(input, "updateSize", "update", 1)?);
    }
    let mut key_bytes = bytes(field(input, "keys")?)?;
    let keys_text =
        std::str::from_utf8(&key_bytes).map_err(|_| "keys must be UTF-8 prod.keys bytes")?;
    let mut keys = KeySet::parse(keys_text);
    key_bytes.fill(0);
    if keys.header_key().is_none() {
        return Err("prod.keys has no valid header_key".into());
    }
    let mut containers = Vec::new();
    let mut base_is_xci = false;
    for (index, raw) in sources.into_iter().enumerate() {
        let is_xci = raw.size() >= 0x138 && raw.read_vec(0x100, 4).map_err(err)? == b"HEAD";
        if index == 0 {
            base_is_xci = is_xci;
        }
        let (raw, entries) = if is_xci {
            let secure = xci_secure(&raw, "XCI").map_err(err)?;
            let entries = read_hfs0(secure.as_ref()).map_err(err)?;
            (secure, entries)
        } else {
            let entries = read_pfs0(raw.as_ref()).map_err(err)?;
            (raw, entries)
        };
        let mut names = BTreeSet::new();
        for e in &entries {
            let name = e.name.to_ascii_lowercase();
            if !names.insert(name.clone()) {
                return Err("duplicate container member".into());
            }
            if name.ends_with(".ncz") {
                return Err("compressed NCZ is not supported".into());
            }
            if name.ends_with(".tik") {
                let ticket = raw
                    .read_vec(e.offset, 0x2c0.min(usize::try_from(e.size).map_err(err)?))
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
        containers.push((raw, entries));
    }
    let mut ncas: Vec<Nca> = Vec::new();
    let cache = Arc::new(BlockCache::new(16));
    for (source_index, (raw, entries)) in containers.into_iter().enumerate() {
        let mut metadata_count = 0;
        let mut content_ids = BTreeSet::new();
        for e in &entries {
            let name = e.name.to_ascii_lowercase();
            if name.ends_with(".nca") {
                let id = name.split('.').next().unwrap_or("");
                if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("NCA filenames must retain their 32-digit content IDs".into());
                }
                if !content_ids.insert(id.to_owned()) {
                    return Err("duplicate NCA content ID".into());
                }
                let storage =
                    Arc::new(SubStorage::new(raw.clone(), e.offset, e.size).map_err(err)?);
                // Packages may repeat unchanged Control/content NCAs. Reuse only
                // byte-identical content, never let an update shadow a conflicting ID.
                if let Some(existing) = ncas.iter().find(|n| n.id == id) {
                    if separate_update && existing.content_type == ContentType::Meta {
                        return Err("separate inputs must contain a base-only application and an update-only package".into());
                    }
                    if existing.raw.size() != storage.size() {
                        return Err("conflicting NCA content ID across containers".into());
                    }
                    let mut offset = 0;
                    while offset < storage.size() {
                        let length = (storage.size() - offset).min(1024 * 1024) as usize;
                        if existing.raw.read_vec(offset, length).map_err(err)?
                            != storage.read_vec(offset, length).map_err(err)?
                        {
                            return Err("conflicting NCA content ID across containers".into());
                        }
                        offset += length as u64;
                    }
                    continue;
                }
                let nca = Nca::open(&keys, id.into(), storage).map_err(err)?;
                for (_, _, fs) in nca.sections.iter().flatten() {
                    if fs.hash_type == 2
                        && u64::from_le_bytes(fs.raw[0x48..0x50].try_into().unwrap())
                            > 256 * 1024 * 1024
                    {
                        return Err("ExeFS or metadata exceeds the 256 MiB working limit".into());
                    }
                }
                if separate_update && nca.content_type == ContentType::Meta {
                    let source_metas =
                        meta::metas(&keys, std::slice::from_ref(&nca), &cache).map_err(err)?;
                    let expected = if source_index == 0 {
                        meta::APPLICATION
                    } else {
                        meta::PATCH
                    };
                    if source_metas.len() != 1 || source_metas[0].kind != expected {
                        return Err("separate inputs must contain a base-only application and an update-only package".into());
                    }
                    metadata_count += 1;
                }
                ncas.push(nca);
            }
        }
        if separate_update && metadata_count != 1 {
            return Err(
                "separate inputs must contain a base-only application and an update-only package"
                    .into(),
            );
        }
    }
    let metas = meta::metas(&keys, &ncas, &cache).map_err(err)?;
    let applications: Vec<_> = metas
        .iter()
        .filter(|meta| meta.kind == meta::APPLICATION)
        .collect();
    let patches: Vec<_> = metas
        .iter()
        .filter(|meta| meta.kind == meta::PATCH)
        .collect();
    if applications.len() != 1
        || patches.len() > 1
        || applications.len() + patches.len() != metas.len()
    {
        return Err("expected one base application and at most one bundled update; update-only, DLC and multi-title containers are unsupported".into());
    }
    if separate_update && patches.len() != 1 {
        return Err("separate update input must supply one matching update".into());
    }
    let app = applications[0];
    let patch = patches.first().copied();
    if patch.is_some_and(|p| p.title != app.title | 0x800 || p.version < app.version) {
        return Err("update does not match the base application".into());
    }
    let select_program = |meta: &meta::Cnmt| -> Result<&Nca, String> {
        let programs: Vec<_> = ncas
            .iter()
            .filter(|n| n.content_type == ContentType::Program && meta.contents.contains(&n.id))
            .collect();
        if programs.len() != 1 || programs[0].title_id != app.title {
            return Err("expected exactly one matching Program NCA in each CNMT".into());
        }
        Ok(programs[0])
    };
    let base = select_program(app)?;
    let update = patch.map(select_program).transpose()?;
    let program = update.unwrap_or(base);
    let effective = patch.unwrap_or(app);
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
    let mut controls: Vec<_> = ncas
        .iter()
        .filter(|n| n.content_type == ContentType::Control && effective.contents.contains(&n.id))
        .collect();
    if controls.is_empty() && patch.is_some() {
        controls = ncas
            .iter()
            .filter(|n| n.content_type == ContentType::Control && app.contents.contains(&n.id))
            .collect();
    }
    if controls.len() > 1 {
        return Err("expected at most one matching Control NCA".into());
    }
    let control = controls
        .first()
        .map(|n| version::read_control(&keys, n, &cache))
        .transpose()
        .map_err(err)?;
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut total = exefs.iter().map(|(_, b)| b.len() as u64).sum::<u64>();
    let base_data = version::base_data(&keys, base, &cache).map_err(err)?;
    let data_update = update.filter(|n| n.sections[n.data_section()].is_some());
    if base_data.is_some() || data_update.is_some() {
        let rom = version::open_romfs(&keys, base_data, data_update, &cache).map_err(err)?;
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
    let control_size = control.as_ref().map_or(0, |c| {
        c.nacp.len() + c.icon.as_ref().map_or(0, |(_, b)| b.len())
    });
    if total + control_size as u64 > 256 * 1024 * 1024 {
        return Err("extracted game exceeds the minimal bridge 256 MiB limit".into());
    }
    let nacp = control.as_ref().map(|c| c.nacp.as_slice()).unwrap_or(&[]);
    if !nacp.is_empty() {
        files.push(file("path", "control.nacp", nacp));
    }
    if let Some((_, icon)) = control.as_ref().and_then(|c| c.icon.as_ref()) {
        files.push(file("path", "icon.jpg", icon));
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
                ("version".into(), Value::Int(effective.version as i64)),
                (
                    "versionName".into(),
                    Value::Str(version::display_version(nacp)),
                ),
                (
                    "container".into(),
                    Value::Str(if base_is_xci { "xci" } else { "nsp" }.into()),
                ),
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
