/* Renders shared state onto the existing option cards.
 *
 * Progressive enhancement, deliberately: the cards are real HTML in the page.
 * If this script throws, fails to load, or the worker is unreachable, the
 * itinerary still reads exactly as it did before. It never renders blank.
 *
 * DOM is matched to data by the data-slot / data-opt attributes baked in by
 * tools/extract.cjs --annotate, not by comparing option text, so rewording a
 * card can't silently unhook it.
 */
(function () {
  'use strict';

  var slots = window.TRIP_SLOTS || [];
  var Store = window.TripStore;
  var Exclusion = window.Exclusion;
  if (!slots.length || !Store || !Exclusion) return;   // leave the static page alone

  var byId = {};
  slots.forEach(function (s) { byId[s.id] = s; });

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /* ---------- painting ---------- */

  function paint() {
    var resolved;
    try { resolved = Exclusion.resolve(slots, Store.choices()); }
    catch (e) { console.error('[trip] exclusion failed, leaving cards as-is', e); return; }

    resolved.forEach(function (slot) {
      var grid = document.querySelector('[data-slot="' + CSS.escape(slot.id) + '"]');
      if (!grid) return;

      slot.options.forEach(function (opt) {
        var card = grid.querySelector('[data-opt="' + CSS.escape(opt.id) + '"]');
        if (!card) return;

        card.classList.toggle('pick', !!opt.isPicked);
        card.classList.toggle('is-done', !!opt.doneBy && !opt.isPicked);

        // the tag chip
        var top = card.querySelector('.opt-top');
        if (!top) return;
        var tag = top.querySelector('.opt-tag');

        if (opt.isPicked) {
          if (!tag) { tag = h('span', 'opt-tag'); top.appendChild(tag); }
          var by = slot.pickedBy;
          var me = Store.who();
          // Name the other person, not yourself, and never say "someone" just
          // because this device hasn't been paired yet.
          tag.textContent = (by && me && by !== me) ? (by + "'s pick")
                          : (by || me) ? 'Your pick'
                          : 'Pick';
          tag.classList.remove('opt-tag-done');
        } else if (opt.doneBy && !opt.isPicked) {
          if (!tag) { tag = h('span', 'opt-tag'); top.appendChild(tag); }
          tag.textContent = 'Done on Day ' + opt.doneBy.day;
          tag.classList.add('opt-tag-done');
        } else if (tag) {
          tag.remove();
        }
      });
    });

    paintStatus();
    if (window.TripDayMaps) window.TripDayMaps.update(resolved);
  }

  /* ---------- interaction ---------- */

  document.addEventListener('click', function (ev) {
    var card = ev.target.closest && ev.target.closest('.opt-card[data-opt]');
    if (!card) return;
    if (ev.target.closest('a')) return;               // let the Map ↗ link through

    var grid = card.closest('[data-slot]');
    if (!grid) return;
    var slotId = grid.getAttribute('data-slot');
    var optId = card.getAttribute('data-opt');
    var slot = byId[slotId];
    if (!slot) return;

    // Tapping a card that an earlier day already used up clears THAT earlier
    // pick — un-consuming is the only coherent meaning of undo here.
    var resolved = Exclusion.resolve(slots, Store.choices());
    var rSlot = resolved.filter(function (s) { return s.id === slotId; })[0];
    var rOpt = rSlot && rSlot.options.filter(function (o) { return o.id === optId; })[0];

    if (rOpt && rOpt.doneBy && !rOpt.isPicked) {
      if (!confirm('That was already used on Day ' + rOpt.doneBy.day + '. Free it up?')) return;
      Store.pick(rOpt.doneBy.slotId, '');
      return;
    }

    Store.pick(slotId, optId);
  });

  /* ---------- pairing + status ---------- */

  function statusBar() {
    var el = document.getElementById('tripStatus');
    if (el) return el;
    el = h('div', 'trip-status');
    el.id = 'tripStatus';
    document.body.appendChild(el);
    return el;
  }

  function paintStatus() {
    var el = statusBar();
    el.innerHTML = '';
    if (!Store.paired()) {
      var b = h('button', 'trip-pair-btn', 'Sync picks with Lea →');
      b.addEventListener('click', promptPair);
      el.appendChild(b);
      el.classList.add('is-unpaired');
      return;
    }
    el.classList.remove('is-unpaired');
    var pending = Store.pendingCount();
    var dot = h('span', 'trip-dot' + (pending ? ' is-pending' : ''));
    el.appendChild(dot);
    el.appendChild(h('span', 'trip-who', Store.who()));
    if (pending) el.appendChild(h('span', 'trip-pending', pending + ' to sync'));
  }

  function promptPair() {
    var name = prompt('Your name (so the other one knows who picked what):', '');
    if (!name) return;
    var key = prompt('Trip key — ask Angelo, or see .trip-key in the repo:', '');
    if (!key) return;
    Store.pair(name.trim(), key.trim());
    paintStatus();
    Store.refresh();
  }

  Store.onError(function (kind) {
    if (kind !== 'unauthorized') return;
    var el = statusBar();
    el.innerHTML = '';
    var b = h('button', 'trip-pair-btn', 'Trip key rejected — re-enter');
    b.addEventListener('click', promptPair);
    el.appendChild(b);
  });

  /* ---------- boot ---------- */

  Store.onChange(paint);
  paint();          // paint from cache first, before any network call
  Store.start();

  // "Reset my choices" now clears shared state, so say so.
  var reset = document.getElementById('resetChoices');
  if (reset) {
    reset.textContent = 'Reset our choices';
    var fresh = reset.cloneNode(true);              // drop the old localStorage-only handler
    reset.parentNode.replaceChild(fresh, reset);
    fresh.addEventListener('click', function () {
      if (!confirm('Clear every pick, for both of us?')) return;
      Object.keys(Store.choices()).forEach(function (slotId) { Store.pick(slotId, ''); });
    });
  }

  window.TripRender = { paint: paint };
})();
