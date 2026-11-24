// boot.js — the pre-login loading experience, shared by the dev page (web/index.html) and the
// realm page (crates/wenilla-realm/templates/play.html).
//
// Why this exists: the client cannot show its own boot. Everything a fresh tab waits on — the
// 15 MB (brotli) wasm download, instantiation, and the first update's catalog pile (~100+
// synchronous XHR chain reads in ONE rAF task, the "unresponsive tab" window) — happens before
// the first frame the app could draw. So the page owns a DOM overlay, and it does two jobs:
//
//   1. SHOW what is happening: a byte-counted wasm download bar (the counting stream is
//      re-wrapped in a Response so `WebAssembly.compileStreaming` still streams), a
//      "game data N/M" line for the prefetch, then indeterminate "Starting…" states driven by
//      the client's own `window.__wenilla_progress(stage)` calls (benilla-app/src/webprogress.rs)
//      until "ready" — the first glue screen — fades the overlay out.
//   2. SHRINK the unresponsive window: `/data/*` is served immutable (max-age=1y), and a sync
//      XHR is served from the HTTP cache when the same URL was fetch()ed first (verified live:
//      transferSize 0, deliveryType "cache"). So the overlay prefetches the boot read-set — a
//      checked-in manifest (boot-manifest.json) captured from a traced boot — with a small
//      fetch pool, in parallel with the wasm download. The catalog pile then costs parse, not
//      ~100 serial network round trips. Every miss (drift, missing manifest) degrades to
//      exactly today's behavior, and a warm-cache visitor flies through all of it: progress is
//      measured, never scripted.
//
// Page contract: `const w = await boot(init); bind(w.memory);` — bind must stay immediately
// after (the Lua WASI shims need the module's linear memory). Query switches: `?boottrace=1`
// arms window.__wenilla_boottrace and skips the prefetch (a manifest-capture boot must show the
// true read order); `?noprefetch=1` skips the prefetch only (the A/B lever).

// The wasm travels brotli-compressed: content-length counts .br bytes while the counted stream
// yields decompressed ones. Dividing the two on a real build gives ~5.0; it drifts a little per
// build and that is cosmetic — the bar is clamped at 99% until the stream actually ends.
const BR_RATIO = 5.0;
const READY_TIMEOUT_MS = 20000;
const PREFETCH_CONCURRENCY = 8;

export async function boot(init, opts = {}) {
  const q = new URLSearchParams(location.search);
  const ui = createBootUi();
  if (q.get('boottrace') === '1') window.__wenilla_boottrace = [];
  const skipPrefetch = q.get('boottrace') === '1' || q.get('noprefetch') === '1';
  installProgressHook(ui, skipPrefetch);

  const prefetch = skipPrefetch
    ? Promise.resolve()
    : prefetchManifest('./boot-manifest.json', (done, total) => ui.setData(done, total)).catch(
        () => ui.setData(0, 0)
      );

  // Compile immediately: merely fetching a Response leaves its body backpressured until
  // someone consumes it. Instantiation must still wait for the cache warmup because the
  // game's Startup performs synchronous reads of the prefetched catalogs.
  const wasm = compileWasm(
    // The build's stamp (?v=, scripts/rogue-build.sh) rides along, so a cached old wasm is never
    // paired with this glue.
    new URL('./wenilla_bg.wasm' + new URL(import.meta.url).search, import.meta.url), (got, total) =>
    ui.setWasmProgress(got, total)
  );
  let w;
  try {
    // Attach rejection handlers to both operations now, including while prefetch is pending.
    const [module] = await Promise.all([wasm, prefetch]);
    w = await init({ module_or_path: module });
  } catch (e) {
    ui.fail('The client failed to start: ' + (e && e.message ? e.message : e));
    throw e;
  }
  // init() resolved = module instantiated and the plugin graph built; the heavy catalog frame
  // is still ahead. From here the client drives the stages; the timeout is the drift backstop
  // (an old bundle without webprogress under a new page must not strand the overlay).
  ui.setStage('Starting…');
  ui.armTimeout(opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  return w;
}

// Match wasm-bindgen's non-streaming fallback for servers without the WASM MIME type.
// Choose before consuming the body, avoiding a cloned response buffering the whole module.
async function compileWasm(url, onBytes) {
  const response = await fetchWasm(url, onBytes);
  if (!response.ok) throw new Error(`Client download failed (HTTP ${response.status})`);
  if (typeof WebAssembly.compileStreaming === 'function' &&
      response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/// Byte-counting fetch of the wasm, re-wrapped so streaming compilation survives. Returns a
/// Promise<Response> consumed immediately by compileWasm, before game instantiation.
async function fetchWasm(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok || !r.body) return r; // compileWasm surfaces HTTP errors / handles a missing stream
  const contentLength = Number(r.headers.get('content-length')) || 0;
  const compressed = !!(r.headers.get('content-encoding') || '').trim();
  // A host that knows the decoded size says so (the Cloudflare Worker for the rogue build does);
  // otherwise it is estimated from the compressed length.
  const decoded = Number(r.headers.get('x-decoded-length')) || 0;
  const total = decoded || (contentLength ? contentLength * (compressed ? BR_RATIO : 1) : 0);
  let got = 0;
  const reader = r.body.getReader();
  const counted = new ReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        onBytes(got, got); // the honest total, now that we know it
        c.close();
        return;
      }
      got += value.byteLength;
      onBytes(got, total);
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // Headers are copied so Content-Type: application/wasm survives — compileStreaming
  // refuses anything else.
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/// Warm the HTTP cache with a manifest's read-set: fetch the manifest, then a fixed-size pool of
/// full-body fetches. Failures are counted as done and otherwise ignored — a miss just means
/// that file loads the old way. A missing/invalid manifest resolves immediately (line hides).
/// Used twice: the boot set before `init()`, the world-entry set after `ready`.
async function prefetchManifest(manifestUrl, onProgress) {
  const r = await fetch(manifestUrl);
  if (!r.ok) return onProgress(0, 0);
  const manifest = await r.json();
  const names = Array.isArray(manifest && manifest.names) ? manifest.names : [];
  if (!names.length) return onProgress(0, 0);
  let done = 0;
  onProgress(0, names.length);
  const queue = names.slice();
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      try {
        const resp = await fetch(dataUrl(name));
        if (resp.ok) await resp.arrayBuffer(); // body fully read = body fully cached
      } catch (_) {
        /* offline blip, 404 drift — the sync XHR path will deal with it */
      }
      done += 1;
      onProgress(done, names.length);
    }
  }
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

/// A chain name's URL, the same one the client's own reads use (benilla-formats `web.rs`): the
/// data server's `/data/<encoded name>`, or under `window.__wenilla_data_layout = 'static'` the
/// plain-file layout (lowercase, one encoded path segment per folder) under the page's data base.
/// The prefetch is only worth anything if it warms exactly the URLs the client then asks for.
function dataUrl(name) {
  if (window.__wenilla_data_layout !== 'static') return '/data/' + encodeURIComponent(name);
  const base = String(window.__wenilla_data_base || new URL('/data', location.href).href);
  const path = name.toLowerCase().split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
  // The name index carries the build's stamp, as the client's own fetch of it does (web.rs).
  const stamp = name === '__index' ? String(window.__wenilla_data_stamp || '') : '';
  return base.replace(/\/+$/, '') + '/' + path + stamp;
}

/// `window.__wenilla_progress(stage)` — the client's calls land here (webprogress.rs).
///
/// `ready` also starts the SECOND prefetch: the world-entry read-set. Entering the world used
/// to be one frozen frame of ~200 synchronous sprite reads (184 `Interface\…\*.blp` on the
/// first UI draw, plus a few quest-marker models and zone sounds) — 206 s on a cold 100 ms-RTT
/// cache. That set is location-independent, so `world-manifest.json` (captured the same way
/// as the boot manifest, minus the boot set) is warmed while the player is at the glue screens,
/// with a corner line so it is visible but never in the way. Whatever is still in flight when
/// they click Enter World just loads the old way.
function installProgressHook(ui, skipPrefetch) {
  window.__wenilla_progress = (stage) => {
    if (stage === 'startup') ui.setStage('Loading interface…');
    else if (stage === 'ready') {
      ui.hide();
      if (!skipPrefetch) {
        const corner = createCornerLine();
        prefetchManifest('./world-manifest.json', (done, total) =>
          corner.set(total > 0 && done < total ? `preparing world data — ${done}/${total}` : '')
        )
          .catch(() => {})
          .finally(() => corner.remove());
      }
    }
  };
}

/// The unobtrusive bottom-left status line the world prefetch reports on.
function createCornerLine() {
  const el = document.createElement('div');
  el.id = 'wenilla-corner';
  el.style.cssText =
    'position:fixed;left:.6rem;bottom:.5rem;z-index:15;font:12px system-ui,sans-serif;' +
    'color:#888;background:rgba(0,0,0,.55);padding:.2rem .5rem;border-radius:4px;' +
    'pointer-events:none;transition:opacity .4s ease';
  document.body.appendChild(el);
  return {
    set(text) {
      el.textContent = text;
      el.style.opacity = text ? '1' : '0';
    },
    remove() {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    },
  };
}

/// The overlay itself. Same dark theme as the pages' own chrome; no dependencies, no images.
function createBootUi() {
  const root = document.createElement('div');
  root.id = 'wenilla-boot';
  root.innerHTML = `
    <style>
      #wenilla-boot { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
        background: #000; color: #ccc; font: 15px system-ui, sans-serif;
        transition: opacity .4s ease; }
      #wenilla-boot.gone { opacity: 0; pointer-events: none; }
      #wenilla-boot .box { width: min(420px, 80vw); }
      #wenilla-boot .stage { margin-bottom: .6rem; text-align: center; }
      #wenilla-boot .bar { height: 6px; background: #222; border-radius: 3px; overflow: hidden; }
      #wenilla-boot .bar > i { display: block; height: 100%; width: 0; background: #c9a227;
        border-radius: 3px; transition: width .15s linear; }
      #wenilla-boot .bar.pulse > i { width: 30% !important; animation: wboot-slide 1.2s ease-in-out infinite; }
      /* transform, not margin: a compositor animation keeps moving while the main thread sits in
         the client's synchronous reads, so the bar never looks frozen. */
      @keyframes wboot-slide { 0% { transform: translateX(0) } 50% { transform: translateX(233%) }
        100% { transform: translateX(0) } }
      #wenilla-boot .data { margin-top: .5rem; text-align: center; font-size: 12px; color: #888;
        min-height: 1.2em; }
      #wenilla-boot .err { color: #e07070; text-align: center; }
    </style>
    <div class="box">
      <div class="stage">Loading…</div>
      <div class="bar"><i></i></div>
      <div class="data"></div>
    </div>`;
  document.body.appendChild(root);
  const stageEl = root.querySelector('.stage');
  const barEl = root.querySelector('.bar');
  const fillEl = root.querySelector('.bar > i');
  const dataEl = root.querySelector('.data');
  let gone = false;
  let timeout = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(0);
  // The bar covers both downloads when there is a manifest to prefetch: half the client, half
  // the game data (by file count). Without one it is the client's bytes alone, as it always was.
  let wasmFrac = 0;
  let wasmDone = false;
  let data = { done: 0, total: 0 };
  const fill = () => {
    const frac = data.total > 0 ? (wasmFrac + data.done / data.total) / 2 : wasmFrac;
    const pct = wasmDone && (data.total === 0 || data.done >= data.total) ? 100 : Math.min(99, frac * 100);
    fillEl.style.width = pct.toFixed(1) + '%';
  };
  return {
    setWasmProgress(got, total) {
      if (gone) return;
      if (total > 0) {
        wasmDone = got >= total;
        wasmFrac = wasmDone ? 1 : Math.min(0.99, got / total);
        const pct = Math.floor(wasmFrac * 100);
        if (!wasmDone) stageEl.textContent = `Downloading client — ${pct}% (${mb(got)} MB)`;
        else if (data.total > 0 && data.done < data.total) stageEl.textContent = 'Downloading game data…';
        else stageEl.textContent = 'Downloading client — done';
        fill();
      } else {
        stageEl.textContent = `Downloading client — ${mb(got)} MB`;
        barEl.classList.add('pulse');
      }
    },
    setData(done, total) {
      if (gone) return;
      data = { done, total };
      dataEl.textContent = total > 0 ? `game data — ${done}/${total}` : '';
      if (wasmDone && total > 0 && done < total) stageEl.textContent = 'Downloading game data…';
      if (!barEl.classList.contains('pulse')) fill();
    },
    setStage(text) {
      if (gone) return;
      stageEl.textContent = text;
      barEl.classList.add('pulse');
    },
    fail(text) {
      clearTimeout(timeout);
      barEl.remove();
      dataEl.remove();
      stageEl.className = 'err';
      stageEl.textContent = text;
    },
    armTimeout(ms) {
      timeout = setTimeout(() => this.hide(), ms);
    },
    hide() {
      if (gone) return;
      gone = true;
      clearTimeout(timeout);
      root.classList.add('gone');
      setTimeout(() => root.remove(), 500);
    },
  };
}
