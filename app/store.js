/* Shared trip state — local-first.
 *
 * localStorage is what renders. Always, instantly. The network only ever
 * upgrades it. On a Tokyo platform with one bar, the itinerary must still open.
 *
 * Choices are per slot with their own timestamp, so if we each pick a different
 * slot offline, both survive the merge. Only a same-slot collision is
 * last-write-wins.
 */
(function (root) {
  'use strict';

  var API = 'https://tokyo2026-sync.jiggsfoo.workers.dev';
  var K = {
    doc: 'tokyo2026.doc',
    key: 'tokyo2026.key',
    who: 'tokyo2026.who',
    queue: 'tokyo2026.queue',
  };
  var POLL_MS = 15000;

  /* localStorage throws in private mode and when site data is blocked. Every
   * access is guarded; the app degrades to in-memory rather than dying. */
  var mem = {};
  function get(k) {
    try { var v = localStorage.getItem(k); return v === null ? mem[k] : v; }
    catch (e) { return mem[k]; }
  }
  function set(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function del(k) {
    delete mem[k];
    try { localStorage.removeItem(k); } catch (e) {}
  }
  function getJSON(k, fallback) {
    var raw = get(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  var listeners = [];
  var etag = null;
  var timer = null;
  var flushing = false;

  var doc = getJSON(K.doc, { version: 0, choices: {}, updatedAt: 0 });

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](doc); } catch (e) { console.error('[trip] listener failed', e); }
    }
  }

  /** Same rule as the worker: per slot, higher `at` wins; ties break on `by`. */
  function merge(base, incoming) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
      var next = incoming[k], prev = out[k];
      if (!next || !next.option) { if (prev && next && next.at >= prev.at) delete out[k]; continue; }
      if (!prev || next.at > prev.at || (next.at === prev.at && next.by > prev.by)) out[k] = next;
    }
    return out;
  }

  function save() { set(K.doc, JSON.stringify(doc)); }

  /* ---------- identity ---------- */

  function who() { return get(K.who) || null; }
  function key() { return get(K.key) || null; }
  function paired() { return !!(who() && key()); }
  function pair(name, tripKey) {
    set(K.who, String(name || '').slice(0, 40));
    set(K.key, String(tripKey || '').trim());
    flush();
  }
  function unpair() { del(K.who); del(K.key); }

  /* ---------- the offline queue ---------- */

  function queued() { return getJSON(K.queue, {}); }
  function enqueue(slotId, pick) {
    var q = queued();
    q[slotId] = pick;
    set(K.queue, JSON.stringify(q));
  }

  function flush() {
    var q = queued();
    if (flushing || !paired() || !Object.keys(q).length) return Promise.resolve();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve();
    flushing = true;

    return fetch(API + '/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key() },
      body: JSON.stringify({ choices: q }),
    })
      .then(function (r) {
        if (r.status === 401) { flushing = false; emitError('unauthorized'); return null; }
        if (!r.ok) { flushing = false; return null; }
        return r.json();
      })
      .then(function (server) {
        flushing = false;
        if (!server) return;
        // Everything we queued is now on the server, so clear only those keys —
        // a pick made while the request was in flight must survive.
        var still = queued(), sent = q, k;
        for (k in sent) if (still[k] && still[k].at === sent[k].at) delete still[k];
        set(K.queue, JSON.stringify(still));
        doc = { version: server.version, choices: merge(doc.choices, server.choices), updatedAt: server.updatedAt };
        save(); emit();
      })
      .catch(function () { flushing = false; });   // offline: the queue waits
  }

  var errorListeners = [];
  function emitError(kind) { errorListeners.forEach(function (f) { try { f(kind); } catch (e) {} }); }

  /* ---------- reads ---------- */

  function pull() {
    var headers = {};
    if (etag) headers['If-None-Match'] = etag;
    return fetch(API + '/state', { headers: headers })
      .then(function (r) {
        if (r.status === 304) return null;
        if (!r.ok) return null;
        etag = r.headers.get('ETag') || etag;
        return r.json();
      })
      .then(function (server) {
        if (!server) return;
        var mergedChoices = merge(doc.choices, server.choices || {});
        var changed = JSON.stringify(mergedChoices) !== JSON.stringify(doc.choices);
        doc = { version: server.version, choices: mergedChoices, updatedAt: server.updatedAt };
        save();
        if (changed) emit();
      })
      .catch(function () {});                       // offline is normal, not an error
  }

  /* ---------- writes ---------- */

  function pick(slotId, optionId) {
    var entry = { option: optionId || '', at: Date.now(), by: who() || 'someone' };
    var next = {};
    next[slotId] = entry;
    doc = { version: doc.version, choices: merge(doc.choices, next), updatedAt: Date.now() };
    save();
    emit();                                          // optimistic: the UI never waits on the network
    enqueue(slotId, entry);
    flush();
  }

  /* ---------- polling ---------- */

  function visible() { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }
  function tick() { if (visible()) { pull(); flush(); } }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, POLL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', tick);
      window.addEventListener('online', tick);
      document.addEventListener('visibilitychange', function () { if (visible()) tick(); });
    }
  }

  root.TripStore = {
    get doc() { return doc; },
    choices: function () { return doc.choices; },
    onChange: function (fn) { listeners.push(fn); return fn; },
    onError: function (fn) { errorListeners.push(fn); return fn; },
    pick: pick,
    who: who,
    paired: paired,
    pair: pair,
    unpair: unpair,
    start: start,
    refresh: tick,
    pendingCount: function () { return Object.keys(queued()).length; },
    reset: function () {
      doc = { version: doc.version, choices: {}, updatedAt: Date.now() };
      del(K.queue); save(); emit();
    },
    _merge: merge,
    API: API,
  };
})(typeof self !== 'undefined' ? self : this);
