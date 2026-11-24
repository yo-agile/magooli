// Azeroth Survivors — the page around the client. It only boots the wasm: the game's screens
// (the hero picker, the pick cards, the HUD and the end of a run) are drawn by the client itself,
// the same as the native build (crates/wenilla-rogue-app/src/screens).
//
// The query string reaches the launcher as `window.__rogue_config`: `?glue=1` for the client's own
// screens (realm list, character select and create), `?bg=ab` for character select there, or
// `?bg=av&class=mage&race=gnome[&name=Ayla&gender=female]` for a quick run past the main screen.
// Data is plain static files under ./data (window.__wenilla_data_layout = 'static'), so the whole
// folder runs from any static file server: no game server, no data server.


// Sound: browsers suspend an AudioContext made before a user gesture; the mixer makes its own at
// boot and never resumes it, so resume every context on the first click or key.
(() => {
  const contexts = [];
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Orig = window[name];
    if (!Orig) continue;
    const Patched = function (...args) { const c = new Orig(...args); contexts.push(c); return c; };
    Patched.prototype = Orig.prototype;
    window[name] = Patched;
  }
  const resume = () => contexts.forEach((c) => c.state !== 'running' && c.resume().catch(() => {}));
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true, passive: true });
})();


// iPhone WebKit (Safari, and Chrome and every other iOS browser) has no element fullscreen at
// all, prefixed or not. The client is born fullscreen, and winit's web backend then calls
// `canvas.webkitRequestFullscreen()` unchecked when `requestFullscreen` is missing: a TypeError
// that aborts the wasm at boot (and again on the pause menu's Fullscreen button). Give it no-ops.
if (!Element.prototype.requestFullscreen && !Element.prototype.webkitRequestFullscreen) {
  Element.prototype.webkitRequestFullscreen = function () {};
  if (!Document.prototype.webkitExitFullscreen) Document.prototype.webkitExitFullscreen = function () {};
}


// Phones: the game's touch controls (crates/wenilla-rogue-app/src/screens/touch.rs) want the
// whole screen. The first tap goes fullscreen and holds landscape where the browser allows it
// (not iOS Safari, which has neither for a page); a long press opens no menu.
(() => {
  if (!matchMedia('(pointer: coarse)').matches) return;
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  const full = () => {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
  };
  window.addEventListener('pointerup', full, { capture: true, passive: true });
})();


// No WebGPU, or WebGPU with no adapter (hardware acceleration off, a blocklisted GPU or driver,
// a remote desktop): the client would only panic with "Unable to find a GPU!" on a black canvas,
// so say why and do not boot it.
async function gpuProblem() {
  if (!navigator.gpu) {
    return 'This browser has no WebGPU. The world needs it: use a current Chrome, Edge or Safari '
      + '(Linux Chrome: enable chrome://flags/#enable-unsafe-webgpu).';
  }
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (adapter) return null;
  // Chrome on Windows offers WebGPU only on the GPU its own compositor runs on, whatever the
  // powerPreference: a laptop drawing on an integrated Intel GPU without a D3D12 WebGPU adapter
  // gets none, even with a usable NVIDIA or AMD card next to it.
  return 'WebGPU found no usable graphics card. On a laptop with two GPUs, set the browser to the '
    + 'dedicated one: Windows Settings > System > Display > Graphics > Chrome (or Edge) > '
    + 'High performance, then restart the browser. Otherwise turn on "Use graphics acceleration '
    + 'when available" (chrome://settings/system or edge://settings/system) and update the graphics '
    + 'driver. chrome://gpu shows why WebGPU is disabled.';
}


// The warning offers the Windows build too (a direct MEGA link), which needs no WebGPU.
function showGpuWarning(text) {
  document.getElementById('gpu-warning-text').textContent = text;
  document.getElementById('gpu-warning').hidden = false;
}


// The pipelines the client asked WebGPU for, to name the one a lost device died on. A phone's
// shader compiler can crash the browser's GPU process while building a pipeline (Adreno 840:
// SIGSEGV in libllvm-qgl.so under vkCreateGraphicsPipelines), and the page only ever hears "device
// lost". The GPU process builds pipelines in the order they were asked for, so each one is
// followed by an error-scope round trip: its answer means the GPU process got past that pipeline.
// The first pipeline still unanswered when the device is lost is the one the driver was
// compiling; none unanswered means the crash was not in one of the game's pipelines. The report
// keeps that pipeline's WGSL and is saved (localStorage 'rogue.gpuCrash', printed again on the
// next load) so it can be read off a phone.
const PIPE_DONE_KEPT = 8;
let pipeJournal = [];
const bevyPipeLines = [];
const moduleCode = new WeakMap();
let pipeSeq = 0;
const GPU_CRASH_KEY = 'rogue.gpuCrash';


function journalPipelines() {
  const dev = globalThis.GPUDevice?.prototype;
  if (!dev?.createShaderModule) return;
  const createShaderModule = dev.createShaderModule;
  dev.createShaderModule = function (desc) {
    const module = createShaderModule.call(this, desc);
    if (typeof desc?.code === 'string') moduleCode.set(module, desc.code);
    return module;
  };
  // Pending entries all stay; answered ones only the last few, for context.
  const note = (kind, desc) => {
    const entry = { n: ++pipeSeq, kind, at: Math.round(performance.now()), desc, done: false };
    pipeJournal.push(entry);
    let done = 0;
    for (let i = pipeJournal.length - 1; i >= 0; i--) {
      if (pipeJournal[i].done && ++done > PIPE_DONE_KEPT) pipeJournal[i] = null;
    }
    pipeJournal = pipeJournal.filter(Boolean);
    return entry;
  };
  for (const [name, kind] of [['createRenderPipeline', 'render'], ['createComputePipeline', 'compute']]) {
    const orig = dev[name];
    if (!orig) continue;
    dev[name] = function (desc) {
      const entry = note(kind, desc);
      this.pushErrorScope('internal');
      const pipeline = orig.call(this, desc);
      this.popErrorScope().then((err) => {
        entry.done = true;
        if (err) console.error(`WebGPU internal error building ${desc?.label || 'a pipeline'}:`, err.message);
      }, () => {});
      return pipeline;
    };
  }
  for (const [name, kind] of [['createRenderPipelineAsync', 'render-async'], ['createComputePipelineAsync', 'compute-async']]) {
    const orig = dev[name];
    if (!orig) continue;
    dev[name] = function (desc) {
      const entry = note(kind, desc);
      const promise = orig.call(this, desc);
      promise.then(() => { entry.done = true; }, () => { entry.done = true; });
      return promise;
    };
  }
  // The client's own line for each pipeline built mid-run (its shader defs), from its warnings.
  for (const level of ['warn', 'info', 'log', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) {
      const first = args[0];
      if (typeof first === 'string' && first.includes('pipeline compiled')) {
        bevyPipeLines.push(`${Math.round(performance.now())}ms ${first}`);
        if (bevyPipeLines.length > 24) bevyPipeLines.shift();
      }
      return orig.apply(this, args);
    };
  }
}


// The report: the pipelines the GPU process had not answered for (the first is the one it was
// building), with the WGSL of the first three, and the last few it had finished.
function pipelineReport(lostAt, adapterInfo, message) {
  const stage = (s) => s && `${s.module?.label || '?'}:${s.entryPoint || '(default)'}`;
  const line = (p) => `  #${p.n} ${p.at}ms ${p.kind} label=${p.desc?.label || '?'} `
    + `vs=${stage(p.desc?.vertex)} fs=${stage(p.desc?.fragment) || stage(p.desc?.compute) || 'none'}`;
  const pending = pipeJournal.filter((p) => !p.done);
  const done = pipeJournal.filter((p) => p.done);
  const lines = [
    `WebGPU device lost at ${Math.round(lostAt)} ms: ${message}`,
    `adapter: ${JSON.stringify(adapterInfo || {})}`,
    `user agent: ${navigator.userAgent}`,
    `pipelines asked for: ${pipeSeq}; not yet built by the GPU process: ${pending.length}`,
    pending.length
      ? 'IN FLIGHT (the first is the one the driver was compiling):'
      : 'NONE IN FLIGHT: the GPU process had built every pipeline the game asked for, so the crash was not in one of them.',
    ...pending.map(line),
    'last built:',
    ...done.map(line),
    'the client\'s last pipeline lines:',
    ...bevyPipeLines.map((l) => `  ${l}`),
  ];
  const seen = new Set();
  for (const p of pending.slice(0, 3)) {
    for (const s of [p.desc?.vertex, p.desc?.fragment, p.desc?.compute]) {
      const code = s?.module && moduleCode.get(s.module);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      lines.push(`----- WGSL of #${p.n} ${p.desc?.label || '?'} (${s.module.label || '?'}) -----`, code);
    }
  }
  return lines.join('\n');
}


// What the game holds on the GPU: every buffer, texture and query set the client made and has not
// destroyed (or the JS GC has not collected), by kind and label, with its size. Firefox players
// lost the device to "Out of memory" with the browser at 14-16 GB after ~5 min; the report says
// whether the game's own allocations grew or the browser's around them. `__gpuLedger()` prints it
// any time; `?gpumem=<seconds>` prints a one-line total every that many seconds.
const ledger = { live: new Map(), seq: 0, made: 0, freed: 0, writes: 0, writeBytes: 0, madeBy: new Map(), wroteTo: new Map() };


const FORMAT_BYTES = [
  [/^(bc1|bc4)/, 0.5], [/^(bc|etc2|eac|astc)/, 1], [/^(r8|stencil8)/, 1], [/^(rg8|r16|depth16)/, 2],
  [/^(rgba16|rg32)/, 8], [/^rgba32/, 16], [/^depth32float-stencil8/, 8],
];
function textureBytes(desc) {
  const s = desc?.size || {};
  const [w, h, d] = Array.isArray(s) || s[Symbol.iterator] ? [...s] : [s.width, s.height, s.depthOrArrayLayers];
  const fmt = String(desc?.format || '');
  const bpp = (FORMAT_BYTES.find(([re]) => re.test(fmt)) || [0, 4])[1];
  const mips = (desc?.mipLevelCount || 1) > 1 ? 4 / 3 : 1;
  return Math.round((w || 1) * (h || 1) * (d || 1) * bpp * mips * (desc?.sampleCount || 1));
}


function trackGpuAllocations() {
  const dev = globalThis.GPUDevice?.prototype;
  if (!dev?.createBuffer) return;
  const ids = new WeakMap();
  const gone = new FinalizationRegistry((id) => { if (ledger.live.delete(id)) ledger.freed++; });
  const track = (obj, kind, label, bytes, usage) => {
    const id = ++ledger.seq;
    ids.set(obj, id);
    ledger.live.set(id, { id, kind, label: label || '?', bytes, usage });
    ledger.made++;
    const key = `${kind} ${label || '?'}`;
    const m = ledger.madeBy.get(key) || { n: 0, bytes: 0 };
    m.n++;
    m.bytes += bytes;
    ledger.madeBy.set(key, m);
    gone.register(obj, id);
    return obj;
  };
  const sizers = {
    createBuffer: ['buffer', (d) => d?.size || 0],
    createTexture: ['texture', textureBytes],
    createQuerySet: ['queryset', (d) => (d?.count || 0) * 8],
  };
  for (const [name, [kind, size]] of Object.entries(sizers)) {
    const orig = dev[name];
    if (!orig) continue;
    dev[name] = function (desc) { return track(orig.call(this, desc), kind, desc?.label, size(desc), desc?.usage); };
  }
  for (const cls of ['GPUBuffer', 'GPUTexture', 'GPUQuerySet']) {
    const proto = globalThis[cls]?.prototype;
    const destroy = proto?.destroy;
    if (!destroy) continue;
    proto.destroy = function () {
      const id = ids.get(this);
      if (id !== undefined && ledger.live.delete(id)) ledger.freed++;
      return destroy.call(this);
    };
  }
  const queue = globalThis.GPUQueue?.prototype;
  for (const name of ['writeBuffer', 'writeTexture']) {
    const orig = queue?.[name];
    if (!orig) continue;
    queue[name] = function (...args) {
      ledger.writes++;
      // writeBuffer(buffer, offset, data, dataOffset, size): the size counts, not the view's
      // length; writeTexture(destination, data, layout, size): the data as given.
      const [dest, data] = name === 'writeBuffer' ? [args[0], args[2]] : [args[0]?.texture, args[1]];
      const bytes = name === 'writeBuffer' && args[4] !== undefined ? args[4]
        : (data?.byteLength || 0) - (name === 'writeBuffer' ? args[3] || 0 : 0);
      ledger.writeBytes += bytes;
      const entry = ledger.live.get(ids.get(dest));
      // An unlabeled buffer (Bevy's BufferVec and friends) by its size and usage bits, never its
      // id: buffers are made and dropped hundreds of times a second, and a key per buffer grew
      // this map without end over a long session.
      const key = entry && entry.label === '?'
        ? `${name} ? ${mb(entry.bytes)} usage=0x${(entry.usage || 0).toString(16)}`
        : `${name} ${entry?.label || '?'}`;
      const w = ledger.wroteTo.get(key) || { n: 0, bytes: 0 };
      w.n++;
      w.bytes += bytes;
      ledger.wroteTo.set(key, w);
      return orig.apply(this, args);
    };
  }
}


const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;


function ledgerSummary() {
  const byKind = {};
  for (const e of ledger.live.values()) {
    const k = (byKind[e.kind] ||= { n: 0, bytes: 0 });
    k.n++;
    k.bytes += e.bytes;
  }
  const kinds = Object.entries(byKind).map(([k, v]) => `${k} ${v.n} (${mb(v.bytes)})`).join(', ');
  return `GPU ledger: live ${kinds || 'nothing'}; made ${ledger.made}, freed ${ledger.freed}; `
    + `queue writes ${ledger.writes} (${mb(ledger.writeBytes)})`;
}


function ledgerReport(top = 15) {
  const byLabel = new Map();
  for (const e of ledger.live.values()) {
    const key = `${e.kind} ${e.label}`;
    const v = byLabel.get(key) || { n: 0, bytes: 0 };
    v.n++;
    v.bytes += e.bytes;
    byLabel.set(key, v);
  }
  const rows = [...byLabel].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)
    .map(([key, v]) => `  ${mb(v.bytes).padStart(10)}  x${v.n}  ${key}`);
  // The churn since the page loaded: what is made and written over and over, live or not.
  const churn = (map) => [...map].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
    .map(([key, v]) => `  ${mb(v.bytes).padStart(10)}  x${v.n}  ${key}`);
  return [ledgerSummary(), 'largest by label:', ...rows,
    'made most (all time):', ...churn(ledger.madeBy),
    'written most (all time):', ...churn(ledger.wroteTo)].join('\n');
}
window.__gpuLedger = () => console.log(ledgerReport(40));


// The report a previous page's lost device left, printed once and kept until the next loss.
function previousGpuCrash() {
  try {
    const report = localStorage.getItem(GPU_CRASH_KEY);
    if (report) console.warn(`The previous session lost its WebGPU device:\n${report}`);
  } catch {}
}


// A lost WebGPU device (a driver reset, the GPU handed between cards) leaves the client panicking
// on a frozen canvas: watch every device the client makes and say what happened.
function watchDeviceLoss() {
  const proto = globalThis.GPUAdapter?.prototype;
  if (!proto?.requestDevice) return;
  const requestDevice = proto.requestDevice;
  proto.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    const adapterInfo = this.info && {
      vendor: this.info.vendor, architecture: this.info.architecture,
      device: this.info.device, description: this.info.description,
    };
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      const lostAt = performance.now();
      console.error('WebGPU device lost:', info.message);
      const report = `${pipelineReport(lostAt, adapterInfo, info.message)}\n${ledgerReport()}`;
      console.error(report);
      try { localStorage.setItem(GPU_CRASH_KEY, report); } catch {}
      const phone = /Android|iPhone|iPad/.test(navigator.userAgent);
      showGpuWarning(phone
        ? "The phone's graphics driver crashed while the game was preparing a shader (WebGPU "
          + `device lost: ${info.message || 'no reason given'}). Reload the page to play on; the `
          + "browser's console has a report of the shader it was building."
        : 'The graphics card stopped responding to the game (WebGPU device lost: '
          + `${info.message || 'no reason given'}). Reload the page. If it keeps happening on a `
          + 'laptop with two GPUs, set the browser to one of them: Windows Settings > System > '
          + 'Display > Graphics > Chrome (or Edge) > High performance, then restart the browser.');
    });
    return device;
  };
}


async function start() {
  const problem = await gpuProblem();
  if (problem) {
    showGpuWarning(problem);
    return;
  }
  previousGpuCrash();
  journalPipelines();
  watchDeviceLoss();
  trackGpuAllocations();
  const q = new URLSearchParams(location.search);
  const memEvery = Number(q.get('gpumem'));
  if (memEvery > 0) {
    let before = new Map();
    let wroteBefore = new Map();
    setInterval(() => {
      const wrote = [...ledger.wroteTo].map(([k, v]) => [k, v.n - (wroteBefore.get(k)?.n || 0), v.bytes - (wroteBefore.get(k)?.bytes || 0)])
        .filter(([, n]) => n > 0).sort((a, b) => b[2] - a[2]).slice(0, 8)
        .map(([k, n, bytes]) => `${k} x${n} ${mb(bytes)}`).join('; ');
      wroteBefore = new Map([...ledger.wroteTo].map(([k, v]) => [k, { ...v }]));
      const churn = [...ledger.madeBy].map(([k, v]) => [k, v.n - (before.get(k)?.n || 0), v.bytes - (before.get(k)?.bytes || 0)])
        .filter(([, n]) => n > 0).sort((a, b) => b[2] - a[2]).slice(0, 6)
        .map(([k, n, bytes]) => `${k} x${n} ${mb(bytes)}`).join('; ');
      before = new Map([...ledger.madeBy].map(([k, v]) => [k, { ...v }]));
      console.log(`${ledgerSummary()}; made in the last ${memEvery} s: ${churn || 'nothing'}; `
        + `written: ${wrote || 'nothing'}`);
    }, memEvery * 1000);
  }
  window.__rogue_config = Object.fromEntries(
    ['glue', 'bg', 'class', 'race', 'name', 'gender'].map((k) => [k, q.get(k) || ''])
  );
  window.__wenilla_data_layout = 'static';
  window.__wenilla_data_base = new URL('./data', location.href).href;
  // The name index is fetched under the build's stamp (rogue-build.sh hashes it in): /data/ is
  // cached a day, and a stale index hides every file a release added (a new zone's floors).
  window.__wenilla_data_stamp = STAMP;
  // Low-cost defaults for a one-thread client; any CVar still wins from the query string.
  window.__wenilla_env = { farclip: '420' };
  // Android: no pipeline warm pass behind the loading screen. Building every variant at once
  // (~2000) crashed an Adreno 840's shader compiler, and with it the browser's GPU process; only
  // what is drawn compiles without it. `?pipe_warm=1` keeps the pass.
  const warm = q.get('pipe_warm') ?? (/Android/.test(navigator.userAgent) ? '0' : null);
  if (warm !== null) window.__wenilla_env.pipe_warm = warm;
  // Android: the plain StandardMaterial shader without Bevy's lights and shadows (web_pbr_lite.rs).
  // Adreno 840's compiler crashed the GPU process on the full one every time (name plates, the
  // fallback cube). `?pbr_lite=0` restores it.
  const lite = q.get('pbr_lite') ?? (/Android/.test(navigator.userAgent) ? '1' : null);
  if (lite !== null) window.__wenilla_env.pbr_lite = lite;
  // The player's addons (addons.js), in memory before the client looks for its AddOns folder. A
  // failure costs only the addons.
  try {
    await (await import(`./addons.js${STAMP}`)).mount();
  } catch (e) {
    console.warn('AddOns could not be read:', e);
  }
  // Exporting and importing the save (saves.js); a failure costs only those buttons.
  try {
    await import(`./saves.js${STAMP}`);
  } catch (e) {
    console.warn('The save files could not be set up:', e);
  }
  // Typing Chinese, Japanese and Korean (ime.js); a failure costs only their input methods.
  try {
    await import(`./ime.js${STAMP}`);
  } catch (e) {
    console.warn('The input methods could not be set up:', e);
  }
  try {
    const { default: init } = await import(`./wenilla.js${STAMP}`);
    const { bind } = await import(`./wasi_stubs.js${STAMP}`);
    const { boot } = await import(`./boot.js${STAMP}`);
    const w = await boot(init);
    bind(w.memory);
  } catch (e) {
    // A failed boot (most often WebGPU refusing the client's device) leaves a black canvas.
    console.error('The game failed to start:', e);
    document.getElementById('wenilla-boot')?.remove();
    showGpuWarning(`The game failed to start in this browser (${e?.message || e}).`);
    // HTTP 429: the Worker is over its request limit, too many players at once.
    if (String(e?.message || e).includes('HTTP 429')) {
      document.getElementById('busy-note').hidden = false;
    }
    return;
  }
  document.getElementById('benilla').focus();
}


// The build's stamp (?v=, written into index.html by scripts/rogue-build.sh) goes on every module
// this page loads: Cloudflare stretches the .js files' cache to four hours whatever nginx says, and
// a cached old wenilla.js under a new wasm fails to start ("Import #... requires a callable").
// wasi_stubs.js keeps the importmap's exact URL, so the glue and this page share one instance.
const STAMP = new URL(import.meta.url).search;


start();