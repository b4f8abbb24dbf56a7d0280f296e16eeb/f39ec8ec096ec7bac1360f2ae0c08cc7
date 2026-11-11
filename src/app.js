import { createIpa } from "./index.js";
const $ = (id) => document.getElementById(id);
let controller,
  outputUrl,
  generation = 0;
const clear = () => {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
  $("download").hidden = true;
  $("download").removeAttribute("href");
};
const reset = () => {
  generation++;
  controller?.abort();
  controller = undefined;
  clear();
  $("cancel").disabled = true;
  $("build").disabled = false;
};
const mode = () => {
  $("extracted").hidden = $("mode").value !== "extracted";
  $("raw").hidden = $("mode").value !== "nsp";
  for (const node of document.querySelectorAll(".game")) node.hidden = $("mode").value === "app";
  $("credentials").hidden = !$("sign").checked;
};
const read = async (file) => {
  if (!file) throw new Error("Choose the required files.");
  return new Uint8Array(await file.arrayBuffer());
};
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
for (const node of $("form").querySelectorAll("input,textarea,select"))
  node.addEventListener("input", () => {
    reset();
    mode();
    $("status").textContent = "Selection changed. Ready.";
  });
$("cancel").onclick = () => {
  reset();
  $("password").value = "";
  $("keys").value = "";
  $("status").textContent = "Cancelled.";
};
window.addEventListener("pagehide", reset);
$("form").onsubmit = async (event) => {
  event.preventDefault();
  if (controller) return;
  clear();
  const current = ++generation;
  controller = new AbortController();
  const signal = controller.signal;
  $("build").disabled = true;
  $("cancel").disabled = false;
  const selected = Object.fromEntries(
    [...$("form").querySelectorAll("input[type=file]")].map((node) => [node.id, [...node.files]]),
  );
  const password = $("password").value,
    sign = $("sign").checked,
    kind = $("mode").value;
  const executables = new Set($("executables").value.split(/\r?\n/).filter(Boolean));
  $("password").value = "";
  $("identity").value = "";
  $("provision").value = "";
  $("keys").value = "";
  let request;
  try {
    $("status").textContent = "Reading local inputs…";
    const name = selected.template[0]?.webkitRelativePath.split("/")[0];
    if (!name || selected.template.some((file) => !file.webkitRelativePath.startsWith(name + "/")))
      throw new Error("Choose one .app folder.");
    request = {
      template: {
        name,
        files: await Promise.all(
          selected.template.map(async (file) => {
            const path = file.webkitRelativePath.slice(name.length + 1);
            return { path, data: await read(file), executable: executables.has(path) };
          }),
        ),
      },
    };
    if (kind !== "app") {
      try {
        request.profile = JSON.parse(new TextDecoder().decode(await read(selected.profile[0])));
      } catch {
        throw new Error("Choose a valid profile JSON.");
      }
      if (kind === "nsp") {
        request.nsp = await read(selected.nsp[0]);
        request.keys = await read(selected.keys[0]);
      } else {
        request.modules = await Promise.all(
          selected.modules.map(async (file) => ({
            name: file.name.replace(/\.nso$/i, ""),
            data: await read(file),
          })),
        );
        request.npdm = await read(selected.npdm[0]);
        request.resources = await Promise.all(
          selected.romfs.map(async (file) => ({
            path: "romfs/" + file.webkitRelativePath.split("/").slice(1).join("/"),
            data: await read(file),
          })),
        );
      }
      if (selected.shaders[0]) {
        try {
          request.shaders = JSON.parse(
            new TextDecoder().decode(await read(selected.shaders[0])),
          ).map((shader) => ({ job: shader.job, code: decode(shader.code) }));
        } catch {
          throw new Error("Choose valid shader jobs JSON.");
        }
      }
    }
    if (sign)
      request.signing = {
        identity: await read(selected.identity[0]),
        profile: await read(selected.provision[0]),
        password,
      };
    signal.throwIfAborted();
    const result = await createIpa(request, {
      signal,
      onProgress: (stage) => {
        if (current === generation) $("status").textContent = `${stage}…`;
      },
    });
    if (current !== generation) return;
    outputUrl = URL.createObjectURL(new Blob([result.ipa], { type: "application/octet-stream" }));
    $("download").href = outputUrl;
    $("download").download = name.slice(0, -4) + (result.signed ? "-signed.ipa" : "-unsigned.ipa");
    $("download").hidden = false;
    $("status").textContent =
      `${result.signed ? "Signed" : "Unsigned"} IPA ready (${result.ipa.length.toLocaleString()} bytes). Device compatibility remains unverified.`;
  } catch (error) {
    if (current === generation)
      $("status").textContent = error.name === "AbortError" ? "Cancelled." : error.message;
  } finally {
    request?.keys?.fill(0);
    request?.signing?.identity.fill(0);
    request?.signing?.profile.fill(0);
    if (request?.signing) request.signing.password = "";
    if (current === generation) {
      controller = undefined;
      $("build").disabled = false;
      $("cancel").disabled = true;
    }
  }
};
mode();
