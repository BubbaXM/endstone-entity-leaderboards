import { ALPHABET, UI } from "./layouts.js";

export function glyphId(char) { return Math.max(0, ALPHABET.indexOf(char.toUpperCase())); }
export function packGlyphs(chars) {
  let value = 0;
  for (let i = 0; i < 4; i++) value += glyphId(chars[i] ?? " ") * 64 ** i;
  return value;
}
export function unpackGlyphs(value) {
  return Array.from({ length: 4 }, (_, i) => ALPHABET[Math.floor(value / 64 ** i) % 64]).join("");
}
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const packPair = (x, y) => clamp(Math.round(x), 0, 1023) + clamp(Math.round(y), 0, 1023) * 1024;
export const unpackPair = n => [n % 1024, Math.floor(n / 1024)];
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function intersectPanel(origin, direction, panel, scale = 1) {
  const denom = dot(direction, panel.normal);
  if (denom >= -0.0001) return null; // no clicks from behind / parallel rays
  const t = dot(subtract(panel.center, origin), panel.normal) / denom;
  if (t <= 0 || t > UI.maxDistance) return null;
  const relative = subtract({ x: origin.x + t * direction.x,
    y: origin.y + t * direction.y, z: origin.z + t * direction.z }, panel.center);
  const k = UI.pxPerBlock / scale;
  const x = UI.width / 2 + dot(relative, panel.right) * k;
  const y = UI.height / 2 - relative.y * k;
  return x >= 0 && x < UI.width && y >= 0 && y < UI.height ? { x, y, t } : null;
}
export function hitTest(page, point, states = {}) {
  if (!point) return null;
  // Last drawn element wins if a custom page intentionally overlays controls.
  return [...page.elements].reverse().find(e => {
    const [x, y, w, h] = e.rect;
    return !states[e.id]?.hidden && point.x >= x && point.x < x + w && point.y >= y && point.y < y + h;
  }) ?? null;
}
export function stateMasks(page, states) {
  const result = {};
  for (const name of ["disabled", "on", "active", "hidden"]) {
    for (let group = 0; group < 2; group++) {
      result[`ns:${name}${group}`] = page.elements.reduce((mask, e, i) =>
        Math.floor(i / UI.maskBits) === group && states[e.id]?.[name]
          ? mask + 2 ** (i % UI.maskBits) : mask, 0);
    }
  }
  return result;
}
export function wrapText(text, width, rows = 1) {
  const words = String(text ?? "").toUpperCase().split(/\s+/);
  const lines = [""];
  for (const original of words) {
    let word = original;
    if (lines.at(-1) && lines.at(-1).length + word.length + 1 > width) lines.push("");
    while (word.length > width) {
      if (lines.at(-1)) lines.push("");
      lines[lines.length - 1] = word.slice(0, width); word = word.slice(width); lines.push("");
    }
    lines[lines.length - 1] += (lines.at(-1) ? " " : "") + word;
  }
  return Array.from({ length: rows }, (_, i) => (lines[i] ?? "").slice(0, width).padEnd(width)).join("");
}
export function fieldCharacters(cells, fields) {
  const cache = new Map();
  return cells.map(c => {
    if (!cache.has(c.field)) cache.set(c.field, wrapText(fields[c.field] ?? "", c.width, c.rows));
    return cache.get(c.field)[c.index] ?? " ";
  });
}
export function changedProperties(previous, next) {
  return Object.entries(next).filter(([key, value]) => previous.get(key) !== value);
}
