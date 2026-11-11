import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { exercise, sample } from "./fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "nx2ipa-browser-"));
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
  // The actual standalone HTML must package through its real form and worker.
  const app = join(directory, "Sample.app");
  await mkdir(app);
  for (const file of sample().template.files) await writeFile(join(app, file.path), file.data);
  await page.goto(pathToFileURL(new URL("../dist/nx2ipa.html", import.meta.url).pathname).href);
  await page.locator("#mode").selectOption("app");
  await page.locator("#template").setInputFiles(app);
  await page.locator("#executables").fill("Sample");
  await page.locator("#build").click();
  await page.waitForFunction(
    () =>
      document.getElementById("status").textContent.includes("IPA ready") ||
      document.getElementById("status").textContent.includes("failed"),
  );
  assert.match(await page.locator("#status").textContent(), /^Unsigned IPA ready/);
  assert.equal(await page.locator("#download").isVisible(), true);
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
  const encode = (value) => {
    if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]));
    return value;
  };
  await exercise(async (request, { abortAt } = {}) => {
    const reply = await page.evaluate(
      async ({ request, abortAt }) => {
        const decode = (value) => {
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
      { request: encode(request), abortAt },
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
  await rm(directory, { recursive: true, force: true });
}
