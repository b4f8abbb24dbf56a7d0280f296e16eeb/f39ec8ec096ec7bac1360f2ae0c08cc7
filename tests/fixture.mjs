// Authored structural samples, never game data or an installable application.
export function sample() {
  const buf = (n) => {
    const data = new Uint8Array(n),
      v = new DataView(data.buffer);
    return {
      data,
      u32: (at, x) => v.setUint32(at, x, true),
      u64: (at, x) => v.setBigUint64(at, BigInt(x), true),
      str: (at, x) => data.set(new TextEncoder().encode(x), at),
    };
  };
  const host = buf(4096);
  [0xfeedfacf, 0x100000c, 0, 2, 3, 248, 0x200085].forEach((x, i) => host.u32(i * 4, x));
  host.u32(32, 0x19);
  host.u32(36, 152);
  host.str(40, "__TEXT");
  host.u64(56, 0x100000000);
  host.u64(64, 4096);
  host.u64(80, 4096);
  host.u32(88, 7);
  host.u32(92, 5);
  host.u32(96, 1);
  host.str(104, "__text");
  host.str(120, "__TEXT");
  host.u64(136, 0x100000400);
  host.u64(144, 4);
  host.u32(152, 1024);
  host.u32(156, 2);
  host.u32(168, 0x80000400);
  host.u32(184, 0x19);
  host.u32(188, 72);
  host.str(192, "__LINKEDIT");
  host.u64(208, 0x100001000);
  host.u64(224, 4096);
  host.u32(240, 7);
  host.u32(244, 1);
  [0x32, 24, 2, 26 << 16, 26 << 16, 0].forEach((x, i) => host.u32(256 + i * 4, x));
  host.u32(1024, 0xd65f03c0);
  const nso = buf(0x5100);
  nso.str(0, "NSO0");
  nso.data.fill(1, 0x40, 0x50);
  for (let i = 0; i < 3; i++) {
    const offset = [0, 0x1000, 0x4000][i],
      size = [0x1000, 0x3000, 0x1000][i];
    nso.u32(0x10 + i * 16, 0x100 + offset);
    nso.u32(0x14 + i * 16, offset);
    nso.u32(0x18 + i * 16, size);
    nso.u32(0x60 + i * 4, size);
  }
  nso.u32(0x3c, 0x1000);
  for (let at = 0x100; at < 0x1100; at += 4) nso.u32(at, 0xd503201f);
  nso.u32(0x100, 0x14000010);
  nso.u32(0x104, 0x1000);
  nso.u32(0x140, 0xd4000541);
  nso.u32(0x144, 0xd65f03c0);
  nso.str(0x1100, "MOD0");
  nso.u32(0x1104, 0x40);
  nso.u32(0x1110, 0x180);
  nso.data.set([1, 3, 3, 3], 0x1280);
  [
    [4, 0x1200],
    [5, 0x1300],
    [6, 0x1240],
    [0, 0],
  ].forEach(([tag, value], i) => {
    nso.u64(0x1140 + i * 16, tag);
    nso.u64(0x1148 + i * 16, value);
  });
  nso.u32(0x1304, 1);
  const npdm = buf(0xc4);
  npdm.str(0, "META");
  npdm.data[0xe] = 44;
  npdm.u32(0x14, 0x10000);
  npdm.u32(0x1c, 0x100000);
  npdm.u32(0x70, 0x80);
  npdm.u32(0x74, 0x44);
  npdm.str(0x80, "ACI0");
  npdm.u64(0x90, 0x0100000000000000n);
  npdm.u32(0xb0, 0x40);
  npdm.u32(0xb4, 4);
  npdm.u32(0xc0, 7 | (63 << 4) | (2 << 24));
  const code = buf(24);
  code.u64(8, 0xe30000000007000fn);
  return {
    template: {
      name: "Sample.app",
      files: [
        { path: "Sample", data: host.data, executable: true },
        {
          path: "Info.plist",
          data: new TextEncoder().encode(
            '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.sample</string><key>CFBundleExecutable</key><string>Sample</string><key>CFBundleVersion</key><string>1</string></dict></plist>',
          ),
        },
      ],
    },
    profile: { titleId: "0100000000000000", name: "Authored sample", services: ["kernel"] },
    modules: [{ name: "main", data: nso.data }],
    npdm: npdm.data,
    resources: [{ path: "romfs/message.txt", data: new TextEncoder().encode("authored resource") }],
    shaders: [
      {
        job: {
          key: "0102030405060708",
          stage: "cs",
          c1: "",
          debug: true,
          reduced: false,
          tex: {},
          img: {},
          attr: {},
          fout: {},
          local: [1, 1, 1],
          shared: 0,
        },
        code: code.data,
      },
    ],
  };
}

// Minimal authored BNSH containing one Maxwell compute EXIT program.
export function shaderContainer(code = sample().shaders[0].code) {
  const data = new Uint8Array(0x9c0 + code.length), view = new DataView(data.buffer);
  const u32 = (at, n) => view.setUint32(at, n, true);
  const u64 = (at, n) => view.setBigUint64(at, BigInt(n), true);
  data.set(new TextEncoder().encode("BNSH"));
  data.set(new TextEncoder().encode("grsc"), 0x60);
  u32(0x7c, 1); u64(0x80, 0x90); u64(0xa0, 0xd0);
  u64(0xd0 + 8 + 8 * 5, 0x120);
  u64(0x128, 0x140); u64(0x130, 0x9c0);
  u32(0x138, code.length); u32(0x13c, 0x880);
  u32(0x140, 0x98761234); u32(0x160, 0x880);
  u32(0x840, code.length); u32(0x844, code.length);
  for (const at of [0x888, 0x88c, 0x890]) u32(at, 1);
  data.set(code, 0x9c0);
  return data;
}

// One paired graphics program, including a fragment colour output for _bx.
export function graphicsShaderContainer() {
  const data = new Uint8Array(0x200 + 2 * (0x880 + 0x98));
  const view = new DataView(data.buffer);
  const u32 = (at, n) => view.setUint32(at, n, true);
  const u64 = (at, n) => view.setBigUint64(at, BigInt(n), true);
  data.set(new TextEncoder().encode("BNSH"));
  data.set(new TextEncoder().encode("grsc"), 0x60);
  u32(0x7c, 1); u64(0x80, 0x90); u64(0xa0, 0xd0);
  for (const [i, stage] of [0, 4].entries()) {
    const descriptor = 0x120 + i * 0x20, control = 0x200 + i * (0x880 + 0x98), code = control + 0x880;
    u64(0xd0 + 8 + 8 * stage, descriptor);
    u64(descriptor + 8, control); u64(descriptor + 16, code);
    u32(descriptor + 24, 0x98); u32(descriptor + 28, 0x880);
    u32(control, 0x98761234); u32(control + 0x20, 0x880);
    u32(control + 0x700, 0x98); u32(control + 0x704, 0x98);
    u32(code, 0x12345678); u32(code + 0x30, ((stage + 1) << 10) | 1);
    if (stage === 4) u32(code + 0x30 + 18 * 4, 15);
    u64(code + 0x88, 0xe30000000007000fn);
  }
  return data;
}

export async function signingFixture(bundleId = "org.example.sample") {
  if (!/^(?:[A-Za-z0-9-]+\.)*(?:[A-Za-z0-9-]+|\*)$/.test(bundleId)) throw new Error("Invalid test bundle ID");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "nx2ipa-test-"));
  const command = (args) => {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  try {
    // Public issuer name exercises zsign's certificate branch, but these new
    // ephemeral keys and certificates are NOT Apple-issued or trusted.
    command([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Apple Worldwide Developer Relations Certification Authority/OU=G3/O=Apple Inc./C=US",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ]);
    command([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Sample Test Only/OU=TEST123456",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    ]);
    command([
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      "leaf.pem",
    ]);
    command([
      "pkcs12",
      "-export",
      "-inkey",
      "leaf.key",
      "-in",
      "leaf.pem",
      "-certfile",
      "ca.pem",
      "-passout",
      "pass:test-only",
      "-out",
      "identity.p12",
    ]);
    command(["x509", "-in", "leaf.pem", "-outform", "DER", "-out", "leaf.der"]);
    const cert = (await readFile(join(directory, "leaf.der"))).toString("base64");
    await writeFile(
      join(directory, "profile.plist"),
      `<plist version="1.0"><dict><key>TeamIdentifier</key><array><string>TEST123456</string></array><key>ApplicationIdentifierPrefix</key><array><string>TEST123456</string></array><key>DeveloperCertificates</key><array><data>${cert}</data></array><key>ExpirationDate</key><date>${new Date(Date.now() + 86400000).toISOString()}</date><key>Entitlements</key><dict><key>application-identifier</key><string>TEST123456.${bundleId}</string><key>com.apple.developer.team-identifier</key><string>TEST123456</string><key>get-task-allow</key><true/><key>keychain-access-groups</key><array><string>TEST123456.*</string><string>TEST123456.shared</string></array></dict></dict></plist>`,
    );
    command([
      "cms",
      "-sign",
      "-binary",
      "-nodetach",
      "-in",
      "profile.plist",
      "-signer",
      "leaf.pem",
      "-inkey",
      "leaf.key",
      "-outform",
      "DER",
      "-out",
      "profile.mobileprovision",
    ]);
    return {
      identity: new Uint8Array(await readFile(join(directory, "identity.p12"))),
      profile: new Uint8Array(await readFile(join(directory, "profile.mobileprovision"))),
      password: "test-only",
      async verify(image) {
        const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
        let at = 32,
          signature;
        for (let i = 0; i < v.getUint32(16, true); i++) {
          if (v.getUint32(at, true) === 0x1d) signature = v.getUint32(at + 8, true);
          at += v.getUint32(at + 4, true);
        }
        if (!signature) throw new Error("Missing code signature");
        const blobs = new Map();
        for (let i = 0; i < v.getUint32(signature + 8); i++) {
          const row = signature + 12 + i * 8,
            offset = signature + v.getUint32(row + 4);
          blobs.set(v.getUint32(row), image.slice(offset, offset + v.getUint32(offset + 4)));
        }
        await writeFile(join(directory, "cd.bin"), blobs.get(0));
        await writeFile(join(directory, "cms.der"), blobs.get(0x10000).slice(8));
        command([
          "cms",
          "-verify",
          "-binary",
          "-inform",
          "DER",
          "-in",
          "cms.der",
          "-content",
          "cd.bin",
          "-noverify",
          "-out",
          "verified.bin",
        ]);
        // Verify that both entitlement blobs are covered by the signed CodeDirectory.
        const { createHash } = await import("node:crypto");
        const cd = new DataView(blobs.get(0).buffer), hashOffset = cd.getUint32(16);
        for (const slot of [5, 7]) if (blobs.has(slot)) {
          const expected = blobs.get(0).subarray(hashOffset - slot * 32, hashOffset - (slot - 1) * 32);
          if (!createHash("sha256").update(blobs.get(slot)).digest().equals(expected))
            throw new Error("Entitlements are not covered by the CodeDirectory");
        }
        return { xml: new TextDecoder().decode(blobs.get(5)?.subarray(8)), der: blobs.get(7)?.subarray(8) };
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// The same small integration contract runs against the identical ESM in both hosts.
export async function exercise(run) {
  const assert = (await import("node:assert/strict")).default;
  const { unzipSync } = await import("fflate");
  const { exerciseContainers } = await import("./containers.mjs");
  await exerciseContainers(run, sample());
  const request = sample(),
    caller = structuredClone(request),
    pending = run(caller);
  assert.deepEqual(caller, request); // Caller buffers remain attached and unchanged.
  caller.modules[0].data.fill(0);
  caller.profile.name = "Changed after dispatch";
  const unsigned = await pending;
  const files = unzipSync(unsigned.ipa),
    root = "Payload/Sample.app/";
  assert.equal(unsigned.signed, false);
  assert.equal(unsigned.deviceValidated, false);
  assert.equal(
    new TextDecoder().decode(files[root + "nxkit/romfs/message.txt"]),
    "authored resource",
  );
  assert.ok(Object.keys(files).some((path) => path.endsWith(".metallib")));
  const game = JSON.parse(new TextDecoder().decode(files[root + "game.json"]));
  assert.equal(game.name, request.profile.name); // Metadata is snapshotted with the bytes.
  for (const field of ["image", "imports", "exports", "fixups", "gates"])
    assert.ok(files[root + game.modules[0][field]], field);
  const automatic = { ...request, shaders: undefined,
    resources: [...request.resources, { path: "romfs/shader.bnsh", data: shaderContainer() }] };
  const discovered = await run(automatic);
  assert.equal(discovered.shaderCount, 1);
  const autoFiles = unzipSync(discovered.ipa);
  assert.ok(Object.keys(autoFiles).some((name) => /nxkit\/shaders\/[0-9a-f]{16}_b\.metallib$/.test(name)));
  assert.ok(autoFiles[root + "nxkit/shaders/shader_map.tsv"]);
  // Independent runtime-key oracle: SHA-256(control || original code), 16 hex.
  const { createHash } = await import("node:crypto");
  const bnsh = shaderContainer();
  const key = createHash("sha256").update(bnsh.subarray(0x140, 0x9c0)).update(bnsh.subarray(0x9c0)).digest("hex").slice(0, 16);
  const reference = await run({ ...request, resources: [], shaders: [{
    code: request.shaders[0].code, job: { ...request.shaders[0].job, key, reduced: true },
  }] });
  const referenceFiles = unzipSync(reference.ipa);
  for (const ext of ["metal", "metallib"])
    assert.deepEqual(autoFiles[root + `nxkit/shaders/${key}_b.${ext}`], referenceFiles[root + `nxkit/shaders/${key}_b.${ext}`]);
  const reflection = JSON.parse(new TextDecoder().decode(autoFiles[root + `nxkit/shaders/${key}_b.json`]));
  assert.deepEqual(reflection.threadgroup_size, [1, 1, 1]);
  const moduleWithShader = structuredClone(request.modules[0]);
  moduleWithShader.data.set(shaderContainer(), 0x4100);
  const fromNso = await run({ ...automatic, modules: [moduleWithShader], resources: [] });
  assert.equal(fromNso.shaderCount, 1);
  const nsoFiles = unzipSync(fromNso.ipa);
  assert.match(new TextDecoder().decode(nsoFiles[root + "nxkit/shaders/shader_map.tsv"]), /main#BNSH@0x4000/);
  const duplicate = await run({ ...automatic, resources: [
    ...automatic.resources, { path: "romfs/duplicate.bnsh", data: shaderContainer() },
  ] });
  assert.equal(duplicate.shaderCount, 1);
  const graphics = await run({ ...automatic, resources: [{ path: "romfs/graphics.bnsh", data: graphicsShaderContainer() }] });
  assert.equal(graphics.shaderCount, 2);
  const graphicsFiles = unzipSync(graphics.ipa);
  assert.ok(Object.keys(graphicsFiles).some((name) => name.endsWith("_bx.metallib")));
  assert.match(new TextDecoder().decode(graphicsFiles[root + "nxkit/shaders/shader_pairs.tsv"]), /^[0-9a-f]{16}\t[0-9a-f]{16}\n$/);

  const { zipSync } = await import("fflate");
  const archived = await run({ ...automatic, resources: [{
    path: "romfs/shaders.zip", data: zipSync({ "nested/shader.bnsh": shaderContainer() }),
  }] });
  assert.equal(archived.shaderCount, 1);
  const broken = shaderContainer();
  new DataView(broken.buffer).setBigUint64(0x128, BigInt(broken.length + 1), true);
  await assert.rejects(run({ ...automatic, resources: [{ path: "romfs/broken.bnsh", data: broken }] }), /during shaders/);
  await assert.rejects(run(automatic, { abortAt: "shaders" }), { name: "AbortError" });
  const signing = await signingFixture();
  try {
    const credentials = {
      identity: signing.identity,
      profile: signing.profile,
      password: signing.password,
    };
    const originalCredentials = structuredClone(credentials);
    const result = await run({ ...request, signing: credentials });
    assert.equal(result.signed, true);
    const signed = unzipSync(result.ipa);
    await signing.verify(signed[root + "Sample"]);
    await signing.verify(signed[root + "Frameworks/nxgame.dylib"]);
    await assert.rejects(run({ ...request, signing: { ...credentials, password: "wrong" } }));
    assert.deepEqual(credentials, originalCredentials);
  } finally {
    await signing.dispose();
  }
  const wildcard = await signingFixture("org.example.*");
  try {
    const result = await run({ ...request, signing: wildcard }), signed = unzipSync(result.ipa);
    assert.equal(result.signed, true);
    assert.deepEqual(signed[root + "embedded.mobileprovision"], wildcard.profile);
    const entitlements = await wildcard.verify(signed[root + "Sample"]);
    await wildcard.verify(signed[root + "Frameworks/nxgame.dylib"]);
    assert.match(entitlements.xml, /<key>application-identifier<\/key>\s*<string>TEST123456\.org\.example\.sample<\/string>/);
    assert.match(entitlements.xml, /<string>TEST123456\.shared<\/string>/);
    assert.ok(!entitlements.xml.includes("*"));
    assert.ok(Buffer.from(entitlements.der).includes(Buffer.from("TEST123456.org.example.sample")));
    assert.ok(!Buffer.from(entitlements.der).includes(Buffer.from("TEST123456.*")));
  } finally { await wildcard.dispose(); }
  for (const bundleId of ["org.example.different", "org.other.*"]) {
    const mismatch = await signingFixture(bundleId);
    try {
      await assert.rejects(run({ ...request, signing: mismatch }), /provisioning App ID matching org\.example\.sample/);
    } finally { await mismatch.dispose(); }
  }
  await assert.rejects(run(request, { abortAt: "build" }), { name: "AbortError" });
  await assert.rejects(
    run({
      ...request,
      modules: undefined,
      npdm: undefined,
      nsp: new Uint8Array(16),
      keys: new TextEncoder().encode("header_key = 00"),
    }),
    /during extract/,
  );
  await assert.rejects(
    run({
      template: {
        ...request.template,
        files: [...request.template.files, { path: "../escape", data: new Uint8Array() }],
      },
    }),
  );
  // A small stored NSO can describe a large sparse image. Reject it before
  // the rewriter allocates that image, including with explicit shader jobs.
  const sparse = new Uint8Array(2 * 1024 ** 2);
  sparse.set(request.modules[0].data);
  new DataView(sparse.buffer).setUint32(0x34, 256 * 1024 ** 2, true);
  await assert.rejects(run({ ...request, modules: [{ name: "main", data: sparse }] }),
    /during build\. NSO memory image exceeds 256 MiB/);
  const retried = await run(request);
  assert.deepEqual(retried.ipa, unsigned.ipa);
  console.log(
    "Passed: automatic BNSH/ZIP discovery, runtime shader keys, compute reference byte equality, graphics pairing/side library, malformed shader rejection; build/IPA/signing, host and guest CMS signatures, cancel and retry. No device/gameplay claim.",
  );
}
