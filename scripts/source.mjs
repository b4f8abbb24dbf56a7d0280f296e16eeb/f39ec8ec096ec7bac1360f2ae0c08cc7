import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
export async function command(args, cwd = root) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code) throw new Error(`${args[0]} failed: ${err}`);
  return out.trim();
}
export async function prepareSource() {
  const pin = await Bun.file(resolve(root, "nxkit.json")).json();
  const git = resolve(root, ".build/nxkit.git"), source = resolve(root, ".build/nxkit");
  await mkdir(resolve(root, ".build"), { recursive: true });
  await command(["git", "init", "--bare", git]);
  await command(["git", "-C", git, "fetch", "--depth=1", "--no-tags", pin.repository, pin.commit]);
  if (await command(["git", "-C", git, "rev-parse", "FETCH_HEAD"]) !== pin.commit ||
      await command(["git", "-C", git, "rev-parse", `${pin.commit}^{tree}`]) !== pin.tree)
    throw new Error("nxkit source identity mismatch");
  const archive = resolve(root, ".build/nxkit.tar");
  await command(["git", "-C", git, "archive", "--format=tar", `--output=${archive}`, pin.commit]);
  await rm(source, { recursive: true, force: true });
  await mkdir(source);
  await command(["tar", "-xf", archive, "-C", source]);
  await rm(archive);
  return pin;
}
if (import.meta.main) await prepareSource();
