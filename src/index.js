import workerSource from "nx2ipa:worker";
export { default as capabilities } from "nx2ipa:capabilities";

/** Build an IPA locally. Byte inputs are copied, never transferred from the
 * caller. A fresh worker owns each conversion and is terminated on abort. */
export async function createIpa(request, { signal, onProgress } = {}) {
  if (!request || typeof request !== "object") throw new TypeError("Expected conversion options");
  signal?.throwIfAborted();
  let total = 0;
  const copies = [];
  const bytes = (value) => {
    if (!(value instanceof Uint8Array)) throw new TypeError("Expected Uint8Array input");
    total += value.length;
    if (total > 256 * 1024 ** 2) throw new Error("Input exceeds 256 MiB");
    const copy = new Uint8Array(value);
    copies.push(copy);
    return copy;
  };
  const container = (value) => {
    if (value === undefined) return undefined;
    if (value instanceof Blob) {
      if (!Number.isSafeInteger(value.size) || !value.size) throw new Error("Empty or oversized container");
      return value;
    }
    return bytes(value);
  };
  const files = (rows) => {
    if (!Array.isArray(rows) || rows.length > 20000) throw new Error("Invalid file list");
    return rows.map((row) => ({
      path: row.path,
      data: bytes(row.data),
      executable: !!row.executable,
    }));
  };
  let input;
  try {
    input = {
      template: request.template
        ? { name: request.template.name, files: files(request.template.files) }
        : undefined,
      profile: request.profile,
      modules: request.modules?.map((module) => ({ name: module.name, data: bytes(module.data) })),
      npdm: request.npdm === undefined ? undefined : bytes(request.npdm),
      nsp: container(request.nsp),
      xci: container(request.xci),
      update: container(request.update),
      keys: request.keys === undefined ? undefined : bytes(request.keys),
      resources: files(request.resources ?? []),
      shaders: request.shaders?.map((shader) => ({
        job: shader.job,
        code: bytes(shader.code),
      })),
      signing: request.signing
        ? {
            identity: bytes(request.signing.identity),
            profile: bytes(request.signing.profile),
            password: request.signing.password,
          }
        : undefined,
    };
    if ([input.nsp, input.xci, input.modules].filter(Boolean).length > 1)
      throw new Error("Choose one NSP, XCI, or extracted module set");
    if (input.update && !input.nsp && !input.xci)
      throw new Error("A separate update requires a base NSP or XCI");
    if (input.modules && (!input.profile || typeof input.profile.name !== "string"))
      throw new Error("Extracted modules require a profile with a name");
    if ((input.nsp || input.xci) && !input.keys)
      throw new Error("NSP/XCI input requires prod.keys bytes");
    if (input.keys?.length > 1024 ** 2) throw new Error("prod.keys exceeds 1 MiB");
    if (input.modules && !input.npdm) throw new Error("Extracted modules require NPDM bytes");
    if (input.shaders?.length && !input.nsp && !input.xci && !input.modules)
      throw new Error("Shaders require a game build");
    if (
      input.signing &&
      (typeof input.signing.password !== "string" ||
        input.signing.password.length > 16384 ||
        input.signing.password.includes("\0"))
    )
      throw new Error("Invalid signing password");
    signal?.throwIfAborted();
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    let worker;
    try {
      worker = new Worker(url, { type: "classic" });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    return await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        URL.revokeObjectURL(url);
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = () => finish(new Error("Conversion worker failed"));
      worker.onmessageerror = worker.onerror;
      worker.onmessage = ({ data }) => {
        if (data.stage) {
          try {
            onProgress?.(data.stage);
          } catch (error) {
            finish(error);
          }
        } else if (data.error) finish(new Error(data.error));
        else if (data.result?.ipa instanceof Uint8Array) finish(null, data.result);
        else finish(new Error("Invalid conversion result"));
      };
      if (signal?.aborted) abort();
      else
        try {
          worker.postMessage(input, copies.map((copy) => copy.buffer));
        } catch (error) {
          finish(error);
        }
    });
  } finally {
    for (const copy of copies) if (copy.byteLength) copy.fill(0);
    if (input?.signing) input.signing.password = "";
  }
}
