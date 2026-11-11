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

export async function signingFixture() {
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
      `<plist version="1.0"><dict><key>TeamIdentifier</key><array><string>TEST123456</string></array><key>ApplicationIdentifierPrefix</key><array><string>TEST123456</string></array><key>DeveloperCertificates</key><array><data>${cert}</data></array><key>ExpirationDate</key><date>${new Date(Date.now() + 86400000).toISOString()}</date><key>Entitlements</key><dict><key>application-identifier</key><string>TEST123456.org.example.sample</string><key>com.apple.developer.team-identifier</key><string>TEST123456</string><key>get-task-allow</key><true/></dict></dict></plist>`,
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
  const retried = await run(request);
  assert.deepEqual(retried.ipa, unsigned.ipa);
  console.log(
    "Passed: real build/shaders/IPA/signing, host and guest CMS signatures, invalid input, cancel and retry. No device/gameplay claim.",
  );
}
