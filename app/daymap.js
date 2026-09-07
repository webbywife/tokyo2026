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
  var routes = window.TRIP_ROUTES || [];

  /* Transit directions are a deep link, not a drawn rail line. Real transit
   * geometry needs a routing engine (Google's terms forbid drawing their routes
   * on an OSM map, and JR East publishes no open GTFS) — and a link is the
   * better answer anyway: it gives live departures, platforms and delays that a
   * baked-in polyline never could. */
  function transitUrl(from, to) {
    return 'https://www.google.com/maps/dir/?api=1' +
      '&origin=' + from.lat + ',' + from.lon +
      '&destination=' + to.lat + ',' + to.lon +
      '&travelmode=transit';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Kilometres between two [lat,lon]-ish points. */
  function km(a, b) {
    var rad = Math.PI / 180;
    var x = ((b.lon != null ? b.lon : b[1]) - (a.lon != null ? a.lon : a[1])) * rad *
            Math.cos(((a.lat != null ? a.lat : a[0]) + (b.lat != null ? b.lat : b[0])) / 2 * rad);
    var y = ((b.lat != null ? b.lat : b[0]) - (a.lat != null ? a.lat : a[0])) * rad;
    return Math.sqrt(x * x + y * y) * 6371;
  }

  /* A traced corridor is anchored at stations, but the leg it stands in for runs
   * between whatever we pinned — a cave 6 km up the valley, a shop by the exit.
   * So match generously at both ends, and only for legs long enough that a
   * straight line was actually misleading. */
  var CORRIDOR_TOL_KM = 12;

  function corridorFor(day, a, b) {
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (String(r.day) !== String(day) || !r.path || r.path.length < 2) continue;
      if (Math.max(km(a, r.from), km(b, r.to)) <= CORRIDOR_TOL_KM) return { route: r, path: r.path };
      if (Math.max(km(a, r.to), km(b, r.from)) <= CORRIDOR_TOL_KM)
        return { route: r, path: r.path.slice().reverse() };
    }
    return null;
  }

  function dirLink(from, to, label) {
    return '<a class="daymap-dir" href="' + transitUrl(from, to) +
           '" target="_blank" rel="noopener">🚉 ' + esc(label) + ' ↗</a>';
  }
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
    addFullscreenButton(host, day);
    return maps[day];
  }

  /* ---------- full screen ---------- */

  /* While a map is full screen it covers the tab bar, so the ✕ and Escape are the
   * only ways out — which is why the button grows and stays pinned top-right. */
  function fsButton(host) { return host.querySelector('.daymap-fs-btn'); }

  function addFullscreenButton(host, day) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'daymap-fs-btn';
    btn.textContent = '⤢';
    btn.title = 'Expand map';
    btn.setAttribute('aria-label', 'Expand map to full screen');
    // Leaflet swallows clicks on anything sitting over the map unless told not to.
    if (L.DomEvent) { L.DomEvent.disableClickPropagation(btn); L.DomEvent.disableScrollPropagation(btn); }
    btn.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      toggleFullscreen(day);
    });
    host.appendChild(btn);
  }

  function setFullscreen(day, on) {
    var m = maps[day];
    var host = document.getElementById('daymap-' + day);
    if (!m || !host) return;

    host.classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('daymap-open', on);
    // Scrolling the map area free-hand only makes sense once it owns the screen.
    if (on) m.map.scrollWheelZoom.enable(); else m.map.scrollWheelZoom.disable();

    var btn = fsButton(host);
    if (btn) {
      btn.textContent = on ? '✕' : '⤢';
      btn.title = on ? 'Close full screen' : 'Expand map';
      btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Expand map to full screen');
    }
    // The element just changed size, so Leaflet has to re-measure before the
    // bounds it fits to mean anything.
    setTimeout(function () { m.map.invalidateSize(); draw(day, lastResolved); }, 60);
  }

  function openDay() {
    var el = document.querySelector('.daymap.is-fullscreen');
    return el ? el.id.replace('daymap-', '') : null;
  }

  function toggleFullscreen(day) {
    var host = document.getElementById('daymap-' + day);
    if (host) setFullscreen(day, !host.classList.contains('is-fullscreen'));
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var d = openDay();
    if (d) setFullscreen(d, false);
  });

  function draw(day, resolvedSlots) {
    var m = ensureMap(day);
    if (!m) return;
    var pts = pointsFor(day, resolvedSlots);
    m.layer.clearLayers();
    if (!pts.length) return;

    var color = DAY_COLOR[day] || '#C0362C';
    var latlngs = pts.map(function (p) { return [p.lat, p.lon]; });

    /* One line per leg rather than a single polyline, so each hop can carry its
     * own directions. The visible line is thin, so an invisible fat one sits
     * under it to give a thumb something to hit. */
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], z = pts[i + 1];
      var corr = km(a, z) > CORRIDOR_TOL_KM ? corridorFor(day, a, z) : null;
      var popup = '<b>' + (i + 1) + ' → ' + (i + 2) + '</b><br>' +
                  esc(a.name) + ' <b>→</b> ' + esc(z.name) +
                  (corr ? '<br><span class="daymap-line">' + esc(corr.route.label) +
                          ' · ' + corr.route.km + ' km of track</span>' : '') +
                  dirLink(a, z, 'Transit directions');

      if (corr) {
        /* Solid for real traced track, so it reads differently from the dashed
         * "we go from here to there somehow" line. The stubs join the pins to
         * the railhead, which is honestly the walk/bus at each end. */
        L.polyline(corr.path, { color: color, weight: 4, opacity: 0.85 })
          .bindPopup(popup).addTo(m.layer);
        L.polyline(corr.path, { color: color, weight: 16, opacity: 0 })
          .bindPopup(popup).addTo(m.layer);
        [[[a.lat, a.lon], corr.path[0]], [corr.path[corr.path.length - 1], [z.lat, z.lon]]]
          .forEach(function (stub) {
            L.polyline(stub, { color: color, weight: 2, opacity: 0.4, dashArray: '3,5' }).addTo(m.layer);
          });
      } else {
        var leg = [[a.lat, a.lon], [z.lat, z.lon]];
        L.polyline(leg, { color: color, weight: 3, opacity: 0.55, dashArray: '6,6' })
          .bindPopup(popup).addTo(m.layer);
        L.polyline(leg, { color: color, weight: 16, opacity: 0 })
          .bindPopup(popup).addTo(m.layer);
      }
    }

    pts.forEach(function (p, i) {
      var next = pts[i + 1];
      var html = '<b>' + (p.time ? esc(p.time) + ' — ' : '') + esc(p.name) + '</b>';
      if (next) html += dirLink(p, next, 'Transit to ' + next.name);
      L.marker([p.lat, p.lon], { icon: numberedIcon(i + 1, color, p.fixed) })
        .bindPopup(html)
        .addTo(m.layer);
    });

    var bounds = latlngs.slice();
    for (var c = 0; c < routes.length; c++) {
      if (String(routes[c].day) !== String(day)) continue;
      var near = pts.some(function (p) { return km(p, routes[c].from) <= CORRIDOR_TOL_KM; }) &&
                 pts.some(function (p) { return km(p, routes[c].to) <= CORRIDOR_TOL_KM; });
      if (near) bounds = bounds.concat(routes[c].path);
    }
    try { m.map.fitBounds(L.latLngBounds(bounds).pad(0.12)); } catch (e) {}
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

  window.TripDayMaps = { update: update, draw: draw, fullscreen: setFullscreen };
})();
