/* ==============================================================
   SWISH STUDIO FINDER  -  Designer-native build
   VERSION 1 (2026-09-28)
   Host this file (see the runbook: GitHub + jsDelivr) and load it with a
   script tag. Do NOT paste it into Webflow custom code - it will not fit.

   This script renders NO markup of its own. Every visible element -
   region rows, location cards, map pins, popups - is a real Webflow
   element you style in the Designer. The script only:

     1. reads CMS values off data attributes
     2. shows and hides elements
     3. clones your pin template onto a Google Map
     4. manages state, camera and URL

   So a design change is a Designer change, not a code change.
   ============================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     1. CONFIG - the only block you should need to edit
     ------------------------------------------------------------ */
  var SF_CONFIG = {
    // Browser key, referrer-restricted to swishsmiles.com and *.webflow.io
    googleMapsApiKey: '',

    // Swish map ID. Restyle in Google Cloud -> Map Management and every
    // instance updates with no redeploy.
    googleMapId: 'e3703c13a1935c6b15bc653a',

    cityPagePattern: '/regions/{slug}',

    // Collapse the Rich text Address onto one line in the card and popup.
    // Set false to keep whatever line breaks the CMS has.
    flattenAddress: true,

    cityPadding:     72,   // px of breathing room when fitting a region
    maxCityZoom:     14,
    /* px the active pin sits below the map centre when a card is clicked.
       Give it roughly half your popup's height. 0 centres the pin exactly. */
    activePinOffsetY: 90,
    /* Hovering a studio card opens its pin popup and moves the camera to
       it, the way clicking does. Only on devices that actually hover
       (mouse, trackpad) - touch screens keep the tap behaviour.
       hoverCenter false = pan only when the pin is off-screen. */
    hoverPreview: true,
    hoverDelayMs: 120,       // ignores the cards the pointer merely crosses
    hoverCenter: true,
    /* Zoom to reach when a card is hovered or clicked, if the map is
       currently further out. 0 = keep the current zoom and only pan. */
    focusZoom: 13,
    /* Base duration of the camera move to a pin, ms. Longer moves stretch
       up to about double. 0 = jump with no animation. */
    glideMs: 450,
    maxOverviewZoom: 9,    // stops 3 nearby Texas regions zooming to street level
    fallbackCenter:  { lat: 30.4, lng: -97.7 },
    fallbackZoom:    8,

    lazyLoadMargin: '400px',

    /* Scroll the whole section into view when the visitor opens a region or
       goes back. Off, because the finder is a fixed-height panel that is
       already on screen - jumping the page up to the heading is just motion
       the visitor did not ask for. Turn on if you ever place the finder
       low on a long page where a tap would otherwise do nothing visible. */
    scrollIntoView: false,

    /* Write the open region into the address bar as ?city=austin. Gives
       shareable links and Back-button history between regions. false keeps
       the URL untouched; pages with data-default-city never write it. */
    urlSync: false,

    /* When the card's Book link is hidden by the Designer (a mobile
       breakpoint, usually), a tap anywhere on the card follows it instead.
       'book' = the Book an Appointment link, 'page' = the studio page link,
       false = the card only focuses its pin. */
    cardTapWhenButtonHidden: 'book',

    // Address search. Needs the Places API (New) enabled on the same key.
    // Billed per session, separate from map loads - see the runbook.
    searchCountries: ['us'],
    searchMinChars: 3,      // below this, no request is made at all
    searchDebounceMs: 250,  // one request per pause, not per keystroke

    // "Use my location" button. Costs nothing - the browser supplies the
    // coordinates, so no Places or Geocoding call is made.
    currentLocationLabel: 'Current location',
    searchHeading: 'Nearest Studios',   // replaces the region name above a search result list
    locateTimeoutMs: 10000,
    locateMaxAgeMs: 300000,  // a fix from the last 5 min is good enough
    distanceUnit: 'mi',          // 'mi' or 'km'
    maxSearchResults: 0          // 0 = show all, sorted nearest first
  };

  /* Per-site overrides, set on the page BEFORE this file loads:

       <script>window.SF_SETTINGS = { googleMapsApiKey: 'AIza...' };</script>
       <script defer src="https://cdn.../studio-finder.js"></script>

     This is what lets the file live on a CDN instead of being pasted into
     Webflow's custom code, where it was using 49,638 of the 50,000
     characters available. Anything site-specific - the key above all -
     stays on the page; the logic is shared and versioned. */
  if (window.SF_SETTINGS) {
    for (var k in window.SF_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(window.SF_SETTINGS, k)) {
        SF_CONFIG[k] = window.SF_SETTINGS[k];
      }
    }
  }

  /* ------------------------------------------------------------
     2. HELPERS
     ------------------------------------------------------------ */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function txt(v) { return v == null ? '' : String(v).trim(); }
  function csv(v) {
    return txt(v).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  function fill(pattern, slug) { return pattern.replace('{slug}', slug); }

  /* Webflow renders a Rich text Address as separate paragraphs, or with
     line-break tags, so it stacks over two or three lines. Neither collapses
     to one line with styling alone. This flattens it to
     "7300 Ranch Rd 2222, Suite 216, Austin, TX 78730" and rewrites the
     element in place, so the card and the map popup both read as one
     line with nothing to configure in the Designer.
     Set SF_CONFIG.flattenAddress = false to keep the CMS formatting. */
  function flattenAddress(el) {
    if (!el) return '';
    var SEP = '||SF||';
    // \u003C is '<'. Written as an escape so Webflow's code prettifier
    // does not read these regexes as unterminated HTML tags.
    var marked = el.innerHTML
      .replace(/\u003Cbr\s*\/?>/gi, SEP)
      .replace(/\u003C\/(p|div|li|h[1-6])>/gi, SEP);
    var decoder = document.createElement('textarea');
    decoder.innerHTML = marked.replace(/\u003C[^>]*>/g, '');
    var line = decoder.value
      .split(SEP)
      .map(function (s) { return s.replace(/\s+/g, ' ').trim().replace(/,$/, ''); })
      .filter(Boolean)
      .join(', ');
    if (SF_CONFIG.flattenAddress !== false) el.textContent = line;
    return line;
  }

  /* Hide the Collection Item, not the div inside it. Hiding the inner
     div leaves an empty grid/flex cell and the layout gaps stay. */
  function hideTarget(el) { return el.closest('.w-dyn-item') || el; }
  function setHidden(el, hidden) {
    hideTarget(el).classList.toggle('sf-hidden', !!hidden);
  }

  /* Straight-line distance. Deliberately NOT the Distance Matrix API -
     that is billed per element and would cost 25 calls per search for a
     number the user reads as "roughly how far". Tend shows straight-line
     miles too. */
  function distanceBetween(a, b) {
    var R = SF_CONFIG.distanceUnit === 'km' ? 6371 : 3958.8;
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function formatDistance(d) {
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' ' + SF_CONFIG.distanceUnit;
  }

  function boundsOf(points) {
    var lats = points.map(function (p) { return p.lat; });
    var lngs = points.map(function (p) { return p.lng; });
    return {
      north: Math.max.apply(null, lats), south: Math.min.apply(null, lats),
      east:  Math.max.apply(null, lngs), west:  Math.min.apply(null, lngs)
    };
  }

  /* ------------------------------------------------------------
     3. MAP PIN - cloned from your Designer template
     ------------------------------------------------------------ */
  /* Decide whether the popup opens upward or downward.

     The old version only asked "is there room above?" and flipped below if
     not - without checking that below was any better. A pin low in the map
     would flip into an edge that clips it harder. Now it flips only when
     below genuinely has more room, so the worst case is a popup trimmed by
     a few pixels rather than one hanging half outside the map. */
  function positionTip(el, container) {
    el.classList.remove('sf-pin--below');
    var tip = el.querySelector('[data-sf-tip]');
    if (!tip) return;
    var pin = el.getBoundingClientRect(), box = container.getBoundingClientRect();
    var need = tip.offsetHeight + 16;
    var roomAbove = pin.top - box.top;
    var roomBelow = box.bottom - pin.bottom;
    if (roomAbove < need && roomBelow > roomAbove) el.classList.add('sf-pin--below');
  }

  /* Fill one cloned pin from a location record. Every slot is optional:
     delete it from the Designer template and this silently skips it. */
  function fillPin(node, loc, withTip) {
    var set = function (sel, fn) {
      var t = node.querySelector(sel);
      if (t) fn(t);
    };

    if (!withTip) {
      var tip = node.querySelector('[data-sf-tip]');
      if (tip) tip.parentNode.removeChild(tip);
      return node;
    }

    set('[data-sf-tip-image]', function (t) {
      if (loc.imageUrl) { t.setAttribute('src', loc.imageUrl); t.setAttribute('alt', loc.name); }
      else { hideTarget(t).style.display = 'none'; }
    });
    set('[data-sf-tip-name]',    function (t) { t.textContent = loc.name; });
    set('[data-sf-tip-address]', function (t) { t.innerHTML   = loc.addressHtml; });
    set('[data-sf-tip-hours]',   function (t) { t.innerHTML   = loc.hoursHtml; });
    set('[data-sf-tip-phone]',   function (t) {
      if (!loc.phone) { t.style.display = 'none'; return; }
      t.setAttribute('href', 'tel:' + loc.phone.replace(/[^\d+]/g, ''));
      var label = t.querySelector('[data-sf-tip-phone-text]');
      (label || t).textContent = loc.phone;
    });
    set('[data-sf-tip-book]', function (t) {
      if (loc.bookUrl) t.setAttribute('href', loc.bookUrl);
      else t.style.display = 'none';
    });
    set('[data-sf-tip-link]', function (t) {
      if (loc.pageUrl) t.setAttribute('href', loc.pageUrl);
    });
    return node;
  }

  /* ------------------------------------------------------------
     4. GOOGLE MAPS ADAPTER
     Four methods. Moving to Mapbox later means rewriting these four
     and nothing else in the file.
     ------------------------------------------------------------ */
  /* Google's bootstrap loader, written out readably.

     Why not just append the script tag and resolve on onload: with
     loading=async the script is a small bootstrap, and onload fires
     BEFORE google.maps.importLibrary exists - which produced
     "google.maps.importLibrary is not a function". This defines
     importLibrary synchronously and queues calls until the API is ready.
     It also repairs the case where something else on the page has already
     created a partial window.google.maps without importLibrary. */
  function bootstrapMaps(params) {
    var w = window;
    var goog = w.google || (w.google = {});
    var maps = goog.maps || (goog.maps = {});
    if (typeof maps.importLibrary === 'function') return;   // already usable

    var wanted = {};
    var loading = null;
    var CALLBACK = '__sfMapsReady__';

    function startLoad() {
      if (loading) return loading;
      loading = new Promise(function (resolve, reject) {
        var qs = new URLSearchParams();
        qs.set('libraries', Object.keys(wanted).join(','));
        for (var k in params) {
          qs.set(k.replace(/[A-Z]/g, function (t) { return '_' + t[0].toLowerCase(); }), params[k]);
        }
        qs.set('callback', 'google.maps.' + CALLBACK);
        maps[CALLBACK] = resolve;
        var el = document.createElement('script');
        el.src = 'https://maps.googleapis.com/maps/api/js?' + qs;
        el.async = true;
        el.onerror = function () { reject(new Error('Google Maps could not load')); };
        document.head.appendChild(el);
      });
      return loading;
    }

    // Once the real API lands it replaces this with its own importLibrary,
    // so the inner call below resolves against the real one.
    maps.importLibrary = function (name) {
      wanted[name] = true;
      return startLoad().then(function () { return maps.importLibrary(name); });
    };
  }

  function loadMapsScript() {
    if (window.google && window.google.maps &&
        typeof window.google.maps.importLibrary === 'function') {
      return Promise.resolve();
    }
    if (!SF_CONFIG.googleMapsApiKey) {
      return Promise.reject(new Error('No Google Maps API key set'));
    }
    bootstrapMaps({ key: SF_CONFIG.googleMapsApiKey, v: 'weekly' });
    return Promise.resolve();
  }

  function GoogleAdapter(container, pinTemplate) {
    var map, markers = {}, activeSlug = null, glideFrame = null;

    /* Animate the camera to a centre and zoom ourselves.

       Google's panTo only animates when the destination is closer than one
       viewport; anything further, or any pan combined with a zoom change,
       snaps instantly. With studios 40 km apart that meant hovering Bee Cave
       glided and hovering Hutto jumped - the "sometimes there is motion"
       inconsistency. Driving moveCamera per frame gives the same eased
       movement every time, whatever the distance. Interpolation is done in
       projected (Mercator) space so the path is straight on screen. A new
       glide cancels the one in flight, so sweeping the list never queues
       up a backlog of moves. */
    function glide(center, zoom, onDone) {
      if (glideFrame) { cancelAnimationFrame(glideFrame); glideFrame = null; }
      /* Markers redraw a frame after moveCamera, so anything that wants to
         measure the landed pin has to wait one more frame. */
      function done() { if (onDone) requestAnimationFrame(function () { requestAnimationFrame(onDone); }); }

      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var proj = map.getProjection && map.getProjection();
      var from = map.getCenter && map.getCenter();
      if (reduce || !proj || !from || SF_CONFIG.glideMs === 0) {
        map.moveCamera({ center: center, zoom: zoom });
        done();
        return;
      }

      var p0 = proj.fromLatLngToPoint(from);
      var p1 = proj.fromLatLngToPoint(new google.maps.LatLng(center.lat, center.lng));
      var z0 = map.getZoom(), z1 = zoom;
      /* Longer moves get a little more time, capped so it never drags. */
      var dist = Math.sqrt(Math.pow(p1.x - p0.x, 2) + Math.pow(p1.y - p0.y, 2)) * Math.pow(2, z1);
      var ms = Math.max(SF_CONFIG.glideMs || 450, Math.min(900, dist * 0.4));
      var t0 = null;

      function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
      function step(now) {
        if (t0 === null) t0 = now;
        var t = Math.min(1, (now - t0) / ms), e = ease(t);
        var ll = proj.fromPointToLatLng(new google.maps.Point(
          p0.x + (p1.x - p0.x) * e, p0.y + (p1.y - p0.y) * e));
        map.moveCamera({ center: { lat: ll.lat(), lng: ll.lng() }, zoom: z0 + (z1 - z0) * e });
        if (t < 1) glideFrame = requestAnimationFrame(step);
        else { glideFrame = null; done(); }
      }
      glideFrame = requestAnimationFrame(step);
    }

    /* Popups share one layout, so the last popup's measured height is a good
       guess for the next one before its photo has loaded. Used when working
       out how far below centre to park the pin, so the space reserved above
       it is right the first time rather than after the image arrives. */
    var lastTipH = 0;
    function rememberTip(node) {
      var tip = node.querySelector('[data-sf-tip]');
      if (tip && tip.offsetHeight > lastTipH) lastTipH = tip.offsetHeight;
    }

    return {
      init: function () {
        return loadMapsScript()
          .then(function () { return google.maps.importLibrary('maps'); })
          .then(function (lib) {
            map = new lib.Map(container, {
              center: SF_CONFIG.fallbackCenter,
              zoom: SF_CONFIG.fallbackZoom,
              mapId: SF_CONFIG.googleMapId,
              disableDefaultUI: true,
              zoomControl: true,
              // Without this a phone user's page scroll gets captured by
              // the map and the page freezes under their thumb.
              gestureHandling: 'cooperative'
            });
          });
      },

      render: function (points, opts) {
        opts = opts || {};
        return google.maps.importLibrary('marker').then(function (lib) {
          Object.keys(markers).forEach(function (k) { markers[k].marker.map = null; });
          markers = {};
          points.forEach(function (p) {
            var node = fillPin(pinTemplate.cloneNode(true), p, !!opts.tip);
            var m = new lib.AdvancedMarkerElement({
              map: map, position: { lat: p.lat, lng: p.lng }, content: node, title: p.name
            });
            node.addEventListener('click', function (e) {
              if (e.target.closest('a')) return;        // let popup links work
              e.stopPropagation();
              container.dispatchEvent(new CustomEvent('sf:pinclick', { detail: p, bubbles: true }));
            });
            markers[p.slug] = { marker: m, el: node };
          });
        });
      },

      flyTo: function (target, maxZoom) {
        if (!map || !target) return;
        if (target.north !== undefined) {
          var b = target;
          // A single point makes zero-size bounds; pad it or fitBounds
          // slams to maximum zoom.
          if (b.north === b.south && b.east === b.west) {
            b = { north: b.north + 0.02, south: b.south - 0.02,
                  east:  b.east  + 0.02, west:  b.west  - 0.02 };
          }
          map.fitBounds(b, SF_CONFIG.cityPadding);
          google.maps.event.addListenerOnce(map, 'idle', function () {
            if (maxZoom && map.getZoom() > maxZoom) map.setZoom(maxZoom);
          });
        } else {
          map.panTo(target);
          if (maxZoom) map.setZoom(maxZoom);
        }
      },

      /* Recentre the map on one marker.

         Pan only, never zoom - re-zooming on every card click makes the map
         lurch and undoes the region framing the visitor just got.

         The pin is placed slightly BELOW the centre rather than dead centre,
         so its popup has room to open upward instead of being clipped by the
         top edge. Done by shifting the target centre north in world
         coordinates, which is one animation; panTo followed by panBy would
         visibly move twice. */
      centerOn: function (slug, onDone) {
        if (!map || !slug || !markers[slug]) { if (onDone) onDone(); return; }
        var pos = markers[slug].marker.position;
        if (!pos) { if (onDone) onDone(); return; }
        var lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
        var lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;

        /* How far below centre the pin should sit. The configured value is a
           floor, not the answer: a 450px popup on a 718px map needs the pin
           pushed further down than 90px or it cannot fit above no matter
           what. Work out what this popup actually needs, then clamp so the
           pin never lands off the bottom edge. */
        var dy = SF_CONFIG.activePinOffsetY || 0;
        var tip = markers[slug].el.querySelector('[data-sf-tip]');
        var boxH = container.getBoundingClientRect().height;
        if (tip && boxH) {
          /* The photo may not have loaded yet, so the popup can still be short;
             reserve for the tallest popup seen so far instead. */
          var tipH = Math.max(tip.offsetHeight, lastTipH);
          var needed = tipH + 24 - boxH / 2;
          if (needed > dy) dy = needed;
          var maxDy = boxH / 2 - 60;              // keep the pin on the map
          if (dy > maxDy) dy = maxDy;
          if (dy < 0) dy = 0;
        }

        /* Zoom in if the map is further out than focusZoom, never out. The
           offset below is computed at the TARGET zoom, because that is the
           scale the pin will be drawn at once the camera settles. */
        var zoom = map.getZoom();
        var targetZoom = zoom;
        if (SF_CONFIG.focusZoom && zoom < SF_CONFIG.focusZoom) targetZoom = SF_CONFIG.focusZoom;

        var target = { lat: lat, lng: lng };
        if (dy) {
          try {
            var proj = map.getProjection();          // undefined until first idle
            if (proj) {
              var scale = Math.pow(2, targetZoom);
              var pt = proj.fromLatLngToPoint(new google.maps.LatLng(lat, lng));
              var ll = proj.fromPointToLatLng(
                new google.maps.Point(pt.x, pt.y - dy / scale)
              );
              target = { lat: ll.lat(), lng: ll.lng() };
            }
          } catch (err) { /* fall back to centring on the pin itself */ }
        }
        glide(target, targetZoom, onDone);
      },

      /* True when the pin is inside the current viewport, or when that
         cannot be known yet (no bounds before the first idle) - in which
         case not panning is the safer default. */
      isInView: function (slug) {
        if (!map || !slug || !markers[slug]) return true;
        var pos = markers[slug].marker.position;
        var bounds = map.getBounds && map.getBounds();
        if (!pos || !bounds) return true;
        try { return bounds.contains(pos); } catch (err) { return true; }
      },

      setActive: function (slug, center) {
        if (activeSlug && markers[activeSlug]) {
          markers[activeSlug].el.classList.remove('sf-pin--active', 'sf-pin--below');
          markers[activeSlug].marker.zIndex = null;   // back into normal order
        }
        activeSlug = slug;
        if (slug && markers[slug]) {
          /* Each marker is its own DOM node with its own stacking order, so a
             z-index inside the popup cannot lift it above a NEIGHBOURING pin.
             Google sorts markers by this property, so raise the open one. */
          markers[slug].marker.zIndex = 9999;
          var node = markers[slug].el;
          node.classList.add('sf-pin--active');

          /* Where the popup opens.

             Centring builds the destination so there is room ABOVE the pin,
             so while the camera is on its way the popup is held above and
             not measured - measuring the pin's pre-glide position (often
             near the top edge) is what used to open it below and then flip
             it up on landing. One measurement when the glide ends, another
             if the photo loads after that and makes the popup taller.

             Without centring, measure now and again on photo load. */
          var settling = false;
          function place() { positionTip(node, container); rememberTip(node); }

          if (center) {
            node.classList.remove('sf-pin--below');
            settling = true;
            this.centerOn(slug, function () {
              if (activeSlug !== slug) return;       // moved on mid-glide
              settling = false;
              place();
            });
          } else {
            place();
          }

          var photo = node.querySelector('[data-sf-tip-image]');
          if (photo && !photo.complete) {
            photo.addEventListener('load', function () {
              if (activeSlug !== slug || settling) return;
              place();
            }, { once: true });
          }
        }
      }
    };
  }

  /* ------------------------------------------------------------
     5. COMPONENT
     ------------------------------------------------------------ */
  function initFinder(root) {
    if (root.dataset.sfReady) return;          // a page may hold several instances
    root.dataset.sfReady = '1';

    var el = {
      mapBox:      root.querySelector('[data-sf-map]'),
      mapCol:      root.querySelector('[data-sf-mapcol]'),
      pinTemplate: root.querySelector('[data-sf-pin-template] [data-sf-pin]'),
      title:       root.querySelector('[data-sf-title]'),
      sub:         root.querySelector('[data-sf-sub]'),
      seoLink:     root.querySelector('[data-sf-seolink]'),
      back:        root.querySelector('[data-sf-back]'),
      count:       root.querySelector('[data-sf-result-count]'),
      empty:       root.querySelector('[data-sf-empty]'),
      overviewEmpty: root.querySelector('[data-sf-overview-empty]'),
      list:        root.querySelector('[data-sf-list]'),
      regionName:  root.querySelector('[data-sf-region-name]'),
      searchBox:   root.querySelector('[data-sf-search]'),
      searchInput: root.querySelector('[data-sf-search-input]'),
      suggestions: root.querySelector('[data-sf-suggestions]'),
      suggestionTemplate: root.querySelector('[data-sf-suggestion-template]'),
      locate:      root.querySelector('[data-sf-locate]'),
      locateError: root.querySelector('[data-sf-locate-error]'),
      searchClear: root.querySelector('[data-sf-search-clear]')
    };
    if (!el.mapBox) { console.warn('[studio-finder] no [data-sf-map] found', root); return; }
    if (!el.pinTemplate) console.warn('[studio-finder] no pin template found - map will have no markers');

    /* ---- forgive the three easy Designer slips around the search ----- */
    /* 1. The search "input" is a plain div. Webflow only offers a Text
          Field inside a Form Block, so the attribute often lands on a div
          with placeholder text typed into it. A div cannot be typed into,
          so swap it for a real <input> carrying the same classes and
          attributes; the div's text becomes the placeholder. */
    if (el.searchInput && !/^(INPUT|TEXTAREA)$/.test(el.searchInput.tagName)) {
      var real = document.createElement('input');
      real.type = 'text';
      Array.prototype.forEach.call(el.searchInput.attributes, function (a) {
        real.setAttribute(a.name, a.value);
      });
      real.placeholder = el.searchInput.getAttribute('placeholder') ||
                         txt(el.searchInput.textContent);
      real.autocomplete = 'off';
      el.searchInput.parentNode.replaceChild(real, el.searchInput);
      el.searchInput = real;
    }
    /* 2. No suggestion row template. Build a bare one - sf-suggestion,
          sf-suggestion-main, sf-suggestion-secondary - so the dropdown
          works; style those classes in the Designer whenever you like. */
    if (el.suggestions && !el.suggestionTemplate) {
      var row = document.createElement('div');
      row.className = 'sf-suggestion';
      row.setAttribute('data-sf-suggestion-template', '');
      var main = document.createElement('div');
      main.className = 'sf-suggestion-main';
      main.setAttribute('data-sf-suggestion-main', '');
      var sec = document.createElement('div');
      sec.className = 'sf-suggestion-secondary';
      sec.setAttribute('data-sf-suggestion-secondary', '');
      row.appendChild(main); row.appendChild(sec);
      el.suggestions.appendChild(row);
      el.suggestionTemplate = row;
    }
    /* 3. The GPS button has the class but not the attribute. */
    if (!el.locate && el.searchBox) el.locate = el.searchBox.querySelector('.sf-locate');

    var state = { view: 'overview', market: null, tag: null, active: null, origin: null, returnTo: null };
    var map = null, mapReady = null;

    /* ---- read the CMS straight off the visible Collection Items ---- */
    function scope() {
      return {
        markets:   csv(root.dataset.markets),
        exMarkets: csv(root.dataset.excludeMarkets),
        locs:      csv(root.dataset.locations),
        exLocs:    csv(root.dataset.excludeLocations),
        tags:      csv(root.dataset.tags)
      };
    }

    function readData() {
      var sc = scope();

      var allMarketEls = [].slice.call(root.querySelectorAll('[data-sf-market]'));
      var markets = allMarketEls.map(function (n) {
        return {
          el:      n,
          slug:    txt(n.dataset.sfMarket),
          name:    txt(n.dataset.name) || txt(n.textContent),
          lat:     num(n.dataset.lat),
          lng:     num(n.dataset.lng),
          heading: txt(n.dataset.heading),
          sub:     txt(n.dataset.sub),
          countEl: n.querySelector('[data-sf-market-count]')
        };
      }).filter(function (m) {
        if (!m.slug) return false;
        if (sc.markets.length && sc.markets.indexOf(m.slug) === -1) return false;
        if (sc.exMarkets.indexOf(m.slug) !== -1) return false;
        return true;
      });

      var locations = [].slice.call(root.querySelectorAll('[data-sf-card]')).map(function (n) {
        var addr  = n.querySelector('[data-sf-address]');
        var hours = n.querySelector('[data-sf-hours]');
        var img   = n.querySelector('[data-sf-image]');
        var link  = n.querySelector('[data-sf-page-link]');
        var book  = n.querySelector('[data-sf-book-link]');
        return {
          el:          n,
          slug:        txt(n.dataset.sfCard),
          market:      txt(n.dataset.market),
          name:        txt(n.dataset.name),
          lat:         num(n.dataset.lat),
          lng:         num(n.dataset.lng),
          phone:       txt(n.dataset.phone),
          tags:        csv(n.dataset.tags),
          addressHtml: flattenAddress(addr),
          hoursHtml:   hours ? hours.innerHTML : '',
          /* The popup photo. Two ways to supply it, so the card design is
             free to drop the thumbnail:
               1. data-image on the card, bound to the CMS Image field
                  (Webflow writes the URL into the attribute), or
               2. an <img data-sf-image> inside the card.
             The attribute wins. Without either, fillPin hides the popup
             image rather than showing a broken one. */
          imageUrl:    txt(n.dataset.image) ||
                       (img ? (img.getAttribute('src') || '') : ''),
          pageUrl:     link  ? link.getAttribute('href') : '',
          bookUrl:     book  ? book.getAttribute('href') : '',
          distanceEl:  n.querySelector('[data-sf-distance]'),
          distance:    null
        };
      }).filter(function (l) {
        if (!l.slug || !l.market || l.lat === null || l.lng === null) return false;
        if (sc.locs.length && sc.locs.indexOf(l.slug) === -1) return false;
        if (sc.exLocs.indexOf(l.slug) !== -1) return false;
        if (sc.tags.length && !sc.tags.some(function (t) { return l.tags.indexOf(t) !== -1; })) return false;
        return true;
      });

      // Group, then drop regions with nothing left to show.
      var byMarket = {};
      locations.forEach(function (l) { (byMarket[l.market] = byMarket[l.market] || []).push(l); });

      var kept = [], byslug = {};
      markets.forEach(function (m) {
        m.locations = byMarket[m.slug] || [];
        if (!m.locations.length) return;          // hidden in the sweep below

        // No Center Latitude / Longitude field needed on Regions. The
        // region pin sits at the centroid of its own locations, which is
        // the middle of where the studios actually are - and it moves on
        // its own when a location is added or closed. Hand-typed
        // coordinates on the Region override it if they ever exist.
        if (m.lat === null || m.lng === null) {
          var n = m.locations.length;
          m.lat = m.locations.reduce(function (s, l) { return s + l.lat; }, 0) / n;
          m.lng = m.locations.reduce(function (s, l) { return s + l.lng; }, 0) / n;
        }

        if (m.countEl) {
          m.countEl.textContent = m.locations.length + ' ' +
            (m.locations.length === 1 ? 'Studio' : 'Studios');
        }
        kept.push(m);
        byslug[m.slug] = m;
      });

      // Hide every region row that did not survive - whether it was cut by
      // the instance scope or simply has no locations left to show.
      allMarketEls.forEach(function (n) {
        setHidden(n, !byslug[txt(n.dataset.sfMarket)]);
      });

      // Region rows should be real links so cmd-click, middle-click and
      // crawlers reach the region page. Webflow can bind that href natively
      // only when the Page picker offers the collection template. When it
      // does not, fill it in from the slug - but never clobber a real one
      // that the Designer already set.
      kept.forEach(function (m) {
        if (m.el.tagName !== 'A') return;
        var href = m.el.getAttribute('href');
        if (!href || href === '#') {
          m.el.setAttribute('href', fill(SF_CONFIG.cityPagePattern, m.slug));
        }
      });

      // Anything the scope excluded is hidden outright, in both states.
      var allowed = {};
      locations.forEach(function (l) { allowed[l.slug] = 1; });
      [].slice.call(root.querySelectorAll('[data-sf-card]')).forEach(function (n) {
        if (!allowed[txt(n.dataset.sfCard)]) setHidden(n, true);
      });

      if (el.overviewEmpty) el.overviewEmpty.style.display = kept.length ? 'none' : '';

      return { markets: kept, byslug: byslug, locations: locations };
    }

    var data = readData();

    /* ---- map ---------------------------------------------------- */
    function ensureMap() {
      if (mapReady) return mapReady;
      map = GoogleAdapter(el.mapBox, el.pinTemplate);
      mapReady = map.init().then(mountSearch).then(paintMap).catch(function (err) {
        console.warn('[studio-finder] map unavailable:', err.message);
        map = null;
        // Fail to a working list rather than a broken layout.
        if (el.mapCol) el.mapCol.style.display = 'none';
      });
      return mapReady;
    }

    function paintMap() {
      if (!map) return;
      if (state.view === 'overview') {
        var pts = data.markets.map(function (m) {
          return { slug: m.slug, name: m.name, lat: m.lat, lng: m.lng };
        });
        map.render(pts, { tip: false });
        map.flyTo(pts.length ? boundsOf(pts) : SF_CONFIG.fallbackCenter, SF_CONFIG.maxOverviewZoom);
        map.setActive(null);
      } else {
        var locs = visibleLocations();
        map.render(locs, { tip: true });
        if (locs.length) {
          // After a search, frame the searched address together with the
          // few nearest studios rather than every result - otherwise one
          // distant location zooms the map out to uselessness.
          var frame = state.origin
            ? locs.slice(0, 3).concat([{ lat: state.origin.lat, lng: state.origin.lng }])
            : locs;
          map.flyTo(boundsOf(frame), SF_CONFIG.maxCityZoom);
        }
        map.setActive(state.active);
      }
    }

    /* ---- address search ------------------------------------------- */
    /* Searching sets an origin point. From then on the panel shows every
       location across every region, nearest first, with a distance on
       each card - which is what someone typing their address actually
       wants. Clearing the search returns to the region flow. */
    function mountSearch() {
      if (!el.searchBox || el.searchBox.dataset.sfMounted) return Promise.resolve();
      el.searchBox.dataset.sfMounted = '1';

      return google.maps.importLibrary('places').then(function (lib) {
        /* Two ways to run the search.

           Preferred: your own input and your own dropdown rows, both real
           Webflow elements. Google's <gmp-place-autocomplete> has a CLOSED
           shadow root, so its field and list cannot be styled at all - this
           path exists so the search can match the rest of the design.

           Fallback: if no [data-sf-search-input] is on the page, mount
           Google's widget as before, so older pages keep working. */
        if (el.searchInput) return customSearch(lib);
        return googleWidget(lib);
      }).catch(function (err) {
        console.warn('[studio-finder] address search unavailable:', err.message);
        el.searchBox.style.display = 'none';
      });
    }

    function googleWidget(lib) {
      var pac = new lib.PlaceAutocompleteElement({
        includedRegionCodes: SF_CONFIG.searchCountries
      });
      el.searchBox.appendChild(pac);
      pac.addEventListener('gmp-select', function (e) {
        usePlace(e.placePrediction.toPlace());
      });
    }

    /* ---- the Designer-native search ------------------------------- */
    function customSearch(lib) {
      var input = el.searchInput;
      var list  = el.suggestions;
      var tpl   = el.suggestionTemplate;
      if (!list || !tpl) {
        console.warn('[studio-finder] search input found but no ' +
          '[data-sf-suggestions] / [data-sf-suggestion-template] - ' +
          'typing will do nothing');
        return;
      }

      /* Detach the template up front. It is authored inside the list so it
         is easy to style in the Designer, but render() empties the list on
         every keystroke - which would destroy it. Holding a detached node
         makes that explicit rather than relying on the reference outliving
         its own markup. */
      if (tpl.parentNode) tpl.parentNode.removeChild(tpl);

      /* Autocomplete is billed per SESSION, not per keystroke, but only if
         every request in one search carries the same token and the token is
         retired by the fetchFields call that follows selection. Without
         this, typing a ZIP costs five billed requests instead of one. */
      var token = null;
      function session() {
        if (!token) token = new lib.AutocompleteSessionToken();
        return token;
      }

      var rows = [];         // the cloned suggestion elements, in order
      var cursor = -1;       // keyboard highlight
      var timer = null;
      var seq = 0;           // drops responses that arrive out of order

      function close() {
        rows = []; cursor = -1;
        list.innerHTML = '';
        list.classList.remove('sf-suggestions--open');
        input.setAttribute('aria-expanded', 'false');
      }

      function highlight(i) {
        cursor = i;
        rows.forEach(function (r, n) {
          r.el.classList.toggle('sf-suggestion--active', n === i);
        });
      }

      function render(suggestions) {
        rows = []; cursor = -1;
        list.innerHTML = '';

        suggestions.forEach(function (s) {
          var p = s.placePrediction;
          if (!p) return;
          var node = tpl.cloneNode(true);
          node.removeAttribute('data-sf-suggestion-template');
          node.setAttribute('data-sf-suggestion', '');

          var main = node.querySelector('[data-sf-suggestion-main]');
          var sub  = node.querySelector('[data-sf-suggestion-secondary]');
          /* mainText / secondaryText are Google's own split - street line
             and city/region. Either slot can be deleted from the template
             and this skips it. */
          if (main) main.textContent = p.mainText ? p.mainText.toString() : p.text.toString();
          if (sub) {
            var second = p.secondaryText ? p.secondaryText.toString() : '';
            if (second) sub.textContent = second;
            else hideTarget(sub).style.display = 'none';
          }
          if (!main && !sub) node.textContent = p.text.toString();

          node.addEventListener('mousedown', function (e) {
            // mousedown, not click: blur fires first and would close the list
            e.preventDefault();
            choose(p);
          });
          list.appendChild(node);
          rows.push({ el: node, prediction: p });
        });

        if (rows.length) {
          list.classList.add('sf-suggestions--open');
          input.setAttribute('aria-expanded', 'true');
        } else {
          close();
        }
      }

      function choose(prediction) {
        input.value = prediction.text.toString();
        close();
        usePlace(prediction.toPlace());
        token = null;                       // selection ends the billing session
      }

      function query(value) {
        var mine = ++seq;
        lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: value,
          sessionToken: session(),
          includedRegionCodes: SF_CONFIG.searchCountries
        }).then(function (res) {
          if (mine !== seq) return;         // a newer keystroke already won
          render(res.suggestions || []);
        }).catch(function (err) {
          console.warn('[studio-finder] suggestions failed:', err.message);
          close();
        });
      }

      /* Webflow only lets you place a Text Field inside a Form Block, so the
         input almost always sits in a real <form>. Left alone, Enter would
         submit it - a page reload, or a Webflow form POST, either way losing
         the search. Guard the form itself rather than relying on every
         keydown path remembering to preventDefault. */
      var form = input.closest('form');
      if (form) {
        form.setAttribute('novalidate', '');
        form.addEventListener('submit', function (e) { e.preventDefault(); });
      }

      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('autocomplete', 'off');

      input.addEventListener('input', function () {
        var v = input.value.trim();
        syncClear();
        clearTimeout(timer);
        if (v.length < SF_CONFIG.searchMinChars) { close(); return; }
        timer = setTimeout(function () { query(v); }, SF_CONFIG.searchDebounceMs);
      });

      input.addEventListener('keydown', function (e) {
        // Enter never submits, with or without suggestions showing.
        if (e.key === 'Enter') e.preventDefault();
        if (!rows.length) {
          if (e.key === 'Escape') input.blur();
          return;
        }
        if (e.key === 'ArrowDown')      { e.preventDefault(); highlight((cursor + 1) % rows.length); }
        else if (e.key === 'ArrowUp')   { e.preventDefault(); highlight((cursor - 1 + rows.length) % rows.length); }
        else if (e.key === 'Enter')     { e.preventDefault(); choose(rows[cursor < 0 ? 0 : cursor].prediction); }
        else if (e.key === 'Escape')    { close(); }
      });

      // A click inside the list is handled by mousedown above, so any other
      // blur means the visitor has moved on.
      input.addEventListener('blur', function () { setTimeout(close, 0); });
    }

    /* ---- use my location ------------------------------------------
       Skips Google entirely - the browser already knows the coordinates,
       and coordinates are all setOrigin needs. No geocoding call, so no
       API cost and one less thing to fail. */
    function mountLocate() {
      if (!el.locate) return;

      /* Geolocation is refused outright on an insecure origin, so the
         button would be a dead control. Hide it rather than let someone
         tap something that can never work. */
      if (!navigator.geolocation || !window.isSecureContext) {
        hideTarget(el.locate).style.display = 'none';
        return;
      }

      el.locate.addEventListener('click', function (e) {
        e.preventDefault();
        if (el.locate.dataset.sfBusy) return;      // ignore repeat taps
        el.locate.dataset.sfBusy = '1';
        el.locate.classList.add('sf-locate--busy');
        locateMessage('');

        navigator.geolocation.getCurrentPosition(function (pos) {
          locateDone();
          if (el.searchInput) el.searchInput.value = SF_CONFIG.currentLocationLabel;
          setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }, function (err) {
          locateDone();
          /* Three distinct failures the visitor can act on differently:
             they blocked it, the device could not get a fix, or it timed
             out. "Something went wrong" would tell them none of that. */
          var msg = err.code === 1
            ? 'Location access is blocked. Type an address instead.'
            : err.code === 3
              ? 'That took too long. Try again, or type an address.'
              : 'Could not work out where you are. Type an address instead.';
          locateMessage(msg);
          console.warn('[studio-finder] geolocation failed:', err.message);
        }, {
          /* City-level accuracy is plenty for "which studio is nearest",
             and high accuracy means GPS: slower, and a battery hit. */
          enableHighAccuracy: false,
          timeout: SF_CONFIG.locateTimeoutMs,
          maximumAge: SF_CONFIG.locateMaxAgeMs
        });
      });
    }

    function locateDone() {
      if (!el.locate) return;
      delete el.locate.dataset.sfBusy;
      el.locate.classList.remove('sf-locate--busy');
    }

    function locateMessage(text) {
      if (!el.locateError) return;
      el.locateError.textContent = text;
      hideTarget(el.locateError).style.display = text ? '' : 'none';
    }

    /* Shared by both search paths: turn a Place into the search origin. */
    function usePlace(place) {
      place.fetchFields({ fields: ['location', 'formattedAddress'] }).then(function () {
        var loc = place.location;
        if (!loc) return;
        setOrigin({
          lat: typeof loc.lat === 'function' ? loc.lat() : loc.lat,
          lng: typeof loc.lng === 'function' ? loc.lng() : loc.lng
        });
      }).catch(function (err) {
        console.warn('[studio-finder] could not resolve that address:', err.message);
      });
    }

    /* The clear control shows whenever there is anything to clear: text in
       the field, or a search already applied. Driven from here rather than
       the Designer because the field's contents are not a state Webflow can
       see. */
    function syncClear() {
      if (!el.searchClear) return;
      var has = !!state.origin || !!(el.searchInput && el.searchInput.value.trim());
      el.searchClear.style.display = has ? '' : 'none';
    }

    function setOrigin(point) {
      /* Remember where the visitor was before the first search, so clearing
         it returns them there - Austin's list, not the region menu. */
      if (!state.origin) state.returnTo = state.market || root.dataset.defaultCity || null;
      state.origin = point;
      state.market = null;
      state.active = null;
      /* Both, not just the attribute: paintMap branches on state.view, and a
         search started from the overview (geolocation, or a future design
         that shows the field there) would otherwise draw region pins over a
         list of studios. */
      state.view = 'city';
      root.setAttribute('data-view', 'city');   // the results panel
      /* The heading still read "Austin" over a list that now spans every
         region. Say what the list actually is; opening a region again
         puts the region name back. */
      if (el.regionName) el.regionName.textContent = SF_CONFIG.searchHeading || 'Nearest Studios';
      /* A flag the stylesheet can read, so anything that only makes sense
         once a distance exists - the divider, the pin glyph, the miles -
         can be hidden as one block rather than leaving orphaned furniture
         beside an empty number. */
      root.setAttribute('data-origin', '1');
      syncClear();
      applyChipVisibility();
      applyCardVisibility();
      ensureMap().then(paintMap);
    }

    /* Wipe the search without touching the view.

       Kept separate from clearOrigin() so that show() can call it on every
       return to the overview without recursing. That is what makes the Back
       control, the browser back button and a pin click all behave the same:
       leaving the location view always leaves the search behind. */
    function resetOrigin() {
      state.origin = null;
      root.removeAttribute('data-origin');
      if (el.searchClear) el.searchClear.style.display = 'none';

      /* Empty the field and shut the dropdown. Our own input is the normal
         case; the gmp-place-autocomplete branch only matters on a page
         still using Google's widget, where the visible field lives in a
         closed shadow root and .value is the only way in. */
      locateMessage('');
      if (el.searchInput) el.searchInput.value = '';
      if (el.suggestions) {
        el.suggestions.innerHTML = '';
        el.suggestions.classList.remove('sf-suggestions--open');
      }

      var pac = el.searchBox && el.searchBox.querySelector('gmp-place-autocomplete');
      if (pac) {
        try { pac.value = ''; } catch (err) {}
        try { pac.setAttribute('value', ''); } catch (err) {}
      }
      if (!el.searchInput) {
        var input = el.searchBox && el.searchBox.querySelector('input');
        if (input) input.value = '';
      }

      data.locations.forEach(function (l) {
        l.distance = null;
        if (l.distanceEl) l.distanceEl.textContent = '';
      });
      syncClear();
    }

    /* The clear control. Text typed but nothing chosen yet: just empty the
       field and shut the dropdown. A search applied: drop it and go back to
       the list the visitor was on before they searched. */
    function clearSearch() {
      if (!state.origin) {
        if (el.searchInput) {
          el.searchInput.value = '';
          el.searchInput.dispatchEvent(new Event('input', { bubbles: true }));  // closes the dropdown
          el.searchInput.focus();
        }
        syncClear();
        return;
      }
      clearOrigin();
    }

    function clearOrigin() {
      var back = state.returnTo;
      state.returnTo = null;
      resetOrigin();
      if (back && data.byslug[back]) show('city', back, { scroll: false });
      else show('overview', null, { scroll: false });
    }

    /* ---- show / hide, no markup generated ------------------------ */
    function visibleLocations() {
      var list;
      if (state.origin && !state.market) {
        list = data.locations.slice();          // search: every region
      } else {
        var m = data.byslug[state.market];
        if (!m) return [];
        list = m.locations.slice();
      }

      list = list.filter(function (l) {
        return !state.tag || l.tags.indexOf(state.tag) !== -1;
      });

      if (state.origin) {
        list.forEach(function (l) { l.distance = distanceBetween(state.origin, l); });
        list.sort(function (a, b) { return a.distance - b.distance; });
        if (SF_CONFIG.maxSearchResults > 0) list = list.slice(0, SF_CONFIG.maxSearchResults);
      }
      return list;
    }

    function applyCardVisibility() {
      var shown = visibleLocations();
      var show = {};
      shown.forEach(function (l) { show[l.slug] = 1; });
      data.locations.forEach(function (l) { setHidden(l.el, !show[l.slug]); });

      // Write the distance onto each card, and reorder the list so the
      // nearest is first. Moving the Collection Item keeps Webflow's
      // layout and gaps intact.
      shown.forEach(function (l) {
        if (l.distanceEl) {
          l.distanceEl.textContent = (state.origin && l.distance != null)
            ? formatDistance(l.distance) : '';
        }
        if (state.origin) {
          var item = hideTarget(l.el);
          if (item.parentNode) item.parentNode.appendChild(item);
        }
      });

      /* "(16)" beside the region name. Parentheses are included so the
         Designer has one text element to style rather than three text
         nodes to keep aligned. After a search the number is the count of
         studios shown; each card carries its own distance, so the old
         "near you" wording added nothing. */
      if (el.count) el.count.textContent = '(' + shown.length + ')';
      if (el.empty) el.empty.style.display = shown.length ? 'none' : '';
      return shown;
    }

    /* Service chips are a Collection List of Services. Hide the ones no
       location in this region offers, so the row never shows a filter
       that returns nothing. */
    function applyChipVisibility() {
      var m = data.byslug[state.market];
      var present = {};
      if (m) m.locations.forEach(function (l) { l.tags.forEach(function (t) { present[t] = 1; }); });
      [].slice.call(root.querySelectorAll('[data-sf-tag]')).forEach(function (chip) {
        var t = txt(chip.dataset.sfTag).toLowerCase();
        setHidden(chip, !present[t]);
        chip.setAttribute('aria-pressed', String(state.tag === t));
        chip.classList.toggle('sf-chip--active', state.tag === t);
      });
    }

    function applyRegionCopy() {
      var m = data.byslug[state.market];
      if (!m) return;
      /* The plain region name for the group heading above the studio list -
         "Austin". Separate from data-sf-title, which carries the CMS heading
         field and is usually a sentence, not a name. */
      if (el.regionName) el.regionName.textContent = m.name;
      if (el.title && m.heading) el.title.textContent = m.heading;
      if (el.sub && m.sub) el.sub.textContent = m.sub;
      if (el.seoLink) {
        el.seoLink.href = fill(SF_CONFIG.cityPagePattern, m.slug);
        var label = el.seoLink.querySelector('[data-sf-seolink-text]');
        if (label) label.textContent = 'View the full ' + m.name + ' page';
      }
    }

    function highlightCard(slug, scroll) {
      data.locations.forEach(function (l) {
        l.el.classList.toggle('sf-card--active', l.slug === slug);
      });
      var found = data.locations.filter(function (l) { return l.slug === slug; })[0];
      if (found && scroll) found.el.scrollIntoView({ block: 'nearest' });
    }

    /* ---- state transitions --------------------------------------- */
    function show(view, marketSlug, opts) {
      opts = opts || {};
      state.view = view;
      state.market = view === 'city' ? marketSlug : null;
      state.active = null;
      state.tag = null;
      root.setAttribute('data-view', view);

      if (view === 'city') {
        applyRegionCopy();
        applyChipVisibility();
        applyCardVisibility();
      } else {
        /* Returning to the region list always drops the search. Distances
           measured from an address are meaningless next to region rows, and
           carrying the origin into the next region silently re-sorts it. */
        resetOrigin();
        if (el.title && el.title.dataset.overviewTitle) el.title.textContent = el.title.dataset.overviewTitle;
        if (el.sub && el.sub.dataset.overviewSub) el.sub.textContent = el.sub.dataset.overviewSub;
      }
      highlightCard(null, false);

      ensureMap().then(paintMap);
      if (opts.push !== false) syncUrl();
      if (opts.scroll && SF_CONFIG.scrollIntoView) {
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      /* The card list is its own scroll container now, and a scroll container
         keeps its scrollTop across a state change. Without this, opening a
         region from halfway down the list drops you into the middle of the
         new region's cards, and Back leaves the region list scrolled too. */
      if (el.list) el.list.scrollTop = 0;

      root.dispatchEvent(new CustomEvent('sf:viewchange', {
        detail: { view: view, market: state.market }, bubbles: true
      }));
    }

    /* Mirror the open region into ?city= so a visitor can share or bookmark
       it and the browser Back button steps through regions. Off when
       urlSync is false, and always off on a page that has its own city
       (data-default-city) - the URL is already the address of that city.
       Reading ?city= on load still works either way, so old links keep
       opening the right region. */
    function syncUrl() {
      if (SF_CONFIG.urlSync === false || root.dataset.defaultCity) return;
      var url = new URL(window.location.href);
      if (state.view === 'city') url.searchParams.set('city', state.market);
      else url.searchParams.delete('city');
      history.pushState({ sfCity: state.market || null }, '', url);
    }

    /* ---- events ---------------------------------------------------- */
    root.addEventListener('click', function (e) {
      // Region row -> open that region in place.
      var row = e.target.closest('[data-sf-market]');
      if (row && root.getAttribute('data-view') === 'overview') {
        // Cmd/ctrl/middle click still opens the real region page.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        show('city', txt(row.dataset.sfMarket), { scroll: true });
        return;
      }

      var clear = e.target.closest('[data-sf-search-clear]');
      if (clear) { e.preventDefault(); clearSearch(); return; }

      var back = e.target.closest('[data-sf-back]');
      if (back) {
        e.preventDefault();
        show('overview', null, { scroll: true });   // show() clears the search
        return;
      }

      var chip = e.target.closest('[data-sf-tag]');
      if (chip) {
        e.preventDefault();
        var t = txt(chip.dataset.sfTag).toLowerCase();
        state.tag = (state.tag === t) ? null : t;
        state.active = null;
        applyChipVisibility();
        applyCardVisibility();
        paintMap();
        return;
      }

      var card = e.target.closest('[data-sf-card]');
      if (card && !e.target.closest('a')) {
        /* The card as the button. When the Designer hides the card's Book
           link at a breakpoint (phones, typically), a tap on the card follows
           that link instead - the hidden button is the switch, so there is
           no breakpoint to keep in sync here. Modifier-clicks open a tab. */
        var follow = hiddenCardLink(card);
        if (follow) {
          e.preventDefault();
          if (e.metaKey || e.ctrlKey || follow.target === '_blank') window.open(follow.href, '_blank');
          else window.location.href = follow.href;
          return;
        }
        state.active = txt(card.dataset.sfCard);
        highlightCard(state.active, false);
        if (map) map.setActive(state.active, true);   // true = recentre on the pin
      }
    });

    /* The link a whole-card tap should follow, or null. Only when the
       configured link exists in the card AND is currently display:none -
       on desktop, where the button shows, the card keeps its focus-the-pin
       behaviour and the button does the navigating. */
    function hiddenCardLink(card) {
      var which = SF_CONFIG.cardTapWhenButtonHidden;
      if (!which) return null;
      var sel = which === 'page' ? '[data-sf-page-link]' : '[data-sf-book-link]';
      var a = card.querySelector(sel);
      if (!a || !a.getAttribute('href') || a.getAttribute('href') === '#') return null;
      /* "Hidden" means not rendered, whichever element carries the
         display:none - the link itself or a wrapper the Designer hid at the
         breakpoint. A hidden element (or one inside a hidden ancestor) has
         no client rects; checking the link's own display would miss the
         wrapper case, which is exactly how it was built on staging. */
      if (a.getClientRects().length > 0) return null;
      return a;
    }

    /* ---- hover preview ------------------------------------------- */
    /* Pointing at a card opens its popup without a click. Gated on the
       (hover: hover) media query so a phone, where "hover" would fire on
       the tap and then race the click, never gets this path.

       mouseover bubbles from every child the pointer crosses inside a card,
       so the slug is remembered and repeats are ignored; the short delay
       means sweeping the pointer down the list opens only the card it
       stops on. The popup stays open on mouseout on purpose - closing it
       would make the Book button inside it unreachable by mouse. */
    var canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    if (SF_CONFIG.hoverPreview && canHover) {
      var hoverSlug = null, hoverTimer = null;

      root.addEventListener('mouseover', function (e) {
        var card = e.target.closest('[data-sf-card]');
        if (!card || root.getAttribute('data-view') !== 'city') return;
        var slug = txt(card.dataset.sfCard);
        if (slug === hoverSlug) return;
        hoverSlug = slug;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () {
          /* Already open (clicked, or hovered before the map was dragged):
             no need to re-open the popup, but do bring the camera back. */
          if (slug === state.active) {
            if (map && SF_CONFIG.hoverCenter) map.centerOn(slug);
            return;
          }
          state.active = slug;
          highlightCard(slug, false);
          if (map) {
            var pan = SF_CONFIG.hoverCenter || !map.isInView(slug);
            map.setActive(slug, pan);
          }
        }, SF_CONFIG.hoverDelayMs || 0);
      });

      root.addEventListener('mouseout', function (e) {
        var card = e.target.closest('[data-sf-card]');
        if (!card) return;
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;   // moved within the card
        hoverSlug = null;
        clearTimeout(hoverTimer);
      });
    }

    el.mapBox.addEventListener('sf:pinclick', function (e) {
      var p = e.detail;
      if (state.view === 'overview') { show('city', p.slug, { scroll: false }); return; }
      state.active = p.slug;
      /* Recentre here too: a pin near the map edge would otherwise open its
         popup half outside the container. */
      if (map) map.setActive(p.slug, true);
      highlightCard(p.slug, true);
    });

    /* Browser Back/Forward. Only react to history entries the finder wrote
       (or to a real change in ?city=): a hash link elsewhere on the page,
       or another script's pushState, also fires popstate, and used to reset
       the finder to the region menu mid-browse. */
    window.addEventListener('popstate', function (e) {
      var ours = e.state && typeof e.state === 'object' && 'sfCity' in e.state;
      if (SF_CONFIG.urlSync === false && !ours) return;

      var city = new URL(window.location.href).searchParams.get('city');
      var want = (city && data.byslug[city]) ? city
               : (root.dataset.defaultCity && data.byslug[root.dataset.defaultCity]) ? root.dataset.defaultCity
               : null;
      var have = state.view === 'city' && !state.origin ? state.market : null;
      if (!ours && want === have) return;          // nothing about the finder changed

      if (want) show('city', want, { push: false });
      else show('overview', null, { push: false });
    });

    /* ---- boot -------------------------------------------------------- */
    // ?city= wins, then the Default region property, then the overview.
    var urlCity = new URL(window.location.href).searchParams.get('city');
    var defCity = root.dataset.defaultCity;
    var boot = (urlCity && data.byslug[urlCity]) ? urlCity
             : (defCity && data.byslug[defCity]) ? defCity
             : null;
    if (boot) show('city', boot, { push: false });
    else { root.setAttribute('data-view', 'overview'); }

    /* Mount the map now.

       This used to wait for an IntersectionObserver so a visitor who never
       scrolled here cost no billable map load. That saving was speculative,
       and IntersectionObserver never fires while a document is hidden or has
       a zero-size viewport - which made "the map is missing" impossible to
       tell apart from "the observer has not run yet". Loading straight away
       trades a little cost for behaviour you can actually debug. */
    /* Not inside ensureMap: geolocation needs nothing from Google, so the
       button should work even if the map fails to load. */
    mountLocate();
    syncClear();          // hidden until there is something to clear

    console.log('[studio-finder] init v27', {
      regions: data.markets.length,
      locations: data.locations.length,
      hasKey: !!SF_CONFIG.googleMapsApiKey,
      pinTemplate: !!el.pinTemplate,
      mapBox: !!el.mapBox
    });
    ensureMap();
  }

  function boot() {
    [].slice.call(document.querySelectorAll('[data-sf]')).forEach(initFinder);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
