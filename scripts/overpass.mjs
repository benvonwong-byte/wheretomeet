// Shared Overpass helper: mirrors, retries, polite User-Agent.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'wheretomeet-demo/0.1 (contact: hi@vonwong.com)';

export const NYC_BBOX = '40.55,-74.06,40.92,-73.70';

export async function overpass(query, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const url = MIRRORS[i % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const json = await res.json();
      if (json.remark && /timed out|error/i.test(json.remark)) throw new Error(json.remark);
      return json;
    } catch (err) {
      lastErr = err;
      console.error(`  attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw lastErr;
}
