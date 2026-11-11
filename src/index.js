import workerSource from "nx2ipa:worker";

/** Build an IPA locally. Byte inputs are copied, never transferred from the
 * caller. A fresh worker owns each conversion and is terminated on abort. */
export async function createIpa(request, { signal, onProgress } = {}) {
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
      template: { name: request.template.name, files: files(request.template.files) },
      profile: request.profile === undefined ? undefined : structuredClone(request.profile),
      modules: request.modules?.map((module) => ({ name: module.name, data: bytes(module.data) })),
      npdm: request.npdm === undefined ? undefined : bytes(request.npdm),
      nsp: request.nsp === undefined ? undefined : bytes(request.nsp),
      keys: request.keys === undefined ? undefined : bytes(request.keys),
      resources: files(request.resources ?? []),
      shaders: request.shaders?.map((shader) => ({
        job: structuredClone(shader.job),
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
    if (input.nsp && input.modules) throw new Error("Choose NSP or extracted modules");
    if ((input.nsp || input.modules) && (!input.profile || typeof input.profile.name !== "string"))
      throw new Error("Game builds require a profile with a name");
    if (input.nsp && !input.keys) throw new Error("NSP input requires prod.keys bytes");
    if (input.modules && !input.npdm) throw new Error("Extracted modules require NPDM bytes");
    if (input.shaders?.length && !input.nsp && !input.modules)
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
          worker.postMessage(input);
        } catch (error) {
          finish(error);
        }
    });
  } finally {
    for (const copy of copies) copy.fill(0);
    if (input?.signing) input.signing.password = "";
  }
}
