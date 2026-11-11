import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { exercise, sample } from "./fixture.mjs";
import { containerSample } from "./containers.mjs";
import { capabilities } from "../dist/nx2ipa.js";

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage(),
    errors = [],
    network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  await page.route(/^https?:/, (route) => route.abort());
  // The real standalone HTML never asks for templates or profiles. A build
  // without the required runtime must be visibly blocked, not fake success.
  await page.goto(pathToFileURL(new URL("../dist/nx2ipa.html", import.meta.url).pathname).href);
  assert.equal(await page.locator("input[type=file]").count(), 1);
  assert.equal(await page.locator("#template,#profile,#shaders,#identity,#provision").count(), 0);
  assert.equal(await page.locator("#experimental-notice").isVisible(),
    capabilities.embeddedHost && capabilities.experimental === true);
  if (capabilities.embeddedHost) {
    const raw = containerSample(sample());
    // Both formats use the real drop handler, File/Blob transport, embedded host
    // and worker. The fixture is authored test content, not a real game.
    for (const kind of ["nsp", "xci"]) {
      const transfer = await page.evaluateHandle(({ kind, game, keys }) => {
        const bytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes(game)], `Fixture.${kind}`));
        transfer.items.add(new File([bytes(keys)], "prod.keys"));
        return transfer;
      }, { kind, game: Buffer.from(raw[kind]).toString("base64"), keys: Buffer.from(raw.keys).toString("base64") });
      await page.locator("#dropzone").dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
      assert.equal(await page.locator("#build").isEnabled(), true);
      await page.locator("#build").click();
      await page.waitForFunction(() => document.getElementById("form").getAttribute("aria-busy") === "false");
      assert.match(await page.locator("#status").textContent(), /^Unsigned IPA ready/);
      assert.equal(await page.locator("#download").isVisible(), true);
      assert.match(await page.locator("#download").getAttribute("download"), /-unsigned\.ipa$/);
      assert.equal(await page.locator("#result-kind").textContent(), "Unsigned");
      assert.match(await page.locator("#warnings").textContent(), /valid Apple signing identity/);
      assert.match(await page.locator("#warnings").textContent(), /gameplay have not been verified/);
      if (capabilities.experimental) assert.match(await page.locator("#warnings").textContent(), /Experimental build/);
      assert.match(await page.locator("#keys-name").textContent(), /No prod.keys/);
    }
  } else {
    assert.equal(await page.locator("#runtime-notice").isVisible(), true);
    assert.equal(await page.locator("#build").isDisabled(), true);
    assert.match(await page.locator("#status").textContent(), /does not include an iOS runtime/);
  }
  // Then run exactly the Bun scenarios against the unchanged released ESM.
  const source = await readFile(new URL("../dist/nx2ipa.js", import.meta.url), "utf8");
  await page.evaluate(async (source) => {
    globalThis.fetch = () => {
      throw new Error("Unexpected network access");
    };
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      globalThis.testLibrary = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, source);
  const encode = async (value) => {
    if (value instanceof Blob) return { blob: Buffer.from(await value.arrayBuffer()).toString("base64"), type: value.type };
    if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
    if (Array.isArray(value)) return Promise.all(value.map(encode));
    if (value && typeof value === "object")
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await encode(child)])));
    return value;
  };
  await exercise(async (request, { abortAt } = {}) => {
    const reply = await page.evaluate(
      async ({ request, abortAt }) => {
        const decode = (value) => {
          if (value?.blob !== undefined) return new Blob([
            Uint8Array.from(atob(value.blob), (c) => c.charCodeAt(0)),
          ], { type: value.type });
          if (value?.base64 !== undefined)
            return Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0));
          if (Array.isArray(value)) return value.map(decode);
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([key, child]) => [key, decode(child)]),
            );
          return value;
        };
        const controller = new AbortController();
        try {
          const result = await globalThis.testLibrary.createIpa(decode(request), {
            signal: controller.signal,
            onProgress(stage) {
              if (stage === abortAt) controller.abort();
            },
          });
          let data = "";
          for (let at = 0; at < result.ipa.length; at += 32768)
            data += String.fromCharCode(...result.ipa.subarray(at, at + 32768));
          return { ...result, ipa: btoa(data) };
        } catch (error) {
          return { error: error.message, name: error.name };
        }
      },
      { request: await encode(request), abortAt },
    );
    if (reply.error) {
      const error = new Error(reply.error);
      error.name = reply.name;
      throw error;
    }
    return { ...reply, ipa: new Uint8Array(Buffer.from(reply.ipa, "base64")) };
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log("Chromium: standalone HTML and identical release ESM passed offline.");
} finally {
  await browser?.close();
}
