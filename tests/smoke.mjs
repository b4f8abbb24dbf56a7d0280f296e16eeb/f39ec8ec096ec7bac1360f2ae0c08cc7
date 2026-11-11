import { createIpa } from "../dist/nx2ipa.js";
import { exercise } from "./fixture.mjs";
globalThis.fetch = () => {
  throw new Error("Unexpected network access");
};
await exercise((request, { abortAt } = {}) => {
  const controller = new AbortController();
  return createIpa(request, {
    signal: controller.signal,
    onProgress(stage) {
      if (stage === abortAt) controller.abort();
    },
  });
});
