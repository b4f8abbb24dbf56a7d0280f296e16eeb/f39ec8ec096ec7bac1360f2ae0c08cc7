//! In-memory orchestration of nxkit's unmodified split, job and compiler APIs.
use super::{J, Result, bytes, dumps, field, file, list, parse, safe_name, text};
use nxb_split::{jobs, records, scanfile, shaders, src, unity, zstd};
use nxb_xlate::msl::{self, StageInputs};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const INPUT_LIMIT: usize = 256 * 1024 * 1024;
const SHADER_LIMIT: usize = 20000;

struct Owned(Vec<u8>);
impl src::Src for Owned {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn bytes(&self) -> Option<&[u8]> {
        Some(&self.0)
    }
    fn read_at(
        &self,
        offset: u64,
        data: &mut [u8],
    ) -> std::result::Result<(), nxb_split::SplitError> {
        src::Mem(&self.0).read_at(offset, data)
    }
}
struct Work {
    job: nxb_xlate::job::Job,
    code: Vec<u8>,
    source: String,
    no_facts: bool,
}
fn work(value: &J, code: Vec<u8>, source: String) -> Result<Work> {
    let job = nxb_xlate::job::parse_jobs(&dumps(&J::List(vec![value.clone()])))?
        .into_iter()
        .next()
        .ok_or("missing shader job")?;
    safe_name(&job.key)?;
    Ok(Work {
        job,
        code,
        source,
        no_facts: value.get("no_facts") == Some(&J::Bool(true)),
    })
}

pub(super) fn explicit(input: &J) -> Result<J> {
    let entries = list(field(input, "jobs")?)?;
    if entries.len() > SHADER_LIMIT {
        return Err("too many shader jobs".into());
    }
    let mut total = 0usize;
    let mut jobs = Vec::new();
    for entry in entries {
        let code = bytes(field(entry, "code")?)?;
        total = total
            .checked_add(code.len())
            .ok_or("shader size overflow")?;
        if total > INPUT_LIMIT {
            return Err("shader inputs exceed 256 MiB".into());
        }
        jobs.push(work(field(entry, "job")?, code, "explicit".into())?);
    }
    compile(jobs, &BTreeSet::new(), Vec::new(), Vec::new())
}

pub(super) fn discover(input: &J) -> Result<J> {
    let profile = shaders::Profile::default();
    let mut results = Vec::new();
    let mut notes = Vec::new();
    let mut common = None;
    let mut total = 0usize;
    for module in list(field(input, "modules")?)? {
        let name = text(module, "name")?;
        safe_name(name)?;
        let nso = bytes(field(module, "data")?)?;
        // Bound NSO expansion before upstream allocates its memory image.
        let end = (0..3)
            .map(|i| {
                let at = 0x14 + i * 16;
                let get = |o| {
                    nso.get(o..o + 4)
                        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as u64)
                };
                get(at)
                    .zip(get(at + 4))
                    .map(|(a, b)| a + b)
                    .ok_or("truncated NSO")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(0);
        if end > INPUT_LIMIT as u64 {
            return Err("NSO shader scan exceeds 256 MiB".into());
        }
        let image = nxb_split::nso::image(&nso).map_err(|e| format!("{name}: {e}"))?;
        if name == "main" {
            common = unity::bundle::common_strings(&image).ok();
        }
        let mut found = Vec::new();
        let mut variations = shaders::BahsVar::new();
        shaders::scan_blob(&image, name, &mut found, &mut variations, 0)
            .map_err(|e| e.to_string())?;
        found
            .extend(nxb_split::misc::main_extras(&image, name, &found).map_err(|e| e.to_string())?);
        let pairs = shaders::var_pairs(&profile, &found, &variations);
        results.push(records::FileResult {
            keys: records::uniq(&profile, found, true).map_err(|e| e.to_string())?,
            pairs,
            ..Default::default()
        });
    }
    let mut files = Vec::new();
    let resources = list(field(input, "files")?)?;
    if resources.len() > 20000 {
        return Err("too many shader source files".into());
    }
    for entry in resources {
        let rel = text(entry, "path")?;
        let data = bytes(field(entry, "data")?)?;
        total = total
            .checked_add(data.len())
            .ok_or("shader source size overflow")?;
        if total > INPUT_LIMIT {
            return Err("shader source files exceed 256 MiB".into());
        }
        files.push(jobs::File {
            rel: rel.into(),
            live: jobs::deferred(rel, &data[..data.len().min(16)]),
            src: Arc::new(Owned(data)),
        });
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut dicts = zstd::Dicts::new();
    for file in &files {
        let raw = file.src.bytes().unwrap();
        if raw.starts_with(&[0x37, 0xa4, 0x30, 0xec]) {
            dicts.add(raw).map_err(|e| e.to_string())?;
        } else if file.rel == "Pack/ZsDic.pack.zs" {
            let pack = zstd::decompress(raw).map_err(|e| e.to_string())?;
            for (_, data) in shaders::sarc_members(&pack, &file.rel).map_err(|e| e.to_string())? {
                if data.starts_with(&[0x37, 0xa4, 0x30, 0xec]) {
                    dicts.add(data).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let plan = jobs::plan(&files).map_err(|e| e.to_string())?;
    notes.extend(plan.notes);
    let ctx = jobs::Ctx {
        files: &files,
        dicts: &dicts,
    };
    for job in plan.jobs {
        let out = (job.run)(&ctx, &mut notes).map_err(|e| format!("{}: {e}", job.rel))?;
        if let Some(result) =
            scanfile::finish(&profile, out.found, &out.var).map_err(|e| e.to_string())?
        {
            results.push(result);
        }
    }
    let env = scanfile::Env {
        dicts: &dicts,
        common: common.as_ref(),
        trees: None,
    };
    let mut deferred = Vec::new();
    let mut plain = Vec::new();
    let mut trees = unity::ser::Trees::new();
    for (i, file) in files.iter().enumerate() {
        if plan.taken.contains(&i) {
            continue;
        }
        let label = format!("/{}", file.rel);
        let raw = file.src.bytes().unwrap();
        let result = if file.live && raw.starts_with(&jobs::nlg::DICT) {
            let (found, var) = jobs::nlg::shaders(&files, i, &label).map_err(|e| e.to_string())?;
            scanfile::finish(&profile, found, &var)
        } else if file.live && jobs::nlg::covered(&file.rel, &files) {
            Ok(None)
        } else {
            scanfile::scan_file(
                &profile,
                file.src.as_ref(),
                &label,
                &file.rel,
                &env,
                &mut notes,
            )
        }
        .map_err(|e| format!("{}: {e}", file.rel))?;
        if let Some(result) = result {
            trees.extend(result.trees.clone());
            if result.defer {
                deferred.push(i);
            } else {
                plain.push((i, result));
            }
        }
    }
    if !deferred.is_empty() {
        for (key, value) in unity::ser::known_trees().map_err(|e| e.to_string())? {
            trees.entry(key).or_insert(value);
        }
        let env = scanfile::Env {
            trees: Some(&trees),
            ..env
        };
        for i in deferred {
            let file = &files[i];
            let result = scanfile::scan_file(
                &profile,
                file.src.as_ref(),
                &format!("/{}", file.rel),
                &file.rel,
                &env,
                &mut notes,
            )
            .map_err(|e| format!("{}: {e}", file.rel))?;
            if let Some(result) = result {
                if result.defer {
                    return Err(format!("{}: missing Unity shader type trees", file.rel));
                }
                plain.push((i, result));
            }
        }
    }
    // Deferred Unity scans keep their original file order at the merge.
    plain.sort_by_key(|(i, _)| *i);
    results.extend(plain.into_iter().map(|(_, result)| result));
    let output = records::build(&profile, &results).map_err(|e| e.to_string())?;
    if output.rows.len() > SHADER_LIMIT {
        return Err("too many discovered shaders".into());
    }
    let mut jobs = Vec::new();
    let mut offsets = BTreeMap::new();
    for (package, index, _, key, _) in &output.rows {
        let start = *offsets.entry(package).or_insert(0usize);
        let raw = &output.packages[package][start..];
        let rd = |at| u32::from_le_bytes(raw[at..at + 4].try_into().unwrap()) as usize;
        let end = 0x38 + rd(0x28) + rd(0x2c);
        let fact = output
            .facts
            .get(key)
            .map(|s| parse(s).map_err(|e| format!("{e:?}")))
            .transpose()?;
        let job = nxb_shader::job::job_for(
            key,
            package,
            &raw[..end],
            fact.as_ref(),
            "",
            Default::default(),
        )
        .map_err(|e| e.to_string())?;
        notes.extend(job.notes);
        jobs.push(work(&job.json, job.code, format!("{package}#{index}"))?);
        offsets.insert(package, start + end);
    }
    let pairs_text = |pairs: &BTreeSet<(String, String)>| {
        pairs
            .iter()
            .map(|(a, b)| format!("{a}\t{b}\n"))
            .collect::<String>()
    };
    let map = output
        .rows
        .iter()
        .map(|(p, i, s, k, src)| format!("{p}\t{i}\t{s}\t{k}\t{src}\n"))
        .collect::<String>();
    let facts = output
        .facts
        .iter()
        .map(|(k, v)| format!("{k}\t{v}\n"))
        .collect::<String>();
    let tables = vec![
        file("shaders/shader_map.tsv", map.as_bytes()),
        file("shaders/shader_facts.tsv", facts.as_bytes()),
        file(
            "shaders/shader_pairs.tsv",
            pairs_text(&output.pairs).as_bytes(),
        ),
        file(
            "shaders/pso_pairs.tsv",
            pairs_text(&output.pso_pairs).as_bytes(),
        ),
    ];
    let pairs = output.pairs.union(&output.pso_pairs).cloned().collect();
    compile(jobs, &pairs, tables, notes)
}

fn compile(
    mut jobs: Vec<Work>,
    pairs: &BTreeSet<(String, String)>,
    mut files: Vec<J>,
    notes: Vec<String>,
) -> Result<J> {
    let count = jobs.len();
    let mut seen = BTreeSet::new();
    for entry in &jobs {
        if !seen.insert(&entry.job.key) {
            return Err(format!("duplicate shader key {}", entry.job.key));
        }
    }
    // Fragment inputs must be known before their vertex/mesh partners translate.
    jobs.sort_by(|a, b| (a.job.stage != "ps", &a.job.key).cmp(&(b.job.stage != "ps", &b.job.key)));
    let chain = nxb_shader::chain::standalone_version();
    let mut inputs = BTreeMap::<String, StageInputs>::new();
    for entry in jobs {
        let key = &entry.job.key;
        let partners = pairs
            .iter()
            .filter(|(v, _)| v == key)
            .filter_map(|(_, p)| inputs.get(p).cloned())
            .collect::<Vec<_>>();
        let ctx = msl::Context {
            chain: &chain,
            source: entry.source,
            partners: &partners,
            no_facts: entry.no_facts,
            ..Default::default()
        };
        let translated = msl::translate(&entry.job, &entry.code, &ctx)
            .map_err(|e| format!("shader {key}: {}: {}", e.reason, e.detail))?;
        inputs.insert(key.clone(), translated.inputs);
        for lib in translated.libraries {
            let stem = format!("shaders/{key}{}", lib.suffix);
            let mut metallib = air_front::build_raw(lib.msl.as_bytes(), &air_front::Target::ios())
                .map_err(|e| format!("shader {key}{} compilation: {e:?}", lib.suffix))?;
            if lib.suffix == "_b"
                && let Some(side) = &translated.side
            {
                let names = side
                    .alpha
                    .iter()
                    .chain(&side.logic)
                    .cloned()
                    .collect::<Vec<_>>();
                if !names.is_empty() {
                    let (base, side) =
                        nxb_shader::side::cut(&metallib, &names).map_err(|e| e.to_string())?;
                    metallib = base;
                    files.push(file(format!("shaders/{key}_bx.metallib"), &side));
                }
            }
            files.push(file(format!("{stem}.metal"), lib.msl.as_bytes()));
            files.push(file(format!("{stem}.metallib"), &metallib));
            if let Some(reflection) = lib.reflection {
                files.push(file(
                    format!("{stem}.json"),
                    dumps(&reflection.to_value()).as_bytes(),
                ));
            }
        }
    }
    Ok(J::obj([
        ("files", J::List(files)),
        ("count", J::Int(count as i64)),
        ("warnings", J::List(notes.into_iter().map(J::str).collect())),
    ]))
}
