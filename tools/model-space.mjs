import { UI } from "../behavior_pack/scripts/ui/layouts.js";

export const MODEL_UNITS_PER_PIXEL = 16 / UI.pxPerBlock;

// With the front-facing panel yaw, local +X points to the viewer's LEFT.
// UI coordinates always increase to the RIGHT. Apply that conversion to every
// quad, pivot and animation; do not mirror textures or reverse packed strings.
export const uiToModel = (x, y, z = 0) => [
  (UI.width / 2 - x) * MODEL_UNITS_PER_PIXEL,
  (UI.height / 2 - y) * MODEL_UNITS_PER_PIXEL,
  z
];

export function uiQuad(name, rect, uv, z, parent = "root", pivot) {
  const [x, y, w, h] = rect, [u, v, uw, uh] = uv;
  return { name, parent, pivot: pivot ?? uiToModel(x, y, z), cubes: [{
    // A cube origin is the MINIMUM model-space X, which is the UI's RIGHT edge.
    // Keep sizes positive and the south-face UV direction intact: its U=0 edge
    // is maximum model X (the visible left). Existing single glyphs were legible.
    origin: uiToModel(x + w, y + h, z),
    size: [w * MODEL_UNITS_PER_PIXEL, h * MODEL_UNITS_PER_PIXEL, 0],
    uv: { south: { uv: [u, v], uv_size: [uw, uh] } }
  }] };
}

export const uiOffsetExpression = expression => `-(${expression}) * ${MODEL_UNITS_PER_PIXEL}`;
