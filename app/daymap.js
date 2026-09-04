/* Per-day overview map: numbered pins in visit order, joined by a route line.
 *
 * Reflects the current picks, so choosing Hakone for Day 2 redraws Day 2. Fixed
 * stops (hotel, stations, scheduled sights) always appear; chosen options are
 * slotted in by time.
 *
 * Pins and lines come from cached data and work offline. The OSM *tiles* need
 * signal — the map degrades to numbered markers on grey, which is still the
 * useful half.
 */
(function () {
  'use strict';

  var places = window.TRIP_PLACES || [];
  var DAY_COLOR = { '1': '#C0362C', '2': '#A8641C', '3': '#2E7D4F', '4': '#6B4FB0', 'rain': '#6E6A66' };
  var maps = {};
  var lastResolved = null;

  if (typeof L === 'undefined') return;            // Leaflet blocked or offline: skip silently

  function minutes(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /** Fixed stops for a day, plus whatever is currently picked, in clock order. */
  function pointsFor(day, resolvedSlots) {
    var dayNum = day === 'rain' ? 5 : parseInt(day, 10);

    // Which destinations are actually picked today? A fixed stop tied to a
    // destination (Okutama Station) must not show when we picked another one.
    var pickedGroups = {};
    (resolvedSlots || []).forEach(function (slot) {
      if (String(slot.day) !== String(day)) return;
      slot.options.forEach(function (o) {
        if (!o.isPicked) return;
        if (o.group) pickedGroups[o.group] = true;
        (o.alsoConsumes || []).forEach(function (g) { pickedGroups[g] = true; });
      });
    });

    var out = places
      .filter(function (p) {
        if (p.day !== dayNum || !p.lat || minutes(p.time) === null) return false;
        return !p.group || pickedGroups[p.group];
      })
      .map(function (p) {
        return { lat: p.lat, lon: p.lon, name: p.name, time: p.time, at: minutes(p.time), fixed: true };
      });

    (resolvedSlots || []).forEach(function (slot) {
      if (String(slot.day) !== String(day)) return;
      slot.options.forEach(function (o) {
        if (!o.isPicked || !o.lat) return;
        // A whole-day fork often has no clock time — it IS the day. Sort it to
        // the front so the route reads hotel -> destination -> stops, not
        // stops -> destination. Timeless detail slots still sort last.
        var at = minutes(slot.time);
        if (at == null) at = slot.scope === 'fork' ? -1 : 9999;
        out.push({ lat: o.lat, lon: o.lon, name: o.name, time: slot.time || '', at: at, fixed: false });
      });
    });

    out.sort(function (a, b) { return a.at - b.at; });

    // collapse consecutive pins at the same spot (a station listed twice, say)
    return out.filter(function (p, i, arr) {
      if (i === 0) return true;
      var prev = arr[i - 1];
      return Math.abs(prev.lat - p.lat) > 1e-4 || Math.abs(prev.lon - p.lon) > 1e-4;
    });
  }

  function numberedIcon(n, color, fixed) {
    return L.divIcon({
      className: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      html: '<div style="width:24px;height:24px;border-radius:50%;background:' + color +
            ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);color:#fff;' +
            'font:600 12px/20px Inter,sans-serif;text-align:center;' +
            (fixed ? '' : 'outline:2px dashed ' + color + ';outline-offset:2px;') + '">' + n + '</div>',
    });
  }

  function ensureMap(day) {
    if (maps[day]) return maps[day];
    var panel = document.querySelector('.day-panel[data-day="' + day + '"]');
    if (!panel) return null;

    /* Each day already had a static OSM iframe with one hardcoded marker — which
     * pointed at a fixed destination even after you picked a different one.
     * Take its place rather than stacking a second map beside it. */
    var host = document.createElement('div');
    host.className = 'daymap';
    host.id = 'daymap-' + day;

    var iframe = panel.querySelector('.day-media iframe');
    if (iframe) {
      iframe.parentNode.replaceChild(host, iframe);
      var cap = panel.querySelector('.day-media .cap span:last-child');
      if (cap) cap.textContent = 'Today in order';
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'daymap-wrap';
      wrap.innerHTML = '<div class="daymap-head"><b>Today in order</b>' +
        '<span class="daymap-hint">solid = fixed · dashed = your pick</span></div>';
      wrap.appendChild(host);
      var stops = panel.querySelector('.stops');
      if (stops) stops.parentNode.insertBefore(wrap, stops);
      else panel.appendChild(wrap);
    }

    var map = L.map('daymap-' + day, {
      scrollWheelZoom: false,
      attributionControl: false,
    }).setView([35.69, 139.70], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

    maps[day] = { map: map, layer: L.layerGroup().addTo(map) };
    return maps[day];
  }

  function draw(day, resolvedSlots) {
    var m = ensureMap(day);
    if (!m) return;
    var pts = pointsFor(day, resolvedSlots);
    m.layer.clearLayers();
    if (!pts.length) return;

    var color = DAY_COLOR[day] || '#C0362C';
    var latlngs = pts.map(function (p) { return [p.lat, p.lon]; });

    L.polyline(latlngs, { color: color, weight: 3, opacity: 0.55, dashArray: '6,6' }).addTo(m.layer);

    pts.forEach(function (p, i) {
      L.marker([p.lat, p.lon], { icon: numberedIcon(i + 1, color, p.fixed) })
        .bindPopup('<b>' + (p.time ? p.time + ' — ' : '') + p.name + '</b>')
        .addTo(m.layer);
    });

    try { m.map.fitBounds(L.latLngBounds(latlngs).pad(0.18)); } catch (e) {}
    setTimeout(function () { m.map.invalidateSize(); }, 0);
  }

  function update(resolvedSlots) {
    lastResolved = resolvedSlots;
    ['1', '2', '3', '4', 'rain'].forEach(function (d) { draw(d, resolvedSlots); });
  }

  // a hidden tab has zero size when Leaflet initialises, so re-measure on switch
  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest && ev.target.closest('.tab');
    if (!tab) return;
    setTimeout(function () {
      var d = tab.getAttribute('data-day');
      if (!maps[d]) return;
      maps[d].map.invalidateSize();
      draw(d, lastResolved);          // recompute bounds now the panel has a size
    }, 60);
  });

  window.TripDayMaps = { update: update, draw: draw };
})();
