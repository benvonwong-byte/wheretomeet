// Advantage color scale for contour lines on the light basemap:
// violet = A reaches this stretch sooner, crimson = B does, orange = even.
const A_RGB: [number, number, number] = [109, 63, 212]; // violet — person A
const B_RGB: [number, number, number] = [214, 60, 68]; // crimson — person B
const MID_RGB: [number, number, number] = [224, 134, 44]; // burnt orange — balanced

const GAP_RANGE = 25; // minutes of advantage for a full-strength hue

/** Diverging advantage color: gap = tA - tB minutes. Negative → blue (A's turf). */
export function advantageColor(gap: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, gap / GAP_RANGE));
  const [c0, c1, f] = t < 0 ? [A_RGB, MID_RGB, t + 1] : [MID_RGB, B_RGB, t];
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}
