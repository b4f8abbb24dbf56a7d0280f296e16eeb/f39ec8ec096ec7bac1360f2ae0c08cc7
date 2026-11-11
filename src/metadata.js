import decodeJpeg from "jpeg-js/lib/decoder.js";
import { inflateSync, zlibSync } from "fflate";

export function nameFromNacp(bytes) {
  let names = bytes, count = 16;
  // New SDKs deflate the language table. Bound expansion to the fixed table.
  const size = bytes.length > 1 ? bytes[0] | (bytes[1] << 8) : 0;
  if (size > 0 && size <= 0x2ffe && bytes.length >= size + 2) {
    try {
      const inflated = inflateSync(bytes.subarray(2, size + 2), { out: new Uint8Array(0x6000) });
      if (inflated.length === 0x6000) { names = inflated; count = 32; }
    } catch { /* Legacy NACP stores plain UTF-8 in the same bytes. */ }
  }
  for (let i = 0; i < count; i++) {
    const field = names.subarray(i * 0x300, i * 0x300 + 0x200);
    const zero = field.indexOf(0);
    const name = new TextDecoder().decode(zero < 0 ? field : field.subarray(0, zero)).trim();
    if (name && !/[\x00-\x1f\x7f\ufffd-\uffff]/.test(name)) return name;
  }
  return undefined;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function chunk(type, data) {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}
function png(image, size) {
  // Opaque RGB, bilinearly resampled from the actual Control NCA artwork.
  const rows = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const sy = Math.max(0, (y + 0.5) * image.height / size - 0.5);
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, image.height - 1), fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = Math.max(0, (x + 0.5) * image.width / size - 0.5);
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, image.width - 1), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const top = image.data[(y0 * image.width + x0) * 3 + c] * (1 - fx)
          + image.data[(y0 * image.width + x1) * 3 + c] * fx;
        const bottom = image.data[(y1 * image.width + x0) * 3 + c] * (1 - fx)
          + image.data[(y1 * image.width + x1) * 3 + c] * fx;
        rows[y * (1 + size * 3) + 1 + x * 3 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size); header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", zlibSync(rows)), chunk("IEND", new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export function appIcons(jpeg) {
  if (!jpeg.length || jpeg.length > 4 * 1024 ** 2) throw new Error("Invalid icon size");
  const image = decodeJpeg(jpeg, {
    useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
    maxResolutionInMP: 1, maxMemoryUsageInMB: 32,
  });
  if (!image.width || image.width !== image.height) throw new Error("Expected a square game icon");
  return [
    ["Nx2ipaGameIcon60x60@2x.png", 120], ["Nx2ipaGameIcon60x60@3x.png", 180],
    ["Nx2ipaGameIcon76x76.png", 76], ["Nx2ipaGameIcon76x76@2x.png", 152],
    ["Nx2ipaGameIcon83.5x83.5@2x.png", 167],
  ].map(([path, size]) => ({ path, data: png(image, size) }));
}

// The built-in host's XML plist is controlled by ios/Info.plist and has no
// display-name/icon keys. Advanced custom templates keep their own metadata.
export function installMetadata(plist, name, hasIcon) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(name))
    throw new Error("Game display name contains invalid XML characters");
  const escaped = name.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let keys = `<key>CFBundleDisplayName</key><string>${escaped}</string>`;
  if (hasIcon) {
    for (const [key, names] of [
      ["CFBundleIcons", ["Nx2ipaGameIcon60x60"]],
      ["CFBundleIcons~ipad", ["Nx2ipaGameIcon76x76", "Nx2ipaGameIcon83.5x83.5"]],
    ]) keys += `<key>${key}</key><dict><key>CFBundlePrimaryIcon</key><dict>`
      + `<key>CFBundleIconFiles</key><array>${names.map((n) => `<string>${n}</string>`).join("")}</array>`
      + "</dict></dict>";
  }
  if (!plist.includes("<dict>")) throw new Error("Expected built-in host XML plist");
  return plist.replace("<dict>", () => `<dict>${keys}`);
}
