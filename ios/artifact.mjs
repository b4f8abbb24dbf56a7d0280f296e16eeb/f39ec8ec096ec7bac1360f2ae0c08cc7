import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, mkdtemp, rm, rename, writeFile, cp, readdir, chmod } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { command } from '../scripts/source.mjs';
const root = resolve(import.meta.dir, '..');
const sha = data => createHash('sha256').update(data).digest('hex');

/** Read LC_CODE_SIGNATURE; arbitrary codesign failures are not proof of unsigned. */
export function hasMachOSignature(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 32 || b.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected thin little-endian Mach-O');
  const count = b.readUInt32LE(16), end = 32 + b.readUInt32LE(20);
  if (end > b.length) throw new Error('Truncated Mach-O load commands');
  let at = 32, signed = false;
  for (let i = 0; i < count; i++) {
    if (at + 8 > end) throw new Error('Truncated load command');
    const kind = b.readUInt32LE(at), size = b.readUInt32LE(at + 4);
    if (size < 8 || size % 8 || at + size > end) throw new Error('Invalid command size');
    if (kind === 0x1d) {
      if (size !== 16 || signed) throw new Error('Invalid or duplicate signature command');
      const offset = b.readUInt32LE(at + 8), length = b.readUInt32LE(at + 12);
      if (!length || offset < end || offset + length > b.length) throw new Error('Invalid signature range');
      signed = true;
    }
    at += size;
  }
  if (at !== end) throw new Error('Inconsistent command table');
  return signed;
}
async function capture(args) {
  const child = Bun.spawn(args, { cwd: root, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
async function unsignedCopy(binary, target) {
  await cp(binary, target);
  await chmod(target, 0o755);
  let removedAdHocSignature = false;
  if (hasMachOSignature(await readFile(target))) {
    const details = await capture(['codesign', '--display', '--verbose=4', target]);
    if (details.code || !/^Signature=adhoc\s*$/m.test(details.stdout + details.stderr))
      throw new Error('Refusing to remove a signature that is not confirmed ad-hoc');
    await command(['codesign', '--remove-signature', target]);
    removedAdHocSignature = true;
  }
  if (hasMachOSignature(await readFile(target))) throw new Error('The copied test executable remains signed');
  const check = await capture(['codesign', '--display', target]);
  if (check.code === 0 || !/code object is not signed at all/.test(check.stdout + check.stderr))
    throw new Error('codesign did not confirm an unsigned test executable');
  return { removedAdHocSignature, unsigned: true };
}

/** Exact native and dependency sources, with an offline verification object store. */
export async function nativeSourceArchive(destination, adapterNames) {
  const src = join(destination, 'source');
  await mkdir(src, { recursive: true });
  const wanted = ['ios', 'scripts/build-ios.mjs', 'scripts/source.mjs', 'tests/native-build.mjs', 'rust-toolchain.toml', 'nxkit.json', 'THIRD_PARTY_NOTICES.md'];
  const status = await command(['git', 'status', '--porcelain', '--untracked-files=all', '--', ...wanted]);
  if (status) throw new Error('Commit the native source snapshot before packaging a test artifact');
  const tracked = (await command(['git', 'ls-files', '-z', '--', ...wanted])).split('\0').filter(Boolean);
  const sourceFiles = {};
  for (const path of tracked) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('Unexpected source kind: ' + path);
    const bytes = await readFile(join(root, path));
    sourceFiles[path] = sha(bytes);
    await mkdir(dirname(join(src, path)), { recursive: true });
    await writeFile(join(src, path), bytes);
  }
  const pin = JSON.parse(await readFile(join(root, 'nxkit.json')));
  const git = join(root, '.build/nxkit.git');
  const archive = join(destination, 'nxkit-source.tar');
  await command(['git', '-C', git, 'archive', '--format=tar', '--output=' + archive, pin.commit]);
  const upstream = join(src, '.build/nxkit');
  await mkdir(upstream, { recursive: true });
  await command(['tar', '-xf', archive, '-C', upstream]);
  await rm(archive);
  // Check all path-dependency source files, not only platform-adapter inputs.
  const blobs = (await command(['git', '-C', git, 'ls-tree', '-r', pin.commit])).split('\n').filter(Boolean);
  for (const line of blobs) {
    const [mode, kind, oid, path] = line.split(/[ \t]+/);
    if (kind !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Unexpected upstream source kind: ' + path);
    const bytes = await readFile(join(root, '.build/nxkit', path));
    const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    if (hash !== oid) throw new Error('Compiled upstream source differs from pin: ' + path);
  }
  // Never copy repository credentials, config or hooks. This is a local fetch.
  const snapshotGit = join(src, '.build/nxkit.git');
  await command(['git', 'init', '--bare', snapshotGit]);
  await command(['git', '-C', snapshotGit, 'fetch', '--depth=1', '--no-tags', 'file://' + git, pin.commit]);
  if (await command(['git', '-C', snapshotGit, 'rev-parse', pin.commit + '^{tree}']) !== pin.tree)
    throw new Error('Packaged upstream source identity mismatch');
  await rm(join(snapshotGit, 'FETCH_HEAD'));
  await rm(join(snapshotGit, 'hooks'), { recursive: true, force: true });
  await mkdir(join(src, '.cargo'), { recursive: true });
  const config = await command(['cargo', 'vendor', '--locked', '--offline', '--versioned-dirs', '--manifest-path', 'ios/Cargo.toml', 'vendor'], src);
  await writeFile(join(src, '.cargo/config.toml'), config + '\n');
  const metadata = JSON.parse(await command(['cargo', 'metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'ios/Cargo.toml'], src));
  // Cargo's Git vendoring copies crate subdirectories but can omit monorepo
  // root licenses (notably objc2). Include the exact pinned root notices too.
  const originalMetadata = JSON.parse(await command(['cargo', 'metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'ios/Cargo.toml']));
  const gitNotices = {};
  for (const pkg of originalMetadata.packages) {
    if (!pkg.source?.startsWith('git+') || gitNotices[pkg.source]) continue;
    const revision = pkg.source.split('#').at(-1);
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Unpinned native Git dependency');
    const repository = await command(['git', '-C', dirname(pkg.manifest_path), 'rev-parse', '--show-toplevel']);
    if (await command(['git', '-C', repository, 'rev-parse', 'HEAD']) !== revision)
      throw new Error('Native Git dependency revision differs from Cargo.lock');
    const names = (await command(['git', '-C', repository, 'ls-tree', '--name-only', revision]))
      .split('\n').filter(name => /^(COPYRIGHT|LICENSE|COPYING|NOTICE|licenses)/i.test(name));
    if (!names.length) throw new Error('Git dependency has no root license/notice: ' + pkg.source);
    const relativeDirectory = 'git-source-notices/' + sha(pkg.source).slice(0, 16);
    const directory = join(src, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const noticesTar = join(destination, 'git-notices.tar');
    await command(['git', '-C', repository, 'archive', '--format=tar', '--output=' + noticesTar, revision, ...names]);
    await command(['tar', '-xf', noticesTar, '-C', directory]);
    await rm(noticesTar);
    gitNotices[pkg.source] = { revision, directory: relativeDirectory, files: names };
  }
  await writeFile(join(src, 'GIT_SOURCE_NOTICES.json'), JSON.stringify(gitNotices, null, 2) + '\n');
  await writeFile(join(src, 'CARGO_LICENSES.json'), JSON.stringify(metadata.packages.map(p => ({
    name: p.name, version: p.version, license: p.license, licenseFile: p.license_file,
    source: p.source, repository: p.repository, directory: relative(src, dirname(p.manifest_path)),
    gitRootNotices: gitNotices[p.source]?.directory ?? null,
  })), null, 2) + '\n');
  const sysroot = await command(['rustc', '--print', 'sysroot']);
  const rustNotices = join(sysroot, 'share/doc/rust');
  await mkdir(join(src, 'toolchain-notices'));
  let notices = 0;
  for (const name of await readdir(rustNotices)) {
    if (!/^(COPYRIGHT|LICENSE|licenses)/.test(name)) continue;
    await cp(join(rustNotices, name), join(src, 'toolchain-notices', name), { recursive: true });
    notices++;
  }
  if (!notices) throw new Error('Rust redistribution notices missing');
  const provenance = { schema: 1, commit: await command(['git', 'rev-parse', 'HEAD']),
    rust: await command(['rustc', '-Vv']), cargo: await command(['cargo', '-V']),
    rustflags: process.env.RUSTFLAGS ?? '', deploymentTarget: process.env.IPHONEOS_DEPLOYMENT_TARGET ?? '', nxkit: pin, files: sourceFiles };
  await mkdir(join(src, 'provenance'));
  for (const name of adapterNames)
    await cp(join(root, '.build/ios', name, 'source.json'), join(src, 'provenance', name + '.json'));
  await writeFile(join(src, 'NATIVE_SOURCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  await writeFile(join(src, 'BUILD_NATIVE.txt'), [
    'Exact corresponding native source for the unsigned nx2ipa test host.',
    'Requires preinstalled Bun, Rust 1.99.0 with aarch64-apple-ios and the repository wasm32 target, and macOS/Xcode with an iPhoneOS SDK. Apple SDKs are not redistributed.',
    'Cargo dependency sources are in vendor/; additional pinned Git monorepo licenses are in git-source-notices/ and mapped by CARGO_LICENSES.json. Exact nxkit source and GPL/third-party notices are in .build/nxkit/. Rust redistribution notices are in toolchain-notices/.',
    'From this directory: CARGO_NET_OFFLINE=true bun scripts/build-ios.mjs --link-check',
    'Do not run source.mjs: exact source and verification objects are already included.',
    'Portable contract check: RUSTFLAGS="--cap-lints warn" cargo run --offline --manifest-path ios/Cargo.toml -p nx2ipa-ios-host --example validate_bundle -- /absolute/path/Game.app',
    'This validates packaged paths, module segments and guest headers, not signing trust, execution or gameplay.',
  ].join('\n\n') + '\n');
  const archivePath = join(destination, 'native-source.tar.gz');
  await command(['tar', '-czf', archivePath, '-C', src, '.']);
  await rm(src, { recursive: true });
  return { file: 'native-source.tar.gz', sha256: sha(await readFile(archivePath)), provenance };
}

export async function createTestArtifact(binary, evidence, adapterNames, verify) {
  const output = join(root, '.build/ios/test');
  const stage = await mkdtemp(join(dirname(output), '.test-'));
  try {
    const app = join(stage, 'Nx2ipa.app');
    await mkdir(app);
    const signing = await unsignedCopy(binary, join(app, 'nx2ipa'));
    await cp(join(root, 'ios/Info.plist'), join(app, 'Info.plist'));
    await command(['plutil', '-lint', join(app, 'Info.plist')]);
    const build = await command(['xcrun', 'vtool', '-show-build', join(app, 'nx2ipa')]);
    const libraries = await command(['otool', '-L', join(app, 'nx2ipa')]);
    const arch = await command(['lipo', '-archs', join(app, 'nx2ipa')]);
    verify(arch, build, libraries);
    const source = await nativeSourceArchive(stage, adapterNames);
    const receipt = {
      schema: 1, kind: 'unsigned-native-test-host', appName: 'Nx2ipa.app', executable: 'nx2ipa',
      runtimeReady: false, sdkLinked: true, unsigned: true, deviceValidated: false,
      gameplayValidated: false, bundleContractValidated: false, syntheticSigningValidated: false, containsGame: false,
      removedAdHocSignature: signing.removedAdHocSignature,
      binarySha256: sha(await readFile(join(app, 'nx2ipa'))),
      infoPlistSha256: sha(await readFile(join(app, 'Info.plist'))),
      source: { file: source.file, sha256: source.sha256, commit: source.provenance.commit, nxkit: source.provenance.nxkit },
      buildEvidence: { architecture: arch, build, libraries, original: evidence },
      warnings: [
        'Experimental test host: installation, guest execution and gameplay are unverified.',
        'No game or credentials are included. Host and generated guest library need valid device signing/provisioning before installation.',
        'iOS memory/address-space limits, GPU/codec capabilities, shader coverage, input/audio and suspend/resume remain unverified.',
        'Keep exact source/notices with redistribution. This receipt does not satisfy the production host gate.',
      ],
    };
    await writeFile(join(stage, 'host-test.json'), JSON.stringify(receipt, null, 2) + '\n');
    await writeFile(join(stage, 'README.txt'), [
      'Unsigned native test host, not a production-ready or playable game.',
      'Nx2ipa.app contains the real SDK-linked runtime and Info.plist only. Add generated game assets using the converter; do not invent game files.',
      'The copied host is verified unsigned. Installation requires valid signing/provisioning of the complete app and guest dylib.',
      'No device, guest boot, rendering or gameplay test has run. See host-test.json for hashes and exact SDK evidence.',
      'native-source.tar.gz contains exact native/third-party sources, licenses and offline rebuild instructions. Keep it with this artifact.',
    ].join('\n') + '\n');
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
    return output;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
