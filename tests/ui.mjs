import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Isolate view behavior from conversion. Production builds use the real API;
// tests/browser.mjs separately exercises that unchanged release ESM and worker.
const mock = `
  globalThis.conversions = [];
  export const capabilities = { embeddedHost: globalThis.testEmbeddedHost !== false, experimental: globalThis.testExperimental !== false };
  export function createIpa(request, options) {
    return new Promise((resolve, reject) => {
      conversions.push({ request, options, resolve, reject });
    });
  }
`;
const bundle = await Bun.build({
  entrypoints: [new URL("../src/app.js", import.meta.url).pathname],
  format: "iife", target: "browser", write: false,
  plugins: [{ name: "mock-converter", setup(build) {
    build.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: "mock-converter", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: mock, loader: "js" }));
  } }],
});
assert.equal(bundle.success, true, bundle.logs.join("\n"));
const directory = await mkdtemp(join(tmpdir(), "nx2ipa-ui-"));
let browser;
try {
  // Read asynchronously without introducing network loads into the document.
  let html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const path of ["node_modules/basecoat-css/dist/basecoat.cdn.min.css", "src/app.css"]) {
    const css = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    html = html.replace(`<link rel="stylesheet" href="./${path}" />`, () => `<style>${css}</style>`);
  }
  const script = (await bundle.outputs[0].text()).replace(/<\/script/gi, "<\\/script");
  html = html.replace('<script type="module" src="./src/app.js"></script>', () => `<script>${script}</script>`);
  await writeFile(join(directory, "index.html"), html);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [], network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.route(/^https?:/, (route) => route.abort());
  await page.addInitScript(() => {
    globalThis.revoked = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { revoked.push(url); original(url); };
  });
  await page.goto(pathToFileURL(join(directory, "index.html")).href);
  const drop = async (files) => {
    const transfer = await page.evaluateHandle((files) => {
      const transfer = new DataTransfer();
      for (const [name, data] of files) transfer.items.add(new File([data], name));
      return transfer;
    }, files);
    await page.locator("#dropzone").dispatchEvent("dragenter", { dataTransfer: transfer });
    assert.equal(await page.locator("#dropzone").getAttribute("data-dragging"), "true");
    await page.locator("#dropzone").dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
  };
  const settle = async (index, result = {}) => {
    await page.evaluate(({ index, result }) => conversions[index].resolve({
      ipa: new Uint8Array([80, 75, 1, 2]), signed: false, deviceValidated: false,
      name: "Example", warnings: ["Synthetic test archive."], ...result,
    }), { index, result });
    await page.waitForFunction(() => document.getElementById("form").getAttribute("aria-busy") === "false");
  };
  const calls = async (count) => page.waitForFunction((count) => conversions.length === count, count);

  assert.equal(await page.locator("#experimental-notice").isVisible(), true);
  assert.equal(await page.locator("#runtime-notice").isVisible(), false);
  assert.match(await page.locator("#experimental-notice").textContent(), /real gameplay have not been verified/);
  assert.match(await page.locator("#experimental-notice").textContent(), /valid Apple signing identity/);
  assert.equal(await page.locator("#build-kind").textContent(), "Experimental");
  assert.equal(await page.locator("input[type=file]").count(), 3);
  assert.equal(await page.locator("#template,#profile,#shaders").count(), 0);
  assert.equal(await page.locator("#build").isDisabled(), true);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#dropzone").focus();
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "Example.nsp", mimeType: "application/octet-stream", buffer: Buffer.from("game") });
  assert.equal(await page.locator("#game-name").textContent(), "Example.nsp");
  assert.equal(await page.locator("#build").isDisabled(), true);
  await drop([["prod.keys", "test-only"]]);
  assert.equal(await page.locator("#build").isDisabled(), false);
  await drop([["First.nsp", "one"], ["Second.xci", "two"]]);
  assert.match(await page.locator("#status").textContent(), /one game/);
  assert.equal(await page.locator("#game-name").textContent(), "Example.nsp");
  await drop([["invalid.json", "{}"], ["Replace.nsp", "replacement"]]);
  assert.match(await page.locator("#status").textContent(), /Other files/);
  assert.equal(await page.locator("#game-name").textContent(), "Example.nsp");
  await drop([["empty.xci", ""]]);
  assert.match(await page.locator("#status").textContent(), /empty/);

  await page.locator("#build").click();
  await calls(1);
  await page.locator("#form").dispatchEvent("submit");
  assert.equal(await page.evaluate(() => conversions.length), 1);
  assert.equal(await page.evaluate(() => conversions[0].request.nsp instanceof File), true);
  assert.deepEqual(await page.evaluate(() => Object.keys(conversions[0].request).sort()), ["keys", "nsp"]);
  assert.equal(await page.locator("#progress").isVisible(), true);
  await page.evaluate(() => conversions[0].options.onProgress("extract"));
  assert.match(await page.locator("#status").textContent(), /Extracting/);
  await settle(0, { name: "../../<Example>", warnings: ["<img src=x onerror=alert(1)>"] });
  assert.equal(await page.locator("#download").isVisible(), true);
  assert.match(await page.locator("#download").getAttribute("download"), /unsigned\.ipa$/);
  assert.doesNotMatch(await page.locator("#download").getAttribute("download"), /[<>/\\]/);
  assert.equal(await page.locator("#warnings img").count(), 0);
  assert.match(await page.locator("#warnings").textContent(), /not been verified/);
  assert.match(await page.locator("#warnings").textContent(), /Experimental build/);
  assert.match(await page.locator("#warnings").textContent(), /valid Apple signing identity/);
  assert.equal(await page.locator("#result-kind").textContent(), "Unsigned");
  assert.match(await page.locator("#keys-name").textContent(), /No prod.keys/);
  assert.equal(await page.evaluate(() => conversions[0].request.keys.every((byte) => byte === 0)), true);
  assert.equal(await page.locator("#build").isDisabled(), true);
  const output = await page.locator("#download").getAttribute("href");
  await drop([["Example.xci", "another-game"], ["prod.keys", "test-only"]]);
  assert.equal(await page.locator("#download").isVisible(), false);
  assert.equal(await page.evaluate((url) => revoked.includes(url), output), true);

  await page.locator("#build").click();
  await calls(2);
  assert.equal(await page.evaluate(() => conversions[1].request.xci instanceof File), true);
  await page.locator("#cancel").click();
  assert.equal(await page.evaluate(() => conversions[1].options.signal.aborted), true);
  assert.match(await page.locator("#status").textContent(), /Cancelled/);
  await settle(1);
  assert.equal(await page.locator("#download").isVisible(), false);
  assert.equal(await page.evaluate(() => conversions[1].request.keys.every((byte) => byte === 0)), true);

  await drop([["prod.keys", "test-only"]]);
  await page.locator("#build").click();
  await calls(3);
  await drop([["New.nsp", "new-game"], ["prod.keys", "new-keys"]]);
  assert.equal(await page.evaluate(() => conversions[2].options.signal.aborted), true);
  await settle(2);
  assert.equal(await page.locator("#game-name").textContent(), "New.nsp");
  assert.equal(await page.locator("#keys-name").textContent(), "prod.keys");
  assert.equal(await page.locator("#download").isVisible(), false);
  await page.locator("#build").click();
  await calls(4);
  await page.evaluate(() => conversions[3].reject(new Error("Malformed container.")));
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Malformed"));
  assert.match(await page.locator("#status").textContent(), /Local keys cleared/);
  assert.equal(await page.locator("#cancel").isVisible(), false);
  await page.locator("#remove-game").click();
  assert.match(await page.locator("#game-name").textContent(), /No NSP/);

  // Signing remains opt-in and never silently falls back to unsigned output.
  await page.locator("#signing-enabled").check();
  await drop([["Signed.nsp", "game"], ["prod.keys", "test-only"]]);
  assert.equal(await page.locator("#signing-fields").isVisible(), true);
  assert.equal(await page.locator("#build").isDisabled(), true);
  await page.locator("#form").dispatchEvent("submit");
  assert.equal(await page.evaluate(() => conversions.length), 4);
  const credential = (name, content = "synthetic") => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(content) });
  const selectSigning = async (password = "test-only") => {
    await page.locator("#identity").setInputFiles(credential("test.p12"));
    await page.locator("#provision").setInputFiles(credential("test.mobileprovision"));
    await page.locator("#signing-password").fill(password);
  };
  await page.locator("#identity").setInputFiles(credential("bad.txt"));
  assert.match(await page.locator("#status").textContent(), /Choose a .p12/);
  await page.locator("#identity").setInputFiles(credential("empty.p12", ""));
  assert.equal(await page.locator("#build").isDisabled(), true);
  await page.locator("#identity").setInputFiles({ ...credential("large.p12"), buffer: Buffer.alloc(4 * 1024 ** 2) });
  assert.equal(await page.locator("#build").isDisabled(), true);
  await selectSigning();
  assert.equal(await page.locator("#build").isEnabled(), true);
  await page.locator("#build").click();
  await calls(5);
  assert.equal(await page.locator("#signing-enabled").isDisabled(), true);
  assert.equal(await page.locator("#signing-password").inputValue(), "");
  assert.equal(await page.locator("#identity").inputValue(), "");
  assert.equal(await page.evaluate(() => conversions[4].request.signing.password), "test-only");
  assert.equal(await page.evaluate(() => new TextDecoder().decode(conversions[4].request.signing.identity)), "synthetic");
  await settle(4, { signed: true });
  assert.equal(await page.locator("#result-kind").textContent(), "Signed");
  assert.match(await page.locator("#download").getAttribute("download"), /-signed\.ipa$/);
  assert.match(await page.locator("#warnings").textContent(), /Apple trust/);
  assert.doesNotMatch(await page.locator("#warnings").textContent(), /This IPA is unsigned/);
  assert.equal(await page.evaluate(() => conversions[4].request.signing.identity.every(byte => byte === 0)), true);
  assert.equal(await page.evaluate(() => conversions[4].request.signing.profile.every(byte => byte === 0)), true);
  assert.equal(await page.evaluate(() => conversions[4].request.signing.password), "");
  assert.equal(await page.locator("#build").isDisabled(), true);

  await drop([["prod.keys", "test-only"]]);
  await selectSigning("wrong");
  await page.locator("#build").click();
  await calls(6);
  await page.evaluate(() => conversions[5].reject(new Error("Signing failed")));
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Signing failed"));
  assert.equal(await page.locator("#download").isVisible(), false);
  assert.equal(await page.evaluate(() => conversions[5].request.signing.identity.every(byte => byte === 0)), true);
  assert.equal(await page.evaluate(() => conversions[5].request.signing.password), "");

  await drop([["prod.keys", "test-only"]]);
  await selectSigning(""); // Unencrypted PKCS#12 files may have an empty password.
  await page.locator("#build").click();
  await calls(7);
  await page.locator("#cancel").click();
  assert.equal(await page.evaluate(() => conversions[6].options.signal.aborted), true);
  assert.equal(await page.evaluate(() => conversions[6].request.signing.identity.every(byte => byte === 0)), true);
  assert.equal(await page.evaluate(() => conversions[6].request.signing.profile.every(byte => byte === 0)), true);
  await settle(6, { signed: true });
  assert.equal(await page.locator("#download").isVisible(), false);
  await selectSigning();
  await page.locator("#signing-enabled").uncheck();
  assert.equal(await page.locator("#signing-password").inputValue(), "");
  assert.equal(await page.locator("#provision").inputValue(), "");
  assert.equal(await page.locator("#signing-fields").isVisible(), false);

  // Abort while each credential file is still being read, before worker dispatch.
  for (const name of ["test.p12", "test.mobileprovision"]) {
    await page.locator("#signing-enabled").check();
    await drop([["prod.keys", "test-only"]]);
    await selectSigning();
    await page.evaluate((name) => {
      globalThis.originalFileRead = File.prototype.arrayBuffer;
      globalThis.releaseCredentialRead = undefined;
      File.prototype.arrayBuffer = async function () {
        const bytes = await originalFileRead.call(this);
        if (this.name === name) {
          globalThis.pendingCredentialBytes = new Uint8Array(bytes);
          await new Promise(resolve => { globalThis.releaseCredentialRead = resolve; });
        }
        return bytes;
      };
    }, name);
    await page.locator("#build").click();
    await page.waitForFunction(() => typeof releaseCredentialRead === "function");
    await page.locator("#cancel").click();
    await page.evaluate(() => { releaseCredentialRead(); File.prototype.arrayBuffer = originalFileRead; });
    await page.waitForFunction(() => pendingCredentialBytes.every(byte => byte === 0));
    assert.equal(await page.evaluate(() => conversions.length), 7);
    assert.equal(await page.locator("#download").isVisible(), false);
    assert.equal(await page.locator("#signing-password").inputValue(), "");
  }

  // Responsive layout, contrast mode, and bfcache/session cleanup.
  await page.locator("#signing-enabled").check();
  await selectSigning();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await drop([["Resume.nsp", "game"], ["prod.keys", "test-only"]]);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert.equal(await page.locator("#build").isDisabled(), true);
  assert.match(await page.locator("#keys-name").textContent(), /No prod.keys/);
  assert.match(await page.locator("#game-name").textContent(), /No NSP/);
  assert.equal(await page.locator("#identity").inputValue(), "");
  assert.equal(await page.locator("#provision").inputValue(), "");
  assert.equal(await page.locator("#signing-password").inputValue(), "");
  const blocked = await browser.newPage();
  await blocked.addInitScript(() => { globalThis.testEmbeddedHost = false; });
  await blocked.goto(pathToFileURL(join(directory, "index.html")).href);
  assert.equal(await blocked.locator("#runtime-notice").isVisible(), true);
  assert.equal(await blocked.locator("#experimental-notice").isVisible(), false);
  assert.equal(await blocked.locator("#build").isDisabled(), true);
  assert.match(await blocked.locator("#status").textContent(), /does not include an iOS runtime/);
  await blocked.locator("#form").dispatchEvent("submit");
  assert.equal(await blocked.evaluate(() => conversions.length), 0);
  await blocked.close();
  const stable = await browser.newPage();
  await stable.addInitScript(() => { globalThis.testExperimental = false; });
  await stable.goto(pathToFileURL(join(directory, "index.html")).href);
  assert.equal(await stable.locator("#experimental-notice").isVisible(), false);
  assert.equal(await stable.locator("#runtime-notice").isVisible(), false);
  assert.equal(await stable.locator("#build-kind").textContent(), "Local only");
  await stable.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log("UI: drag/drop, keyboard selection, atomic validation, stale completion, cancellation, optional signing, credential cleanup, mobile, experimental/missing-host notices and offline checks passed.");
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
