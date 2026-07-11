import type { Pt, Mode, Daypart } from './types';

// The URL hash IS the plan: pins, modes, dial, daypart, favorites.
// #a=40.71430,-73.96140&b=...&la=245%20Varet...&am=sb&bm=sc&t=15&d=m&f=n123.w456
export interface ShareState {
  a?: Pt;
  b?: Pt;
  labelA?: string;
  labelB?: string;
  nameA?: string;
  nameB?: string;
  modesA?: Mode[];
  modesB?: Mode[];
  bias?: number;
  daypart?: Daypart;
  favs?: string[];
  solo?: boolean; // near-me browsing: A only, B mirrors A until set
  extra?: { pt: Pt; mode: Mode; name: string }[]; // people beyond A/B (group mode)
  lambda?: number; // group fairness↔efficiency, 0..1
}

const MODE_CODE: Record<Mode, string> = { transit: 's', bike: 'b', car: 'c', walk: 'w' };
const CODE_MODE: Record<string, Mode> = { s: 'transit', b: 'bike', c: 'car', w: 'walk' };
const DAY_CODE: Record<Daypart, string> = { rush: 'r', midday: 'm', evening: 'e', night: 'n' };
const CODE_DAY: Record<string, Daypart> = { r: 'rush', m: 'midday', e: 'evening', n: 'night' };

const pt = (p: Pt) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

export function encodeShare(
  s: Required<Omit<ShareState, 'labelA' | 'labelB' | 'nameA' | 'nameB' | 'favs' | 'solo' | 'extra' | 'lambda'>> & ShareState,
): string {
  const parts = [
    `a=${pt(s.a)}`,
    `b=${pt(s.b)}`,
    s.labelA ? `la=${encodeURIComponent(s.labelA)}` : '',
    s.labelB ? `lb=${encodeURIComponent(s.labelB)}` : '',
    s.nameA ? `na=${encodeURIComponent(s.nameA)}` : '',
    s.nameB ? `nb=${encodeURIComponent(s.nameB)}` : '',
    `am=${s.modesA.map((m) => MODE_CODE[m]).join('')}`,
    `bm=${s.modesB.map((m) => MODE_CODE[m]).join('')}`,
    `t=${s.bias}`,
    `d=${DAY_CODE[s.daypart]}`,
    s.favs && s.favs.length ? `f=${s.favs.join('.')}` : '',
    s.solo ? 's=1' : '',
    // People beyond A/B (group). a=/b= stay for back-compat; p= carries the rest.
    s.extra && s.extra.length
      ? // ',' and ';' are the p= delimiters — URLSearchParams decodes %-escapes
        // before our own split, so strip them from the (cosmetic) name.
        `p=${s.extra.map((e) => `${pt(e.pt)},${MODE_CODE[e.mode]},${encodeURIComponent(e.name.replace(/[,;]/g, ' '))}`).join(';')}`
      : '',
    s.extra && s.extra.length && s.lambda != null ? `l=${Math.round(s.lambda * 100)}` : '',
  ];
  return '#' + parts.filter(Boolean).join('&');
}

function parsePt(v: string | null): Pt | undefined {
  if (!v) return undefined;
  const [lat, lng] = v.split(',').map(Number);
  if (!isFinite(lat) || !isFinite(lng)) return undefined;
  if (lat < 39 || lat > 42 || lng < -76 || lng > -72) return undefined; // sanity: NYC-ish
  return { lat, lng };
}

function parseModes(v: string | null): Mode[] | undefined {
  if (!v) return undefined;
  const modes = [...v].map((c) => CODE_MODE[c]).filter(Boolean);
  return modes.length ? [...new Set(modes)] : undefined;
}

export function parseShare(hash: string): ShareState {
  const out: ShareState = {};
  const raw = hash.replace(/^#/, '');
  if (!raw) return out;
  const q = new URLSearchParams(raw);
  out.a = parsePt(q.get('a'));
  out.b = parsePt(q.get('b'));
  out.labelA = q.get('la') ?? undefined;
  out.labelB = q.get('lb') ?? undefined;
  out.nameA = q.get('na')?.slice(0, 16).trim() || undefined;
  out.nameB = q.get('nb')?.slice(0, 16).trim() || undefined;
  out.modesA = parseModes(q.get('am'));
  out.modesB = parseModes(q.get('bm'));
  const t = Number(q.get('t'));
  if (isFinite(t) && t >= -20 && t <= 20) out.bias = Math.round(t / 5) * 5;
  const d = q.get('d');
  if (d && CODE_DAY[d]) out.daypart = CODE_DAY[d];
  const f = q.get('f');
  if (f) out.favs = f.split('.').filter((id) => /^[nwrs]\d+$/.test(id)); // n/w/r = OSM, s = supplement
  if (q.get('s') === '1') out.solo = true;
  const p = q.get('p');
  if (p) {
    const extra = p
      .split(';')
      .map((chunk) => {
        const [lat, lng, mc, ...nameParts] = chunk.split(',');
        const ept = parsePt(`${lat},${lng}`);
        const mode = CODE_MODE[mc];
        if (!ept || !mode) return null;
        return { pt: ept, mode, name: decodeURIComponent(nameParts.join(',')).slice(0, 16).trim() };
      })
      .filter((e): e is { pt: Pt; mode: Mode; name: string } => e !== null);
    if (extra.length) out.extra = extra;
  }
  const lRaw = q.get('l');
  if (lRaw != null) {
    const l = Number(lRaw);
    if (isFinite(l) && l >= 0 && l <= 100) out.lambda = l / 100;
  }
  return out;
}
