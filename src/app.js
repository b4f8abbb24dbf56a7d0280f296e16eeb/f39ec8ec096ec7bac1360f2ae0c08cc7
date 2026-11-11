import { createIpa, capabilities } from "./index.js";

const $ = (id) => document.getElementById(id);
const selected = { game: undefined, keys: undefined };
let controller, outputUrl, generation = 0, dragDepth = 0;
const available = capabilities.embeddedHost === true;
const experimental = available && capabilities.experimental === true;
const unavailable = "Build unavailable: this version does not include an iOS runtime.";
const size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2
  ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const status = (message, state = "idle") => {
  $("status").textContent = message;
  $("status-area").dataset.state = state;
};
const clearOutput = () => {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
  $("download").hidden = true;
  $("download").removeAttribute("href");
  $("download").removeAttribute("download");
  $("result").hidden = true;
  $("warnings").replaceChildren();
};
const render = () => {
  for (const kind of ["game", "keys"]) {
    const file = selected[kind];
    $(`${kind}-row`).dataset.selected = String(!!file);
    $(`${kind}-name`).textContent = file?.name ?? (kind === "game" ? "No NSP or XCI selected" : "No prod.keys selected");
    $(`${kind}-size`).textContent = file ? size(file.size) : "";
    $(`remove-${kind}`).hidden = !file;
  }
  $("build").disabled = !available || !!controller || !selected.game || !selected.keys;
  $("cancel").hidden = !controller;
  $("cancel").disabled = !controller;
  $("progress").hidden = !controller;
  $("form").setAttribute("aria-busy", String(!!controller));
};
const reset = () => {
  generation++;
  controller?.abort();
  controller = undefined;
  clearOutput();
};
const ready = () => !available ? unavailable : selected.game && selected.keys ? `Ready to create an ${experimental ? "experimental unsigned" : "unsigned"} IPA.`
  : selected.game ? "Add your prod.keys to continue."
    : selected.keys ? "Add one NSP or XCI to continue." : "Choose your game and keys to get started.";

function accept(files) {
  if (!files.length) return;
  const next = {};
  try {
    for (const file of files) {
      const kind = /\.(nsp|xci)$/i.test(file.name) ? "game" : /^prod\.keys$/i.test(file.name) ? "keys" : undefined;
      if (!kind) throw new Error("Choose one .nsp or .xci and prod.keys. Other files are not supported.");
      if (next[kind]) throw new Error(kind === "game" ? "Choose only one game at a time." : "Choose only one prod.keys file.");
      if (!file.size) throw new Error(`${file.name} is empty. Choose a valid file.`);
      if (kind === "keys" && file.size > 1024 ** 2) throw new Error("prod.keys exceeds the 1 MiB limit. Choose your text keys file.");
      next[kind] = file;
    }
    reset();
    Object.assign(selected, next);
    status(ready());
    render();
  } catch (error) {
    // Rejected drops are atomic: retain the current selection and any running build.
    status(error.message, "error");
  }
}
$("dropzone").onclick = () => $("files").click();
$("files").onchange = (event) => {
  accept([...event.target.files]);
  event.target.value = ""; // Selecting the same file again must still fire change.
};
const fileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
for (const type of ["dragover", "drop"]) window.addEventListener(type, (event) => {
  if (fileDrag(event)) event.preventDefault(); // Never navigate away to a dropped local file.
});
$("dropzone").addEventListener("dragenter", (event) => {
  if (!fileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  $("dropzone").dataset.dragging = "true";
});
$("dropzone").addEventListener("dragover", (event) => {
  if (!fileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
$("dropzone").addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; delete $("dropzone").dataset.dragging; }
});
$("dropzone").addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  delete $("dropzone").dataset.dragging;
  accept([...event.dataTransfer.files]);
});
for (const kind of ["game", "keys"]) $(`remove-${kind}`).onclick = () => {
  reset();
  selected[kind] = undefined;
  render();
  status(ready());
  $("dropzone").focus();
};
$("cancel").onclick = () => {
  reset();
  selected.keys = undefined;
  render();
  status("Cancelled. Add prod.keys to try again.");
  $("dropzone").focus();
};
window.addEventListener("pagehide", () => {
  reset();
  selected.game = selected.keys = undefined;
  $("files").value = "";
  render();
  status(ready());
});

$("form").onsubmit = async (event) => {
  event.preventDefault();
  if (controller) return;
  if (!available) { status(unavailable, "error"); return; }
  if (!selected.game || !selected.keys) {
    status(ready(), "error");
    $("dropzone").focus();
    return;
  }
  clearOutput();
  const current = ++generation;
  const game = selected.game;
  let keysFile = selected.keys;
  const kind = /\.xci$/i.test(game.name) ? "xci" : "nsp";
  controller = new AbortController();
  const { signal } = controller;
  render();
  status("Reading local keys…", "working");
  let keys;
  try {
    keys = new Uint8Array(await keysFile.arrayBuffer());
    keysFile = undefined;
    signal.throwIfAborted();
    const result = await createIpa({ [kind]: game, keys }, {
      signal,
      onProgress(stage) {
        if (current !== generation) return;
        const stages = { extract: "Extracting game files…", compile: "Compiling game modules…", rewrite: "Rewriting game resources…", resources: "Preparing game resources…", shaders: "Preparing shaders…", package: "Packaging your IPA…", validate: "Checking the archive…", sign: "Signing the archive…" };
        status(stages[stage] ?? `${String(stage).replace(/[-_]/g, " ")}…`, "working");
      },
    });
    if (current !== generation) return;
    outputUrl = URL.createObjectURL(new Blob([result.ipa], { type: "application/octet-stream" }));
    const name = String(result.name || game.name.replace(/\.(nsp|xci)$/i, ""))
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 120) || "Game";
    $("download").href = outputUrl;
    $("download").download = `${name}-${result.signed ? "signed" : "unsigned"}.ipa`;
    $("download").hidden = false;
    $("result").hidden = false;
    $("result-kind").textContent = result.signed ? "Signed" : "Unsigned";
    $("result-summary").textContent = `${name} · ${size(result.ipa.length)}`;
    const warnings = [...new Set([
      ...(experimental ? ["Experimental build. Successful packaging does not establish installation or gameplay."] : []),
      ...(!result.signed ? ["This IPA is unsigned. Sign it separately with your own valid Apple signing identity and provisioning profile before attempting installation."] : []),
      "Device compatibility and gameplay have not been verified.",
      ...(Array.isArray(result.warnings) ? result.warnings.filter((warning) => typeof warning === "string") : []),
    ])];
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      $("warnings").append(item);
    }
    status(`${result.signed ? "Signed" : "Unsigned"} IPA ready. Local keys cleared.`, "complete");
    $("download").focus();
  } catch (error) {
    if (current === generation) status(error.name === "AbortError" ? "Cancelled. Add prod.keys to try again." : `${error.message || "Conversion failed."} Local keys cleared.`, error.name === "AbortError" ? "idle" : "error");
  } finally {
    keys?.fill(0);
    keysFile = undefined;
    if (current === generation) {
      selected.keys = undefined;
      controller = undefined;
      render();
    }
  }
};
$("runtime-notice").hidden = available;
$("experimental-notice").hidden = !experimental;
if (experimental) {
  $("build-kind").textContent = "Experimental";
  $("build").setAttribute("aria-describedby", "experimental-notice");
}
if (!available) {
  $("build").textContent = "Build unavailable";
  $("build").setAttribute("aria-describedby", "runtime-notice");
  status(unavailable, "error");
}
render();
