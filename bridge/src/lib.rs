//! Small byte-in/byte-out adapter to unmodified nxkit. No filesystem or native host.
mod image;
use image::{layout, manifest, npdm};
use nxb_pyjson::{Value as J, dumps, parse};

mod extract;
mod shaders;

type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 512 * 1024 * 1024;
const INPUT_LIMIT: usize = 256 * 1024 * 1024;
pub(crate) fn field<'a>(j: &'a J, key: &str) -> Result<&'a J> {
    j.get(key).ok_or_else(|| format!("missing {key}"))
}
pub(crate) fn text<'a>(j: &'a J, key: &str) -> Result<&'a str> {
    field(j, key)?
        .as_str()
        .ok_or_else(|| format!("{key} must be a string"))
}
fn list(j: &J) -> Result<&[J]> {
    j.as_list().ok_or_else(|| "expected array".into())
}
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(crate) fn bytes(j: &J) -> Result<Vec<u8>> {
    let s = j.as_str().ok_or("expected base64 string")?.as_bytes();
    if s.len() % 4 != 0 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for (index, c) in s.chunks_exact(4).enumerate() {
        let last = index + 1 == s.len() / 4;
        let padding = if c[2] == b'=' {
            2
        } else if c[3] == b'=' {
            1
        } else {
            0
        };
        if padding > 0 && !last || padding == 2 && c[3] != b'=' {
            return Err("invalid base64 padding".into());
        }
        let mut n = 0u32;
        for (i, v) in c.iter().enumerate() {
            n = (n << 6)
                | if i >= 4 - padding {
                    0
                } else {
                    B64.iter()
                        .position(|b| b == v)
                        .ok_or("invalid base64 character")? as u32
                };
        }
        if padding == 2 && n & 0xffff != 0 || padding == 1 && n & 0xff != 0 {
            return Err("noncanonical base64".into());
        }
        out.push((n >> 16) as u8);
        if padding < 2 {
            out.push((n >> 8) as u8);
        }
        if padding < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}
pub(crate) fn byte_value(b: &[u8]) -> J {
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((c.get(1).copied().unwrap_or(0) as u32) << 8)
            | c.get(2).copied().unwrap_or(0) as u32;
        for shift in [18, 12, 6, 0] {
            out.push(B64[((n >> shift) & 63) as usize] as char);
        }
        if c.len() < 3 {
            out.pop();
            out.push('=');
        }
        if c.len() < 2 {
            let len = out.len();
            out.replace_range(len - 2..len - 1, "=");
        }
    }
    J::str(out)
}
fn file(path: impl Into<String>, b: &[u8]) -> J {
    J::obj([("path", J::str(path)), ("data", byte_value(b))])
}
fn safe_name(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("invalid name".into());
    }
    Ok(())
}
fn strings(j: &J, key: &str) -> Result<Vec<String>> {
    j.get(key)
        .map(|v| {
            list(v)?
                .iter()
                .map(|s| {
                    s.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| format!("{key} must contain strings"))
                })
                .collect()
        })
        .unwrap_or(Ok(vec![]))
}
fn merge(j: &mut J, key: &str, extra: Option<&J>) -> Result<()> {
    if let Some(extra) = extra {
        let J::Object(entries) = extra else {
            return Err(format!("{key} must be an object"));
        };
        let mut target = field(j, key)?.clone();
        for (k, v) in entries {
            target.set(k, v.clone());
        }
        j.set(key, target);
    }
    Ok(())
}
// Generic virtual-address budgets, not a claim about available device RAM.
// The host derives heap = reserve - alias - stack - its 256 MiB front region.
fn runtime_defaults(npdm: &[u8]) -> Result<(nxtitle::Settings, npdm::MainThread)> {
    let thread = npdm::main_thread(npdm)?;
    let mut settings = nxtitle::Settings::DEFAULT;
    settings.memory = nxtitle::Memory {
        reserve: 4 << 30,
        alias: 256 << 20,
        stack: 256 << 20,
        app_pool: 3 << 30,
        used: 64 << 20,
        system_resource: u32::from_le_bytes(npdm[0x14..0x18].try_into().unwrap()) as u64,
        map_limit: true,
        stdalloc_cap: 0,
        alloc_big_align: false,
    };
    Ok((settings, thread))
}

fn runtime_services(profile: &J) -> Result<Vec<String>> {
    let known: Vec<_> = nxtitle::Service::ALL.iter().map(|s| s.id()).collect();
    let services: Vec<String> = if profile.get("services").is_some() {
        strings(profile, "services")?
            .into_iter()
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        known.iter().map(|s| s.to_string()).collect()
    };
    if services
        .iter()
        .enumerate()
        .any(|(i, s)| !known.contains(&s.as_str()) || services[..i].contains(s))
    {
        return Err("services must contain unique, known nxkit service IDs".into());
    }
    if !services.iter().any(|s| s == "kernel") {
        return Err("services must include kernel".into());
    }
    Ok(services)
}

fn validate_memory(game: &J, thread: npdm::MainThread) -> Result<()> {
    let memory = field(game, "memory")?;
    let number = |key: &str| -> Result<u64> {
        let value = field(memory, key)?;
        let parsed = match value {
            J::Int(n) => u64::try_from(*n).ok(),
            J::Str(s) => s
                .strip_prefix("0x")
                .map_or_else(|| s.parse().ok(), |s| u64::from_str_radix(s, 16).ok()),
            _ => None,
        };
        parsed
            .filter(|v| *v < (1 << 39))
            .ok_or_else(|| format!("memory.{key} must be a nonnegative size below 512 GiB"))
    };
    let reserve = number("reserve")?;
    let alias = number("alias")?;
    let stack = number("stack")?;
    let heap = reserve
        .checked_sub(alias)
        .and_then(|n| n.checked_sub(stack))
        .and_then(|n| n.checked_sub(256 << 20));
    if heap.is_none_or(|n| n < 0x20_0000) {
        return Err("memory.reserve must leave at least 2 MiB for the heap after alias, stack and the 256 MiB front region".into());
    }
    let pool = number("app_pool")?;
    let used = number("mem_used")?;
    if pool
        .checked_sub(used)
        .is_none_or(|free| free < thread.stack_size as u64 + 0x4000)
    {
        return Err(
            "memory.app_pool must cover mem_used and the NPDM main stack plus its guard page"
                .into(),
        );
    }
    let system = number("sys_resource")?;
    if !system.is_multiple_of(0x1000) || system > pool {
        return Err("memory.sys_resource must be page aligned and within app_pool".into());
    }
    Ok(())
}

// Check the expanded NSO span before either upstream reader allocates it.
// BSS is deliberately excluded: the rewriter can preserve it as virtual space.
fn check_nso_size(nso: &[u8]) -> Result<()> {
    if nso.starts_with(b"NSO0") {
        for i in 0..3 {
            let at = 0x14 + i * 16;
            let words = nso.get(at..at + 8).ok_or("truncated NSO")?;
            let offset = u32::from_le_bytes(words[..4].try_into().unwrap()) as u64;
            let size = u32::from_le_bytes(words[4..].try_into().unwrap()) as u64;
            if offset + size > INPUT_LIMIT as u64 {
                return Err("NSO memory image exceeds 256 MiB".into());
            }
        }
    }
    Ok(())
}

fn build_runfolder(input: &J) -> Result<J> {
    let p = field(input, "profile")?;
    let declared = list(field(p, "modules")?)?;
    if declared.is_empty() || declared.len() > 32 {
        return Err("profile needs 1..32 modules".into());
    }
    let mut order = Vec::new();
    for m in declared {
        let name = text(m, "name")?;
        safe_name(name)?;
        let id = text(m, "buildId")?;
        if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("buildId must be 32 hex digits".into());
        }
        if order.iter().any(|(n, _)| *n == name) {
            return Err("duplicate module".into());
        }
        order.push((name, id));
    }
    let mut modules = Vec::new();
    for m in list(field(input, "modules")?)? {
        modules.push((text(m, "name")?, bytes(field(m, "data")?)?));
    }
    let rules = p.get("rules").and_then(J::as_str).unwrap_or("");
    let built = image::rewrite_with_loader(
        &order,
        "explicit",
        if rules.is_empty() {
            r#"scope = "explicit""#
        } else {
            rules
        },
        |name| {
            let (_, data) = modules
                .iter()
                .find(|(n, _)| *n == name)
                .ok_or_else(|| format!("missing module {name}"))?;
            check_nso_size(data)?;
            Ok(data.clone())
        },
        |_| {},
        |_, _, _| {},
    )?;
    let bases = layout::bases(&built.iter().map(|b| b.shape.clone()).collect::<Vec<_>>());
    let mods = built.into_iter().zip(bases).collect::<Vec<_>>();
    let npdm = bytes(field(input, "npdm")?)?;
    let title_id = u64::from_str_radix(text(p, "titleId")?, 16).map_err(|_| "invalid titleId")?;
    let (settings, main_thread) = runtime_defaults(&npdm)?;
    let services = runtime_services(p)?;
    let manifest = manifest::Manifest {
        title_id,
        name: text(p, "name")?,
        version: p
            .get("version")
            .and_then(J::as_i64)
            .unwrap_or(0)
            .try_into()
            .map_err(|_| "invalid version")?,
        version_name: p
            .get("versionName")
            .and_then(J::as_str)
            .unwrap_or("")
            .into(),
        modules: &mods,
        services: vec![],
        nvn_functions: strings(p, "nvnFunctions")?,
        patches: !rules.is_empty(),
        main_thread,
        aoc: &[],
        settings,
        shared_font_decode: false,
        sf_services: vec![],
        vertex_stream_null_bind: false,
    };
    let mut game = parse(&manifest::game_json(&manifest)).map_err(|e| format!("{e:?}"))?;
    merge(&mut game, "settings", p.get("settings"))?;
    merge(&mut game, "memory", p.get("memory"))?;
    validate_memory(&game, main_thread)?;
    game.set(
        "services",
        J::List(services.into_iter().map(J::str).collect()),
    );
    let mut dylib = image::dylib(&mods)?;
    ios_dylib(&mut dylib)?;
    let mut files = vec![
        file("game.json", dumps(&game).as_bytes()),
        file("main.npdm", &npdm),
        file("nxgame.dylib", &dylib),
    ];
    if !rules.is_empty() {
        files.push(file("patches.toml", rules.as_bytes()));
    }
    for (m, _) in mods {
        files.push(file(
            format!("modules/{}.imports.json", m.name),
            manifest::imports_json(&m.symbols.imports).as_bytes(),
        ));
        files.push(file(
            format!("modules/{}.exports.json", m.name),
            manifest::symbols_json(&m.symbols.exports).as_bytes(),
        ));
        files.push(file(format!("modules/{}.bin", m.name), &m.image));
        files.push(file(
            format!("modules/{}.fixups.tsv", m.name),
            m.fixups.as_bytes(),
        ));
        files.push(file(format!("modules/{}.gates.tsv", m.name), &m.gates));
    }
    Ok(J::obj([("files", J::List(files))]))
}

// This changes the generated image's declared platform, not its guest code or a host runtime.
fn ios_dylib(b: &mut [u8]) -> Result<()> {
    fn word(b: &[u8], at: usize) -> Result<u32> {
        Ok(u32::from_le_bytes(
            b.get(at..at + 4)
                .ok_or("truncated Mach-O")?
                .try_into()
                .unwrap(),
        ))
    }
    if word(b, 0)? != 0xfeedfacf || word(b, 4)? != 0x0100000c {
        return Err("expected arm64 Mach-O".into());
    }
    let end = 32 + word(b, 20)? as usize;
    if end > b.len() || end > 0x4000 {
        return Err("invalid Mach-O commands".into());
    }
    let mut at = 32;
    let mut found = false;
    let mut text_command = None;
    for _ in 0..word(b, 16)? {
        let cmd = word(b, at)?;
        let size = word(b, at + 4)? as usize;
        if size < 8 || size % 8 != 0 || at + size > end {
            return Err("invalid Mach-O command".into());
        }
        if cmd == 0x19
            && size >= 72
            && b.get(at + 8..at + 24) == Some(b"__TEXT\0\0\0\0\0\0\0\0\0\0")
        {
            if size != 72 || word(b, at + 64)? != 0 {
                return Err("unexpected header segment".into());
            }
            text_command = Some(at);
        }
        if cmd == 0x32 {
            if size != 24 || found {
                return Err("unexpected build-version command".into());
            }
            for (off, value) in [(8, 2u32), (12, 26 << 16), (16, 26 << 16)] {
                b[at + off..at + off + 4].copy_from_slice(&value.to_le_bytes());
            }
            found = true;
        }
        at += size;
    }
    if at != end || !found {
        return Err("missing build-version command".into());
    }
    // zsign discovers spare load-command room through __TEXT,__text. Upstream
    // reserves a 16 KiB header segment, so add one section inside that padding.
    let text = text_command.ok_or("missing header segment")?;
    const MARKER: usize = 0x3ffc;
    if b.len() < 0x4000 || end + 80 + 16 > MARKER || b[end..0x4000].iter().any(|v| *v != 0) {
        return Err("no room for signing marker".into());
    }
    let vmaddr = u64::from_le_bytes(b[text + 24..text + 32].try_into().unwrap());
    let section = text + 72;
    b.copy_within(section..end, section + 80);
    b[section..section + 80].fill(0);
    b[section..section + 6].copy_from_slice(b"__text");
    b[section + 16..section + 22].copy_from_slice(b"__TEXT");
    b[section + 32..section + 40].copy_from_slice(&(vmaddr + MARKER as u64).to_le_bytes());
    b[section + 40..section + 48].copy_from_slice(&4u64.to_le_bytes());
    b[section + 48..section + 52].copy_from_slice(&(MARKER as u32).to_le_bytes());
    b[section + 52..section + 56].copy_from_slice(&2u32.to_le_bytes());
    b[section + 64..section + 68].copy_from_slice(&0x80000400u32.to_le_bytes());
    b[text + 4..text + 8].copy_from_slice(&152u32.to_le_bytes());
    b[text + 64..text + 68].copy_from_slice(&1u32.to_le_bytes());
    b[20..24].copy_from_slice(&((end - 32 + 80) as u32).to_le_bytes());
    b[MARKER..MARKER + 4].copy_from_slice(&0xd65f03c0u32.to_le_bytes()); // arm64 RET
    Ok(())
}

pub fn process(input: &[u8]) -> Vec<u8> {
    let result = (|| {
        if input.len() > LIMIT {
            return Err("input exceeds 512 MiB".into());
        }
        let input = std::str::from_utf8(input).map_err(|_| "input is not UTF-8")?;
        // Keep recursive JSON parsing within the WASM stack budget.
        let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
        for b in input.bytes() {
            if quoted {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    quoted = false;
                }
            } else {
                match b {
                    b'"' => quoted = true,
                    b'[' | b'{' => {
                        depth += 1;
                        if depth > 32 {
                            return Err("JSON nesting exceeds 32".into());
                        }
                    }
                    b']' | b'}' => {
                        depth = depth.saturating_sub(1);
                    }
                    _ => {}
                }
            }
        }
        let j = parse(input).map_err(|e| format!("invalid JSON: {e:?}"))?;
        if field(&j, "version")?.as_i64() != Some(1) {
            return Err("unsupported ABI version".into());
        }
        match text(&j, "op")? {
            "buildRunfolder" => build_runfolder(&j),
            "compileShaders" => shaders::explicit(&j),
            "discoverShaders" => shaders::discover(&j),
            "extract" => extract::extract(&j),
            _ => Err("unknown operation".into()),
        }
    })();
    let mut output = match result {
        Ok(mut j) => {
            j.set("ok", J::Bool(true));
            j
        }
        Err(e) => J::obj([("ok", J::Bool(false)), ("error", J::str(e))]),
    };
    output.set("version", J::Int(1));
    dumps(&output).into_bytes()
}

#[unsafe(no_mangle)]
pub extern "C" fn nx2ipa_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn nx2ipa_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
/// The caller owns allocations and frees each exactly once, with its original length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nx2ipa_dealloc(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
/// The result packs pointer in the high 32 bits and byte length in the low 32 bits.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nx2ipa_call(ptr: *const u8, len: usize) -> u64 {
    let output = process(unsafe { std::slice::from_raw_parts(ptr, len) }).into_boxed_slice();
    let len = output.len() as u64;
    let ptr = Box::into_raw(output) as *mut u8;
    ((ptr as u64) << 32) | len
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_transport_and_version() {
        for value in [vec![], vec![0], vec![0, 255], vec![1, 2, 3, 4, 5, 6, 7]] {
            assert_eq!(bytes(&byte_value(&value)).unwrap(), value);
        }
        assert!(bytes(&J::str("AA=A")).is_err());
        let response = parse(
            std::str::from_utf8(&process(br#"{"version":2,"op":"buildRunfolder"}"#)).unwrap(),
        )
        .unwrap();
        assert_eq!(response.get("ok"), Some(&J::Bool(false)));
    }
    #[test]
    fn runtime_defaults_and_required_overrides() {
        let mut npdm = vec![0; 0x80];
        npdm[..4].copy_from_slice(b"META");
        npdm[0x14..0x18].copy_from_slice(&0x10000u32.to_le_bytes());
        npdm[0x1c..0x20].copy_from_slice(&0x100000u32.to_le_bytes());
        let (settings, thread) = runtime_defaults(&npdm).unwrap();
        let m = settings.memory;
        assert_eq!(
            (m.reserve, m.alias, m.stack, m.app_pool),
            (4 << 30, 256 << 20, 256 << 20, 3 << 30)
        );
        assert_eq!(m.system_resource, 0x10000);
        assert_eq!(thread.stack_size, 0x100000);
        assert_eq!(runtime_services(&J::obj([])).unwrap().len(), 9);
        assert!(runtime_services(&J::obj([("services", J::List(vec![J::str("gpu")]))])).is_err());
        let mut game = parse(r#"{"memory":{"reserve":4294967296,"alias":268435456,"stack":268435456,"app_pool":3221225472,"mem_used":67108864,"sys_resource":65536}}"#).unwrap();
        validate_memory(&game, thread).unwrap();
        merge(&mut game, "memory", Some(&J::obj([("reserve", J::Int(0))]))).unwrap();
        assert!(validate_memory(&game, thread).is_err());
    }
    #[test]
    fn ios_header_only() {
        let mut image = vec![0; 0x4000];
        for (at, n) in [
            (0, 0xfeedfacfu32),
            (4, 0x0100000c),
            (16, 2),
            (20, 96),
            (32, 0x19),
            (36, 72),
            (104, 0x32),
            (108, 24),
            (112, 1),
            (116, 14 << 16),
            (120, 14 << 16),
        ] {
            image[at..at + 4].copy_from_slice(&n.to_le_bytes());
        }
        image[40..46].copy_from_slice(b"__TEXT");
        ios_dylib(&mut image).unwrap();
        assert_eq!(&image[192..204], &[2, 0, 0, 0, 0, 0, 26, 0, 0, 0, 26, 0]);
        assert_eq!(&image[104..110], b"__text");
        assert_eq!(&image[0x3ffc..], &0xd65f03c0u32.to_le_bytes());
    }
}
