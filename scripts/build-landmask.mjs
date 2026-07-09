// Bake a land/water mask for the NYC grid: a cell is "off-network" (water,
// harbor) when its center snaps > SNAP_M meters from the walking network.
// Requires the local OSRM foot server (scripts/routing-servers.sh, :5003).
// Output: src/data/landmask.json — '1' = on-network, '0' = masked.
import { writeFileSync } from 'node:fs';

const GRID = { latMin: 40.55, latMax: 40.92, lngMin: -74.06, lngMax: -73.7, rows: 148, cols: 122 };
const SNAP_M = 150;
const CHUNK = 180;

const cells = [];
for (let r = 0; r < GRID.rows; r++) {
  for (let c = 0; c < GRID.cols; c++) {
    cells.push({
      lat: GRID.latMin + ((r + 0.5) / GRID.rows) * (GRID.latMax - GRID.latMin),
      lng: GRID.lngMin + ((c + 0.5) / GRID.cols) * (GRID.lngMax - GRID.lngMin),
    });
  }
}

const mask = new Array(cells.length).fill('0');
for (let off = 0; off < cells.length; off += CHUNK) {
  const slice = cells.slice(off, off + CHUNK);
  const coords = slice.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const res = await fetch(`http://127.0.0.1:5003/table/v1/driving/${coords}?sources=0&annotations=duration`);
  if (!res.ok) throw new Error(`chunk ${off}: HTTP ${res.status}`);
  const json = await res.json();
  json.destinations.forEach((d, i) => {
    mask[off + i] = d.distance <= SNAP_M ? '1' : '0';
  });
  if (off % (CHUNK * 20) === 0) console.log(`${off}/${cells.length}`);
}

const land = mask.filter((m) => m === '1').length;
writeFileSync('src/data/landmask.json', JSON.stringify({ rows: GRID.rows, cols: GRID.cols, mask: mask.join('') }));
console.log(`Done: ${land} on-network of ${cells.length} cells (${Math.round((100 * land) / cells.length)}% land)`);
