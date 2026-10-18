/*
 * Fluid Lyrics — Apple Music-style syllable-fill lyrics for the Spotify desktop client.
 * Injected into xpui.spa by tools/inject.mjs. No Spicetify, no dependencies.
 *
 * Main-thread budget philosophy:
 *   - zero per-frame JavaScript. No requestAnimationFrame loop for lyrics at all.
 *   - every word's fill is a Web Animation on `transform`, scheduled against the
 *     compositor's timeline via `startTime`, so it keeps flowing even while React is busy
 *   - the main thread only wakes at line boundaries (one timer) and on player events
 *   - network, JSON parsing and timing synthesis live in fl-engine.worker.js
 *   - the album-art background renders in fl-bg.worker.js via OffscreenCanvas
 */
(() => {
  'use strict';
  if (window.FluidLyrics) return;

  const BASE = (document.currentScript && document.currentScript.src)
    ? new URL('.', document.currentScript.src).href
    : '/fluid-lyrics/';
  const LS_KEY = 'fluid-lyrics:v1';
  const settings = Object.assign({ offset: 0, offsets: {}, blur: true, lrclib: true, hijack: true }, readLS());
  // sync offset is per song (a source can be late on one song and spot on for the next); the old
  // single `offset` is the default for songs never adjusted
  const songOffset = () => { const v = settings.offsets && settings.offsets[clock.uri]; return typeof v === 'number' ? v : settings.offset; };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ═════════════════════════ platform discovery ═════════════════════════
  // Spotify 1.2.x+/1.3.x keeps its core in a V8 snapshot; Platform/PlayerAPI are only
  // reachable at runtime. We find them on the React root's fiber props (no xpui.js patching).
  const sp = { player: null, registry: null, platform: null };

  function discover() {
    const root = document.getElementById('main');
    if (!root) return false;
    const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    if (!key) return false;
    const stack = [root[key]];
    let n = 0;
    while (stack.length && n++ < 120000) {
      const f = stack.pop();
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        if (!sp.platform && p.platform && typeof p.platform.getRegistry === 'function') sp.platform = p.platform;
        if (!sp.registry && p.registry && typeof p.registry.resolve === 'function') sp.registry = p.registry;
        if (!sp.player && p.playerAPI && typeof p.playerAPI.getState === 'function') sp.player = p.playerAPI;
      }
      if (sp.player && sp.registry && sp.platform) break;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    if (!sp.registry && sp.platform) try { sp.registry = sp.platform.getRegistry(); } catch {}
    if (!sp.player && sp.registry) sp.player = resolve('PlayerAPI');
    return !!(sp.player && sp.registry);
  }

  function resolve(name) {
    const reg = sp.registry;
    if (!reg || !reg._map) return null;
    for (const k of reg._map.keys()) {
      if (String((k && (k.description || k.name)) || k) === name) {
        try { return reg.resolve(k); } catch { return null; }
      }
    }
    return null;
  }

  async function getToken() {
    try {
      const auth = resolve('AuthorizationAPI');
      const st = auth && auth.getState && auth.getState();
      const tok = st && st.token;
      if (tok && tok.accessToken && (!tok.accessTokenExpirationTimestampMs || tok.accessTokenExpirationTimestampMs - Date.now() > 30000)) return tok.accessToken;
      const tp = resolve('TokenProvider');
      const t = tp && (await tp.getToken());
      return (t && (t.accessToken || t.token)) || (typeof t === 'string' ? t : tok && tok.accessToken) || null;
    } catch {
      return null;
    }
  }

  // ═════════════════════════ song clock ═════════════════════════
  // Spotify reports (positionAsOfTimestamp, timestamp[wall ms]). We convert once into the
  // performance.now() domain, which is the same clock document.timeline (and therefore the
  // compositor) uses — so animation startTimes land on the exact frame.
  const clock = { pos: 0, at: 0, speed: 1, paused: true, uri: '', dur: 0, gen: 0, skew: 0 };
  let lastStamp = 0;

  function readState(s) {
    // Spotify's timestamp is wall-clock (Date.now); map it into the performance.now() domain
    // at read time — timeOrigin+now() can drift from Date.now() over long sessions / sleep.
    const perf = performance.now();
    const wall = Date.now();
    const paused = !!(s.isPaused || s.isBuffering);
    const speed = s.speed || 1;
    let pos = +s.positionAsOfTimestamp || 0;
    if (!paused && s.timestamp) {
      // Spotify's stamps come from its own monotonic clock mapped to wall time once; when Windows
      // later corrects its time (sync after sleep), Date.now() and the stamps disagree by that
      // correction and every position is off by it. A fresh anchor (play, seek, next track)
      // reaches us within milliseconds of its stamp, so a bigger lag on one is that disagreement.
      const ts = +s.timestamp;
      if (ts !== lastStamp) {
        const lag = wall - ts;
        if (lastStamp) clock.skew = Math.abs(lag) > 600 ? lag : 0; // first anchor may just be old
        lastStamp = ts;
      }
      pos += (wall - ts - clock.skew) * speed;
    }
    // never extrapolate outside the track (stale/odd states would otherwise jump to the last line)
    const dur = +s.duration || (s.item && s.item.duration && s.item.duration.milliseconds) || 0;
    pos = Math.max(0, dur ? Math.min(pos, dur) : pos);
    return { pos, at: perf, paused, speed };
  }
  const rawNow = (perf = performance.now()) => clock.pos + (clock.paused ? 0 : (perf - clock.at) * clock.speed);
  const songNow = (perf) => rawNow(perf) + songOffset();
  const perfAt = (songMs) => clock.at + (songMs - songOffset() - clock.pos) / clock.speed;

  // ═════════════════════════ workers ═════════════════════════
  let engine = null;
  let reqSeq = 0;
  const pending = new Map();

  function startEngine() {
    engine = new Worker(BASE + 'fl-engine.worker.js');
    engine.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'result') return;
      const cb = pending.get(m.reqId);
      pending.delete(m.reqId);
      if (cb) cb(m.data);
    };
  }

  async function requestLyrics(track, prefetch) {
    const token = await getToken();
    if (prefetch) {
      engine.postMessage({ type: 'prefetch', track, token, opts: { lrclib: settings.lrclib } });
      return null;
    }
    const reqId = ++reqSeq;
    return new Promise((res) => {
      pending.set(reqId, res);
      engine.postMessage({ type: 'load', reqId, track, token, opts: { lrclib: settings.lrclib } });
    });
  }

  // ═════════════════════════ DOM ═════════════════════════
  const ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };
  let root, linesEl, scrollerEl, msgEl, popEl, artEl, titleEl, artistEl, bgCanvas, bgw = null, bgReady = false;

  let host = null;
  function buildShell() {
    // The viewer lives in a shadow root: its elements are matched only against our own small
    // stylesheet instead of Spotify's thousands of rules, which made every per-frame restyle of
    // an animated word ~50 µs. It also fully isolates the viewer from Spotify's CSS.
    host = document.createElement('div');
    host.id = 'fl-host';
    host.style.display = 'contents';
    const shadow = host.attachShadow({ mode: 'open' });
    const docLink = document.querySelector('link[href*="fluid-lyrics.css"]');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = docLink ? docLink.href : BASE + 'fluid-lyrics.css'; // same URL → served from cache
    shadow.appendChild(link);
    root = document.createElement('div');
    root.id = 'fl-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Lyrics');
    root.innerHTML = `
      <canvas id="fl-bg"></canvas>
      <div class="fl-bg-fallback"><i></i><i></i><i></i></div>
      <div class="fl-scrim"></div><div class="fl-grain"></div>
      <div class="fl-stage">
        <div class="fl-head">
          <div class="fl-art"></div>
          <div class="fl-meta"><div class="fl-title"></div><div class="fl-artist"></div></div>
          <div class="fl-actions">
            <button class="fl-btn" data-act="menu" aria-label="Lyrics options" aria-haspopup="true">${ICON.more}</button>
            <button class="fl-btn" data-act="close" aria-label="Close lyrics">${ICON.close}</button>
          </div>
        </div>
        <div class="fl-scroller"><div class="fl-lines" role="list"></div><div class="fl-msg" aria-live="polite"></div></div>
        <button class="fl-sync fl-btn-pill" data-act="resync" aria-label="Back to the current line">${ICON.sync}<span>Back to lyrics</span></button>
      </div>
      <div class="fl-pop" role="menu">
        <div class="fl-row"><label>Sync offset (this song)</label><div class="fl-step">
          <button class="fl-btn" data-act="off-" aria-label="Lyrics earlier">−</button><output></output>
          <button class="fl-btn" data-act="off+" aria-label="Lyrics later">+</button></div></div>
        <div class="fl-row"><label for="fl-tog-blur">Depth blur</label><input id="fl-tog-blur" class="fl-tog" type="checkbox" data-set="blur"></div>
        <div class="fl-row"><label for="fl-tog-lrc">Extra lyrics sources (Musixmatch word timing, LRCLIB, NetEase, lyrics.ovh)</label><input id="fl-tog-lrc" class="fl-tog" type="checkbox" data-set="lrclib"></div>
        <div class="fl-row"><label for="fl-tog-hj">Spotify's lyrics button opens Fluid Lyrics<small style="display:block;color:rgba(255,255,255,.5);margin-top:2px">Off: use the ✦ button next to it</small></label><input id="fl-tog-hj" class="fl-tog" type="checkbox" data-set="hijack"></div>
        <div class="fl-src"></div>
      </div>`;
    shadow.appendChild(root);
    // inside #main's stacking context, at a z-index between Spotify's pages (≤4) and its popover
    // layers (search dropdown, menus: 5/7) — so those still open on top of the viewer
    (document.getElementById('main') || document.body).appendChild(host);
    bgCanvas = root.querySelector('#fl-bg');
    linesEl = root.querySelector('.fl-lines');
    scrollerEl = root.querySelector('.fl-scroller');
    msgEl = root.querySelector('.fl-msg');
    popEl = root.querySelector('.fl-pop');
    artEl = root.querySelector('.fl-art');
    titleEl = root.querySelector('.fl-title');
    artistEl = root.querySelector('.fl-artist');
    root.classList.toggle('no-blur', !settings.blur);
    syncSettingsUI();

    // Press feedback on pointerdown (doesn't wait for click → feels instant)
    root.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.fl-btn, .fl-sync');
      if (b) b.classList.add('is-pressed');
    }, { passive: true });
    const unpress = () => root.querySelectorAll('.is-pressed').forEach((b) => b.classList.remove('is-pressed'));
    root.addEventListener('pointerup', unpress, { passive: true });
    root.addEventListener('pointercancel', unpress, { passive: true });
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    scrollerEl.addEventListener('wheel', onWheel, { passive: true });

    setupBackground();
    new ResizeObserver(() => {
      if (bgw) bgw.postMessage({ type: 'resize', w: root.clientWidth, h: root.clientHeight });
      if (view.items.length) { measure(); place(true); }
    }).observe(root);
    // lines can change height without the viewer resizing (the lyric font arriving late, lines
    // re-wrapping): stale offsets park the live line hundreds of px off its spot → re-measure
    new ResizeObserver(() => {
      if (view.items.length && view.offsets && view.items[0].el.isConnected) { measure(); place(true); }
    }).observe(linesEl);
  }

  function setupBackground() {
    try {
      if (!bgCanvas.transferControlToOffscreen) throw 0;
      const off = bgCanvas.transferControlToOffscreen();
      bgw = new Worker(BASE + 'fl-bg.worker.js');
      bgw.onmessage = (e) => {
        if (e.data.type === 'ready') {
          bgReady = true;
          if (currentTrack) bgw.postMessage({ type: 'art', url: currentTrack.artSmall });
          if (isOpen) bgw.postMessage({ type: 'run' });
        } else if (e.data.type === 'fail') {
          root.classList.add('bg-css');
          bgw.terminate();
          bgw = null;
        }
      };
      bgw.onerror = () => root.classList.add('bg-css');
      bgw.postMessage({ type: 'init', canvas: off, w: innerWidth, h: innerHeight, reduce: reduceMotion.matches }, [off]);
    } catch {
      root.classList.add('bg-css');
    }
    reduceMotion.addEventListener('change', () => bgw && bgw.postMessage({ type: 'reduce', reduce: reduceMotion.matches }));
  }

  // keep the overlay exactly over the main area: below the global nav, above the now-playing bar
  function layoutShell() {
    const nav = document.querySelector('[data-testid="global-nav-bar"]');
    const bar = document.querySelector('[data-testid="now-playing-bar"]');
    const top = nav ? nav.getBoundingClientRect().bottom : 64;
    const bottom = bar ? bar.getBoundingClientRect().top - 8 : innerHeight - 88;
    const s = root.style;
    s.setProperty('--fl-x', '8px');
    s.setProperty('--fl-y', top + 'px');
    s.setProperty('--fl-w', innerWidth - 16 + 'px');
    s.setProperty('--fl-h', Math.max(200, bottom - top) + 'px');
  }

  // ═════════════════════════ spring easing ═════════════════════════
  // A real damped spring sampled into CSS linear() — Apple's scroll feel, run by the compositor.
  function springEasing(stiffness = 110, damping = 19, mass = 1) {
    let x = 0, v = 0, t = 0;
    const dt = 1 / 600, pts = [];
    const samples = [];
    while (t < 3) {
      const a = (-stiffness * (x - 1) - damping * v) / mass;
      v += a * dt;
      x += v * dt;
      t += dt;
      samples.push(x);
      if (t > 0.2 && Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.01) break;
    }
    const N = 44;
    for (let i = 0; i <= N; i++) pts.push((samples[Math.min(samples.length - 1, Math.round((i / N) * (samples.length - 1)))]).toFixed(4));
    pts[N] = '1';
    return { easing: `linear(${pts.join(',')})`, ms: Math.round(t * 1000) };
  }

  // ═════════════════════════ rendering ═════════════════════════
  const view = {
    data: null, trackId: '', items: [], starts: null, offsets: null,
    armed: new Set(), active: -1, focus: -1, timer: 0, drift: 0, manual: 0, manualTimer: 0, rendered: '',
  };

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

  function wordHTML(w) {
    const t = esc(w.text);
    if (w.emph) {
      const letters = Array.from(w.text).map((ch) => `<span class="fl-l">${esc(ch)}</span>`).join('');
      return `<span class="fl-w"><span class="fl-b">${letters}</span><span class="fl-gl" aria-hidden="true">${t}</span><span class="fl-f" aria-hidden="true"><span class="fl-fi">${letters}</span></span></span>`;
    }
    return `<span class="fl-w"><span class="fl-b">${t}</span><span class="fl-f" aria-hidden="true"><span class="fl-fi">${t}</span></span></span>`;
  }

  const SYNC_NAME = {
    word: 'Word-synced',
    syllable: 'Syllable-synced',
    'smart+audio': 'Word timing estimated from the audio',
    smart: 'Word timing estimated',
    static: 'Not synced',
  };

  function render(data, trackId) {
    teardown();
    view.data = data;
    view.trackId = trackId;
    view.rendered = trackId;
    view.items = [];
    root.classList.toggle('is-static', data.kind === 'static');
    if (data.kind === 'none') {
      linesEl.innerHTML = '';
      showMsg(data.reason === 'instrumental' ? 'Instrumental' : 'No lyrics for this song', data.reason === 'instrumental' ? '' : 'Spotify, Musixmatch, LRCLIB, NetEase and lyrics.ovh have nothing for it yet.');
      return;
    }
    showMsg('');
    let html = '';
    // after the last line (so line i stays linesEl.children[i]): where these lyrics came from
    const credit = data.source
      ? `<div class="fl-credit">Lyrics by ${esc(data.source)}<small>${esc(SYNC_NAME[data.sync] || '')}</small></div>`
      : '';
    if (data.kind === 'static') {
      for (const it of data.items) html += `<div class="fl-line" role="listitem"><span class="fl-main"><span class="fl-b">${esc(it.text) || '&nbsp;'}</span></span></div>`;
      linesEl.innerHTML = html + credit;
      view.credit = null;
      scrollerEl.scrollTop = 0;
      return;
    }
    const items = data.items;
    items.forEach((it, i) => {
      if (it.t === 'gap') {
        html += `<div class="fl-line fl-gap" data-i="${i}" aria-hidden="true"><div class="fl-dots"><div class="fl-dots-out"><div class="fl-dots-in"><i class="fl-dot"></i><i class="fl-dot"></i><i class="fl-dot"></i></div></div></div></div>`;
        return;
      }
      const main = [], bg = [];
      it.words.forEach((w) => (w.bg ? bg : main).push(w));
      it.order = main.concat(bg); // DOM order of .fl-w elements
      const text = it.words.map((w) => w.text).join(' ');
      const dir = RTL.test(text) ? ' dir="rtl"' : '';
      html += `<div class="fl-line${it.side === 'bg' ? ' side-bg' : ''}" data-i="${i}" role="listitem"${dir}>`
        + `<span class="fl-main">${main.map(wordHTML).join(' ')}</span>`
        + (bg.length ? `<span class="fl-bgv">${bg.map(wordHTML).join(' ')}</span>` : '')
        + '</div>';
    });
    linesEl.innerHTML = html + credit;
    view.credit = linesEl.querySelector('.fl-credit');

    const els = linesEl.children;
    view.starts = new Float64Array(items.length);
    view.items = items.map((it, i) => {
      const el = els[i];
      const rec = { ...it, el, i, rtl: el.dir === 'rtl', anims: null, doneTimer: 0 };
      view.starts[i] = it.s;
      if (it.t === 'line') {
        const wEls = el.querySelectorAll('.fl-w');
        rec.w = it.order.map((w, k) => {
          const we = wEls[k];
          return {
            ...w, el: we, fill: we.querySelector('.fl-f'), inner: we.querySelector('.fl-fi'),
            glow: w.emph ? we.querySelector('.fl-gl') : null,
            lb: w.emph ? we.querySelectorAll('.fl-b .fl-l') : null,
            lf: w.emph ? we.querySelectorAll('.fl-fi .fl-l') : null,
          };
        });
      } else {
        rec.dots = el.querySelectorAll('.fl-dot');
        // one transform animation per element (Chromium can't composite competing ones):
        // .fl-dots = CSS scale-in transition, .fl-dots-out = scripted end collapse, .fl-dots-in = CSS breathing
        rec.dotsBox = el.querySelector('.fl-dots-out');
      }
      return rec;
    });
    measure();
    view.focus = -2;
    view.lastY = null;
    if (isOpen) sync(true);
  }

  // one batched layout read for all line offsets; re-done only on resize / font load
  function measure() {
    const n = view.items.length;
    if (!n) return;
    view.offsets = new Float64Array(n);
    view.heights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const el = view.items[i].el;
      view.offsets[i] = el.offsetTop;
      view.heights[i] = el.offsetHeight;
    }
    view.viewH = scrollerEl.clientHeight;
    // cached here (we're already reading layout) so place() never forces a sync layout
    view.anchor = view.viewH * (root.clientWidth >= 1080 ? 0.36 : 0.3);
  }

  function showMsg(title, sub) {
    msgEl.innerHTML = title ? `<div>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>` : '';
    msgEl.classList.toggle('is-shown', !!title);
  }

  // ═════════════════════════ scroll / focus ═════════════════════════
  /**
   * Position every line for the current focus. Only lines that are on screen before or after
   * the move get the spring transition (≈12 of them); everything off screen jumps silently.
   * Per-line values are cached so unchanged ones are never rewritten (no style invalidation).
   */
  function place(instant) {
    const items = view.items;
    if (!items.length || !view.offsets) return;
    const f = Math.max(0, view.focus);
    const y = view.anchor - view.offsets[f] - view.heights[f] * 0.15 + view.manual;
    const lastY = view.lastY == null ? y : view.lastY;
    const H = view.viewH, M = 120;
    const yPx = y.toFixed(1) + 'px';
    for (let i = 0; i < items.length; i++) {
      const rec = items[i];
      const top = view.offsets[i], bottom = top + view.heights[i];
      const visible = (yy) => yy + bottom > -M && yy + top < H + M;
      const animate = !instant && (visible(y) || visible(lastY));
      const d = Math.min(6, Math.abs(i - f)); // opacity/blur saturate at 6
      const k = animate ? Math.max(0, Math.min(8, i - f + 1)) : 0;
      const s = rec.el.style;
      if (rec.snap !== !animate) {
        s.transition = animate ? '' : 'none';
        rec.snap = !animate;
      }
      s.setProperty('--fl-y', yPx);
      if (rec.d !== d) { s.setProperty('--fl-d', d); rec.d = d; }
      if (rec.k !== k) { s.setProperty('--fl-k', k); rec.k = k; }
    }
    if (view.credit) {
      const s = view.credit.style;
      s.transition = instant ? 'none' : '';
      s.setProperty('--fl-y', yPx);
    }
    view.lastY = y;
  }

  function setFocus(f, active) {
    if (active !== view.active) {
      if (view.active >= 0 && view.items[view.active]) view.items[view.active].el.classList.remove('is-active');
      if (active >= 0) view.items[active].el.classList.add('is-active');
      view.active = active;
    }
    if (f !== view.focus) {
      if (view.manual && view.focus >= 0 && f >= 0 && view.offsets) {
        // compensate so the content doesn't move while the user is scrolled away
        const at = (i) => view.offsets[i] + view.heights[i] * 0.15;
        view.manual += at(f) - at(view.focus);
      }
      view.focus = f;
      if (!view.manual && !root.classList.contains('is-manual')) place(false);
    }
  }

  // ═════════════════════════ animation scheduling ═════════════════════════
  // Each armed line owns a list of {a: Animation, s: songMs at local time 0}.
  // Re-timing on seek/pause/offset is just startTime / currentTime updates on existing objects.

  function timeAnim(rec) {
    const playing = !clock.paused;
    for (const x of rec.anims) {
      const a = x.a;
      if (playing) {
        a.playbackRate = clock.speed;
        a.startTime = perfAt(x.s);
      } else {
        a.pause();
        a.currentTime = songNow() - x.s;
      }
    }
  }

  /**
   * Keyframes on a shared timeline [S0, S0+L]: hold the first value until the first point,
   * follow the points (absolute song ms, optional per-segment easing), hold the last value.
   */
  function track(S0, L) {
    return (prop, pts) => {
      const kf = [{ offset: 0, [prop]: pts[0].v }];
      let last = 0;
      for (const p of pts) {
        last = Math.max(last, Math.min(1, Math.max(0, (p.t - S0) / L)));
        const k = { offset: last, [prop]: p.v };
        if (p.easing) k.easing = p.easing;
        kf.push(k);
      }
      kf.push({ offset: 1, [prop]: pts[pts.length - 1].v });
      return kf;
    };
  }

  function arm(i) {
    const rec = view.items[i];
    if (!rec) return;
    clearTimeout(rec.doneTimer);
    if (rec.anims) {
      rec.el.classList.remove('is-done');
      rec.el.classList.add('is-armed');
      timeAnim(rec);
      view.armed.add(i);
      return;
    }
    const anims = (rec.anims = []);
    const add = (el, kf, s, L) => anims.push({ a: el.animate(kf, { duration: L, fill: 'both', easing: 'linear' }), s });
    const sign = rec.rtl ? -1 : 1;
    const noLift = reduceMotion.matches;

    if (rec.t === 'gap') {
      // dots sit at scale(0) until active; animations created on an invisible target can't be
      // composited, so arm only once the scale-in transition has made them visible
      rec.anims = null;
      if (songNow() < rec.s) return; // not started yet: sync() arms it when the break begins
      if (!rec.el.classList.contains('is-active') || songNow() - rec.s < 120) {
        clearTimeout(rec.doneTimer);
        rec.doneTimer = setTimeout(() => { if (view.armed.has(i)) { view.armed.delete(i); arm(i); } }, 160);
        view.armed.add(i);
        return;
      }
      const D = Math.max(600, rec.e - rec.s);
      const S0 = rec.s;
      const tl = track(S0, D);
      rec.dots.forEach((d, k) => add(d, tl('opacity', [
        { t: S0 + (k * D) / 3, v: 0.38, easing: 'ease-in-out' },
        { t: S0 + ((k + 1) * D) / 3, v: 1 },
      ]), S0, D));
      const c0 = S0 + Math.max(0, D - 520);
      add(rec.dotsBox, tl('transform', [
        { t: c0, v: 'scale(1)', easing: 'cubic-bezier(.4,0,.2,1)' },
        { t: c0 + 208, v: 'scale(1.18)', easing: 'cubic-bezier(.4,0,.2,1)' },
        { t: S0 + D, v: 'scale(0)' },
      ]), S0, D);
    } else {
      // ONE shared timeline per line: every animation starts at the line start and has the
      // line's duration; each word's own timing lives in keyframe offsets (holding until its
      // moment). One batch start per line instead of a stream of per-word starts — each start
      // would otherwise cost the main thread frames to hand the animation to the compositor.
      const S0 = rec.s;
      let end = S0 + 1;
      for (const w of rec.w) end = Math.max(end, w.s + Math.max(w.e - w.s, 380), w.emph ? w.e + 700 : 0);
      const L = end - S0;
      const tl = track(S0, L);
      const tx = (p) => `translateX(${p * sign}%)`;
      for (const w of rec.w) {
        const dur = Math.max(60, w.e - w.s);
        // syllable points → the fill edge moves at each syllable's own speed, holding in between
        const po = [{ t: w.s, v: -100 }];
        let prevC = 0, lastT = w.s;
        for (let k = 0; k < w.syl.length; k++) {
          const y = w.syl[k];
          const c = k === w.syl.length - 1 ? 1 : y.c;
          if (y.s > lastT + 1) po.push({ t: y.s, v: -(1 - prevC) * 100 });
          lastT = Math.max(lastT, y.e);
          po.push({ t: lastT, v: -(1 - c) * 100 });
          prevC = c;
        }
        add(w.fill, tl('transform', po.map((p) => ({ t: p.t, v: tx(p.v) }))), S0, L);
        add(w.inner, tl('transform', po.map((p) => ({ t: p.t, v: tx(-p.v) }))), S0, L);
        if (!noLift) {
          add(w.el, tl('transform', [
            { t: w.s, v: 'translateY(0)', easing: 'cubic-bezier(.33,0,.15,1)' },
            { t: w.s + Math.max(dur, 380), v: 'translateY(-.045em)' },
          ]), S0, L);
        }
        if (w.emph && !noLift) {
          const n = w.lb.length;
          const span = Math.max(dur * 0.5, 360);
          const ease = 'cubic-bezier(.3,0,.3,1)';
          for (let k = 0; k < n; k++) {
            const ls = w.s + (k / n) * dur * 0.72;
            const kf = tl('transform', [
              { t: ls, v: 'translateY(0) scale(1)', easing: ease },
              { t: ls + span * 0.45, v: 'translateY(-.06em) scale(1.09)', easing: ease },
              { t: ls + span, v: 'translateY(-.015em) scale(1.015)' },
            ]);
            add(w.lb[k], kf, S0, L);
            add(w.lf[k], kf, S0, L);
          }
          add(w.glow, tl('opacity', [
            { t: w.s, v: 0, easing: 'ease-in-out' },
            { t: w.s + (dur + 600) / 2, v: 0.9, easing: 'ease-in-out' },
            { t: w.s + dur + 600, v: 0 },
          ]), S0, L);
        }
      }
    }
    rec.el.classList.remove('is-done');
    rec.el.classList.add('is-armed');
    timeAnim(rec);
    view.armed.add(i);
  }

  function disarm(i, soft) {
    const rec = view.items[i];
    view.armed.delete(i);
    if (!rec || !rec.anims) return;
    rec.el.classList.remove('is-armed');
    if (!soft) return kill(rec);
    rec.el.classList.add('is-done'); // fill fades out via CSS opacity transition
    const t = songNow();
    if (rec.w && !reduceMotion.matches) {
      // let lifted words settle back down instead of snapping
      for (const w of rec.w) if (w.s <= t) w.el.animate([{ transform: 'translateY(-.045em)' }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.3,0,.2,1)' });
      rec.anims = rec.anims.filter((x) => (x.a.effect.target.classList.contains('fl-w') ? (x.a.cancel(), false) : true));
    }
    clearTimeout(rec.doneTimer);
    rec.doneTimer = setTimeout(() => kill(rec), 600);
  }

  function kill(rec) {
    clearTimeout(rec.doneTimer);
    if (rec.anims) for (const x of rec.anims) x.a.cancel();
    rec.anims = null;
    rec.el.classList.remove('is-armed', 'is-done');
  }

  function teardown() {
    clearTimeout(view.timer);
    for (const rec of view.items) {
      if (rec.anims) kill(rec);
      if (rec.el) rec.el.classList.remove('is-active', 'is-parallel'); // else a stale highlight survives a reopen
    }
    view.armed.clear();
    view.active = -1;
  }

  function indexAt(t) {
    const s = view.starts;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (s[m] <= t) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  }

  /**
   * The only "loop": recompute what should be active, (re)arm the current + next line,
   * and sleep until the next boundary. When retime=true, armed animations get fresh
   * startTimes (seek / pause / speed / offset change).
   */
  function sync(retime) {
    clearTimeout(view.timer);
    if (!isOpen || !view.items.length || view.data.kind !== 'synced') return;
    const t = songNow();
    const items = view.items;
    const idx = indexAt(t);
    const active = idx >= 0 && t < items[idx].e ? idx : -1;
    const focus = idx < 0 ? 0 : active >= 0 ? idx : Math.min(items.length - 1, idx + (t - items[idx].e > 300 ? 1 : 0));

    const want = new Set();
    if (active >= 0) want.add(active);
    // parallel voices: an earlier line still being sung under the current one stays lit & filling
    const parallel = [];
    for (let i = idx - 1; i >= Math.max(0, idx - 3); i--) {
      if (items[i].ov && t < items[i].vEnd + 200) { want.add(i); parallel.push(i); }
    }
    for (const rec of items) if (rec.el && rec.el.classList.contains('is-parallel') && !parallel.includes(rec.i)) rec.el.classList.remove('is-parallel');
    for (const i of parallel) items[i].el.classList.add('is-parallel');
    // No pre-arming of the next line: every live animation is restyled on each main-thread frame
    // (hover, clicks), so fewer is cheaper. Arming at the boundary is still frame-exact because
    // startTimes are absolute — a late timer just starts the animation already in progress.
    for (const i of [...view.armed]) if (!want.has(i)) disarm(i, i === view.active || Math.abs(i - idx) <= 1);
    for (const i of want) {
      if (!view.armed.has(i)) arm(i);
      else if (retime) timeAnim(items[i]);
    }
    setFocus(focus, active);

    if (clock.paused) return;
    let next = Infinity;
    if (active >= 0) next = items[active].e;
    if (idx + 1 < items.length) next = Math.min(next, items[idx + 1].s);
    for (const i of parallel) next = Math.min(next, items[i].vEnd + 200);
    if (next === Infinity) return;
    const delay = Math.max(4, (next - t) / clock.speed);
    view.timer = setTimeout(() => sync(false), delay);
  }

  // ═════════════════════════ player events ═════════════════════════
  let currentTrack = null;
  let loadSeq = 0;

  function trackFromItem(item) {
    if (!item || !item.uri) return null;
    const isLocal = !!item.isLocal || item.uri.startsWith('spotify:local');
    const imgs = (item.album && item.album.images) || [];
    const pick = (label) => {
      const im = imgs.find((x) => x.label === label) || imgs[0];
      return im ? toHttp(im.url) : '';
    };
    return {
      id: isLocal ? item.uri : item.uri.split(':')[2],
      uri: item.uri,
      name: item.name || '',
      artists: (item.artists || []).map((a) => a.name),
      album: (item.album && item.album.name) || '',
      durationMs: (item.duration && item.duration.milliseconds) || 0,
      isLocal,
      artSmall: pick('small'),
      artLarge: pick('xlarge') || pick('large'),
    };
  }
  const toHttp = (u) => (u && u.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.slice(14) : u || '');

  function onPlayerUpdate() {
    let s;
    try { s = sp.player.getState(); } catch { return; }
    if (!s) return;
    const uri = s.item && s.item.uri;
    if (uri !== clock.uri) {
      clock.uri = uri || '';
      onTrackChange(s);
    }
    const before = rawNow();
    const n = readState(s);
    const jumped = Math.abs(n.pos - before) > 35 || n.paused !== clock.paused || n.speed !== clock.speed;
    Object.assign(clock, n);
    if (jumped) {
      clock.gen++;
      sync(true);
    }
    schedulePrefetch(s);
  }

  function onTrackChange(s) {
    const tr = trackFromItem(s.item);
    currentTrack = tr;
    teardown();
    // forget the previous song's timeline so nothing re-arms it while the new one loads
    view.items = [];
    view.data = null;
    view.rendered = '';
    if (!root) return;
    if (!tr || s.item.type === 'episode' || s.item.mediaType === 'video') {
      view.items = [];
      linesEl.innerHTML = '';
      showMsg(tr ? 'Lyrics are only available for songs' : 'Nothing playing');
      return;
    }
    titleEl.textContent = tr.name;
    artistEl.textContent = tr.artists.join(', ');
    artEl.style.backgroundImage = tr.artLarge ? `url("${tr.artLarge}")` : '';
    root.style.setProperty('--fl-art', tr.artSmall ? `url("${tr.artSmall}")` : 'none');
    if (bgw && bgReady) bgw.postMessage({ type: 'art', url: tr.artSmall });
    loadLyrics(tr);
  }

  async function loadLyrics(tr) {
    const seq = ++loadSeq;
    // only show a loading state if it actually takes a while (cached/prefetched = instant)
    const slow = setTimeout(() => {
      if (seq === loadSeq) { linesEl.innerHTML = ''; view.items = []; showMsg('Loading lyrics…'); }
    }, 220);
    const data = await requestLyrics(tr, false);
    clearTimeout(slow);
    if (seq !== loadSeq || !currentTrack || currentTrack.id !== tr.id) return;
    view.data = data;
    // build DOM while idle if closed (so opening is instant), immediately if open
    if (isOpen) render(data, tr.id);
    else (window.requestIdleCallback || setTimeout)(() => { if (seq === loadSeq) render(data, tr.id); }, { timeout: 1500 });
    syncSettingsUI();
  }

  let prefetched = '';
  let prefetchTimer = 0;
  function schedulePrefetch(s) {
    const nx = s.nextItems && s.nextItems.find((x) => x && x.uri && x.uri.startsWith('spotify:track:'));
    if (!nx || nx.uri === prefetched) return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const tr = trackFromItem(nx);
      if (!tr) return;
      prefetched = nx.uri;
      requestLyrics(tr, true);
    }, 8000);
  }

  // ═════════════════════════ open / close ═════════════════════════
  let isOpen = false;

  // While the viewer covers Spotify's sidebars and main view, that UI is invisible but would
  // keep restyling/animating (e.g. home carousels run main-thread animations every frame).
  // content-visibility:hidden makes Chromium skip its style/layout/paint entirely while
  // keeping its state (scroll positions, DOM) for an instant restore.
  let covered = [];
  let coverTimer = 0;
  function coverSpotify(on) {
    clearTimeout(coverTimer);
    if (!on) {
      for (const el of covered) el.style.removeProperty('content-visibility');
      covered = [];
      return;
    }
    // wait until our open transition has fully hidden the page, so nothing flashes
    coverTimer = setTimeout(() => {
      if (!isOpen) return;
      const main = document.getElementById('main-view');
      const grid = main && main.parentElement;
      if (!grid) return;
      covered = [...grid.children].filter((el) => {
        if (el === root || el.id === 'global-nav-bar') return false;
        const area = getComputedStyle(el).gridArea.split(' / ')[0];
        return area === 'main-view' && el.id === 'main-view' || area === 'left-sidebar' || area === 'right-sidebar';
      });
      for (const el of covered) el.style.setProperty('content-visibility', 'hidden');
    }, 260);
  }

  function open() {
    if (!root) buildShell();
    if (isOpen) return;
    layoutShell();
    isOpen = true;
    root.classList.add('is-open');
    document.documentElement.classList.add('fl-open');
    coverSpotify(true);
    if (bgw && bgReady) bgw.postMessage({ type: 'run' });
    if (currentTrack && view.rendered !== currentTrack.id && view.data) render(view.data, currentTrack.id);
    else if (!currentTrack && sp.player) onPlayerUpdate();
    onPlayerUpdate();
    if (view.items.length && view.offsets) {
      // jump straight to the current line, no stagger, then animate normally
      view.focus = -2;
      measure();
    }
    sync(true);
    if (view.items.length) place(true);
    clearInterval(view.drift);
    // cheap drift guard: compare our extrapolated clock with the player's every 2 s
    view.drift = setInterval(onPlayerUpdate, 2000);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    coverSpotify(false); // un-skip first so Spotify's UI is rendered beneath the fading overlay
    root.classList.remove('is-open');
    document.documentElement.classList.remove('fl-open');
    popEl.classList.remove('is-open');
    clearInterval(view.drift);
    teardown();
    if (bgw) bgw.postMessage({ type: 'stop' });
  }

  const toggle = () => (isOpen ? close() : open());

  // When Spotify's own lyrics button is left alone, we add our own entry point next to it,
  // so the viewer can never become unreachable.
  let ownBtn = null;
  function ensureOwnButton() {
    if (settings.hijack) {
      if (ownBtn) ownBtn.remove();
      ownBtn = null;
      unlockNative();
      return;
    }
    if (ownBtn && ownBtn.isConnected) return;
    const native = document.querySelector('[data-testid="lyrics-button"]');
    if (!native || !native.parentElement) return;
    ownBtn = document.createElement('button');
    ownBtn.className = native.className; // Spotify's own icon-button styling
    ownBtn.setAttribute('data-fl-open', '');
    ownBtn.setAttribute('aria-label', 'Fluid Lyrics');
    ownBtn.title = 'Fluid Lyrics';
    ownBtn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0l1.6 4.4L14 6 9.6 7.6 8 12 6.4 7.6 2 6l4.4-1.6zM13 10l.8 2.2L16 13l-2.2.8L13 16l-.8-2.2L10 13l2.2-.8z"/></svg>';
    ownBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    native.insertAdjacentElement('beforebegin', ownBtn);
  }

  // Spotify disables its lyrics button on songs it has no lyrics for, and a disabled button
  // never dispatches the click we hijack — but we may still find lyrics elsewhere (LRCLIB…)
  function unlockNative() {
    const native = document.querySelector('[data-testid="lyrics-button"]');
    if (!native || !native.disabled) return;
    native.disabled = false;
    native.setAttribute('aria-label', 'Lyrics');
  }

  // ═════════════════════════ interaction ═════════════════════════
  function onClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'close') close();
      else if (a === 'menu') popEl.classList.toggle('is-open');
      else if (a === 'resync') resync();
      else if (a === 'off-' || a === 'off+') {
        if (!settings.offsets || typeof settings.offsets !== 'object') settings.offsets = {};
        const v = songOffset() + (a === 'off+' ? 50 : -50);
        delete settings.offsets[clock.uri]; // re-insert → most recent last, oldest trimmed first
        if (v !== settings.offset) settings.offsets[clock.uri] = v;
        const keys = Object.keys(settings.offsets);
        for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete settings.offsets[k];
        saveLS();
        syncSettingsUI();
        sync(true);
      }
      return;
    }
    if (popEl.classList.contains('is-open') && !e.target.closest('.fl-pop')) {
      popEl.classList.remove('is-open');
      return;
    }
    const line = e.target.closest('.fl-line[data-i]');
    if (line && view.data && view.data.kind === 'synced') {
      const rec = view.items[+line.dataset.i];
      if (!rec || rec.t === 'gap') return;
      const target = Math.max(0, rec.s - songOffset());
      // optimistic: move our clock now so the UI responds this frame, the player event confirms
      clock.pos = target;
      clock.at = performance.now();
      sync(true);
      resync(); // a line click also returns to the live position
      try { sp.player.seekTo(target); } catch {}
    }
  }

  function onChange(e) {
    const k = e.target.dataset.set;
    if (!k) return;
    settings[k] = e.target.checked;
    saveLS();
    if (k === 'blur') root.classList.toggle('no-blur', !settings.blur);
    if (k === 'lrclib' && currentTrack) loadLyrics(currentTrack);
    if (k === 'hijack') ensureOwnButton();
  }

  let wheelRaf = 0;
  function onWheel(e) {
    if (!view.items.length || !view.data || view.data.kind !== 'synced') return;
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    const f = Math.max(0, view.focus);
    const maxUp = view.offsets[f] + 40;
    const maxDown = view.offsets[view.items.length - 1] - view.offsets[f] + 40;
    view.manual = Math.max(-maxDown, Math.min(maxUp, view.manual - dy));
    root.classList.add('is-manual');
    if (!wheelRaf) wheelRaf = requestAnimationFrame(() => { wheelRaf = 0; place(true); });
  }

  // leave manual scrolling: spring back to the live line (the pill, a line click, or Esc)
  function resync() {
    if (!root.classList.contains('is-manual') && !view.manual) return;
    view.manual = 0;
    root.classList.remove('is-manual');
    place(false);
  }

  function syncSettingsUI() {
    if (!root) return;
    const off = songOffset();
    root.querySelector('.fl-step output').textContent = (off > 0 ? '+' : '') + off + ' ms';
    root.querySelectorAll('[data-set]').forEach((el) => (el.checked = !!settings[el.dataset.set]));
    const d = view.data;
    const SYNC = {
      word: 'True word-level timing',
      syllable: 'True syllable-level timing',
      'smart+audio': 'Smart sync — word timing synthesized from line timing, aligned to audio onsets',
      smart: 'Smart sync — word timing synthesized from line timing',
      static: 'Unsynced lyrics',
    };
    root.querySelector('.fl-src').innerHTML = d && d.source
      ? `Source: <b>${esc(d.source)}</b><br>${esc(SYNC[d.sync] || '')}`
      : '';
  }

  // capture-phase hijack of Spotify's own lyrics button (Alt+click → native lyrics)
  window.addEventListener('click', (e) => {
    if (!settings.hijack || e.altKey) return;
    const b = e.target && e.target.closest && e.target.closest('[data-testid="lyrics-button"]');
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      if (popEl.classList.contains('is-open')) popEl.classList.remove('is-open');
      else if (root.classList.contains('is-manual')) resync();
      else close();
      e.stopPropagation();
    }
  }, true);

  let resizeRaf = 0;
  addEventListener('resize', () => {
    if (!isOpen || resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; layoutShell(); });
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!bgw || !isOpen) return;
    bgw.postMessage({ type: document.hidden ? 'stop' : 'run' });
    if (!document.hidden) onPlayerUpdate();
  });

  function readLS() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  }
  function saveLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
  }

  // ═════════════════════════ boot ═════════════════════════
  function boot() {
    const sp0 = springEasing();
    document.documentElement.style.setProperty('--fl-spring', sp0.easing);
    document.documentElement.style.setProperty('--fl-scroll-ms', sp0.ms + 'ms');
    startEngine();
    buildShell();
    sp.player.getEvents().addListener('update', onPlayerUpdate);
    try {
      const h = sp.platform && sp.platform.getHistory();
      if (h && h.listen) h.listen(() => isOpen && close());
    } catch {}
    const bar = document.querySelector('[data-testid="now-playing-bar"]');
    if (bar) new ResizeObserver(() => isOpen && layoutShell()).observe(bar);
    // navigating to another page (e.g. full search results) closes the viewer, as Spotify's own
    // lyrics view does — pages render underneath us. The search dropdown itself floats above.
    try {
      const hist = sp.platform.getHistory();
      let path = hist.location.pathname;
      hist.listen((loc) => {
        if (loc.pathname !== path && isOpen) close();
        path = loc.pathname;
      });
    } catch {}
    // React re-mounts the player bar after boot (an observer on it goes stale), so poll instead:
    // re-add our button if it got dropped, and re-enable Spotify's lyrics button whenever it
    // disables it for a song. One querySelector a second — negligible.
    setInterval(ensureOwnButton, 1000);
    ensureOwnButton();
    document.fonts && document.fonts.ready.then(() => { if (view.items.length) { measure(); place(true); } });
    onPlayerUpdate();
  }

  let tries = 0;
  (function wait() {
    if (discover()) return boot();
    if (++tries < 240) setTimeout(wait, tries < 20 ? 250 : 1000);
    else console.warn('[fluid-lyrics] Spotify platform not found');
  })();

  window.FluidLyrics = { open, close, toggle, settings, _view: view, _clock: clock, _sp: sp, get _root() { return root; } };
})();
