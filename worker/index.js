/* Tokyo 2026 — shared trip state.
 *
 * One KV key holds the whole trip. Choices are stored per slot with their own
 * timestamp, NOT as a single blob: if Angelo and Lea each pick a different slot
 * while offline, both survive the merge. Only a genuine same-slot collision
 * resolves last-write-wins.
 *
 *   GET  /state   -> { version, choices, updatedAt }  + ETag
 *   PUT  /state   -> merge submitted slots, bump version, return merged doc
 *   GET  /health  -> ok
 *
 * Reads are open. The payload is a list of Tokyo day trips, and gating reads
 * would mean shipping a read token in a public repo, which defeats the point.
 * Writes require the shared trip key, which lives in a Worker secret and is
 * pasted into each device once — never committed.
 */

const KEY = 'tokyo2026';
const HISTORY_KEEP = 10;
const MAX_BODY = 64 * 1024;   // the whole trip is ~2 KB; this is pure abuse defence
const MAX_SLOTS = 100;

const EMPTY = { version: 0, choices: {}, updatedAt: 0 };

/* ---------- helpers ---------- */

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(), ...extra },
  });

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
    'Access-Control-Max-Age': '86400',
  };
}

const etagFor = doc => `"v${doc.version}"`;

/* Cloudflare rewrites strong ETags to weak (W/"...") when it compresses a
 * response, so the client sends the weak form back. RFC 7232 specifies weak
 * comparison for If-None-Match anyway — strip the prefix before comparing, or
 * every poll returns a full body instead of a 304. */
const weak = tag => (tag || '').replace(/^W\//, '').trim();
const etagMatches = (header, etag) =>
  !!header && header.split(',').some(t => weak(t) === weak(etag));

/** Constant-time-ish compare so the key can't be probed by timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  if (!env.TRIP_KEY) return false;                 // no key configured = no writes
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return safeEqual(token, env.TRIP_KEY);
}

async function load(env) {
  const raw = await env.TRIP.get(KEY, 'json');
  return raw && typeof raw === 'object' ? { ...EMPTY, ...raw } : { ...EMPTY };
}

/**
 * Merge incoming slot picks into the current doc.
 * Per slot the higher `at` wins; equal timestamps break on `by` so the result is
 * deterministic regardless of which device happened to arrive first.
 */
function mergeChoices(current, incoming) {
  const out = { ...current };
  let changed = 0;
  for (const [slotId, pick] of Object.entries(incoming)) {
    if (!pick || typeof pick !== 'object') continue;
    const next = {
      option: String(pick.option || '').slice(0, 120),
      at: Number(pick.at) || 0,
      by: String(pick.by || 'someone').slice(0, 40),
    };
    if (!next.option) {            // an explicit clear
      if (out[slotId]) { delete out[slotId]; changed++; }
      continue;
    }
    const prev = out[slotId];
    const wins = !prev || next.at > prev.at || (next.at === prev.at && next.by > prev.by);
    if (wins && (!prev || prev.option !== next.option || prev.at !== next.at)) {
      out[slotId] = next;
      changed++;
    }
  }
  return { choices: out, changed };
}

/* ---------- handler ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === '/health') return json({ ok: true, ts: Date.now() });
    if (url.pathname !== '/state') return json({ error: 'not found' }, 404);

    /* ----- read ----- */
    if (request.method === 'GET') {
      const doc = await load(env);
      const etag = etagFor(doc);
      if (etagMatches(request.headers.get('If-None-Match'), etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag, ...cors() } });
      }
      return json(doc, 200, { ETag: etag, 'Cache-Control': 'no-store' });
    }

    /* ----- write ----- */
    if (request.method === 'PUT') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

      const body = await request.text();
      if (body.length > MAX_BODY) return json({ error: 'payload too large' }, 413);

      let submitted;
      try { submitted = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }

      const incoming = submitted && submitted.choices;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return json({ error: 'expected { choices: {...} }' }, 400);
      }
      if (Object.keys(incoming).length > MAX_SLOTS) return json({ error: 'too many slots' }, 400);

      const doc = await load(env);
      const { choices, changed } = mergeChoices(doc.choices, incoming);

      if (!changed) {
        // Nothing new. Don't burn a version or a KV write on a no-op poll.
        return json(doc, 200, { ETag: etagFor(doc) });
      }

      const next = { version: doc.version + 1, choices, updatedAt: Date.now() };

      // Keep a short history so a bad write is recoverable.
      await env.TRIP.put(KEY, JSON.stringify(next));
      await env.TRIP.put(`${KEY}:v${next.version}`, JSON.stringify(next), {
        expirationTtl: 60 * 60 * 24 * 30,
      });
      if (next.version > HISTORY_KEEP) {
        await env.TRIP.delete(`${KEY}:v${next.version - HISTORY_KEEP}`).catch(() => {});
      }

      return json(next, 200, { ETag: etagFor(next) });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};

export { mergeChoices };
