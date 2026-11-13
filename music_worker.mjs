// Music worker: AI vocal removal (onnxruntime-web) + key change for the playback.
import * as ort from './ort/ort.all.min.mjs';
import './sep.js';
import './pv.js';
ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
let session = null, backend = '';

// big files are stored in pieces (hosting limit per file); fetch them in parallel and join
async function fetchParts(url, n, total, onProg) {
  const got = new Array(n).fill(0);
  const pieces = await Promise.all([...Array(n).keys()].map(async k => {
    const res = await fetch(url + '.part' + k); if (!res.ok) throw new Error('download ' + res.status);
    const reader = res.body.getReader(); const parts = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got[k] += value.length; if (onProg) onProg(Math.min(1, got.reduce((a, b) => a + b, 0) / total)); }
    return parts; }));
  const size = got.reduce((a, b) => a + b, 0); if (size !== total) throw new Error('size ' + size);
  const u = new Uint8Array(size); let o = 0; for (const parts of pieces) for (const p of parts) { u.set(p, o); o += p.length; }
  return u.buffer;
}
async function loadWasm() {
  if (ort.env.wasm.wasmBinary) return;
  const url = new URL('./ort/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;
  let buf = null;
  try { const c = await caches.open('diva-models-v1'); const hit = await c.match(url); if (hit) buf = await hit.arrayBuffer(); } catch (e) {}
  if (!buf) { buf = await fetchParts(url, 3, 21663894); try { const c = await caches.open('diva-models-v1'); await c.put(url, new Response(buf.slice(0))); } catch (e) {} }
  ort.env.wasm.wasmBinary = buf;
}
async function loadModel(post) {
  await loadWasm();
  if (session) return;
  const url = new URL('./models/kara2.onnx', import.meta.url).href;
  let buf = null;
  try { const c = await caches.open('diva-models-v1'); const hit = await c.match(url); if (hit) buf = await hit.arrayBuffer(); } catch (e) {}
  if (!buf) {
    buf = await fetchParts(url, 7, 52786726, f => post({ stage: 'download', progress: f }));
    try { const c = await caches.open('diva-models-v1'); await c.put(url, new Response(buf.slice(0))); } catch (e) {}
  }
  post({ stage: 'prepare', progress: 0 });
  const tryEP = async ep => { const s = await ort.InferenceSession.create(buf, { executionProviders: [ep], graphOptimizationLevel: 'all' });
    // smoke test once (WebGPU can fail on some devices)
    await s.run({ input: new ort.Tensor('float32', new Float32Array(4 * 2048 * 256), [1, 4, 2048, 256]) }); return s; };
  if (self.navigator && navigator.gpu) { try { session = await tryEP('webgpu'); backend = 'webgpu'; } catch (e) { session = null; } }
  if (!session) { session = await tryEP('wasm'); backend = 'wasm'; }
}
function resample(x, from, to) {
  if (from === to) return x;
  const r = from / to, n = Math.floor(x.length / r), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), t = p - k; const y0 = x[k - 1] || 0, y1 = x[k] || 0, y2 = x[k + 1] || 0, y3 = x[k + 2] || 0;
    y[i] = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0))); }
  return y;
}
onmessage = async e => {
  const m = e.data; const post = o => postMessage({ id: m.id, ...o });
  try {
    if (m.type === 'separate') {
      await loadModel(post);
      const L = resample(m.L, m.sr, 44100), R = resample(m.R, m.sr, 44100);
      const t0 = Date.now();
      const out = await SEP.run(ort, session, L, R, p => post({ stage: 'separate', progress: p, backend, elapsed: (Date.now() - t0) / 1000 }));
      let oL = resample(out.L, 44100, m.sr), oR = resample(out.R, 44100, m.sr);
      const n = m.L.length; if (oL.length !== n) { const a = new Float32Array(n), b = new Float32Array(n); a.set(oL.subarray(0, n)); b.set(oR.subarray(0, n)); oL = a; oR = b; }
      postMessage({ id: m.id, done: true, L: oL, R: oR, backend }, [oL.buffer, oR.buffer]);
    } else if (m.type === 'vocals') {
      // mono mic take with music leaking in from a speaker -> keep only the singing (mix minus AI instrumental)
      await loadModel(post);
      const X = resample(m.X, m.sr, 44100);
      const t0 = Date.now();
      const out = await SEP.run(ort, session, X, X, p => post({ stage: 'separate', progress: p, backend, elapsed: (Date.now() - t0) / 1000 }));
      const V = new Float32Array(X.length); for (let i = 0; i < X.length; i++) V[i] = X[i] - 0.5 * (out.L[i] + out.R[i]);
      let v = resample(V, 44100, m.sr); const n = m.X.length; if (v.length !== n) { const a = new Float32Array(n); a.set(v.subarray(0, n)); v = a; }
      postMessage({ id: m.id, done: true, V: v, backend }, [v.buffer]);
    } else if (m.type === 'transpose') {
      const L = PV.shift(m.L, m.semis); post({ stage: 'transpose', progress: 0.5 });
      const R = m.R ? PV.shift(m.R, m.semis) : L;
      postMessage({ id: m.id, done: true, L, R }, R === L ? [L.buffer] : [L.buffer, R.buffer]);
    }
  } catch (err) { post({ error: String(err && err.message || err) }); }
};
