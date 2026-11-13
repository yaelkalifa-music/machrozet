// Key change for the playback: phase-vocoder time stretch (with phase locking) + resampling.
// Keeps the tempo, moves every note by `semis` semitones.
const PV = (() => {
  const N = 4096, H = 512;              // analysis window / hop (8x overlap = smooth for music)
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const rev = new Uint32Array(N); { const bits = Math.log2(N); for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; } }
  const cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
  function fft(re, im, inv) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) { const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cosT[k], wi = inv ? sinT[k] : -sinT[k], a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  const NB = N / 2 + 1, TWO_PI = 2 * Math.PI;
  // time-stretch x by factor `a` (output length ~ len*a)
  function stretch(x, a) {
    const Hs = H * a, nFrames = Math.floor((x.length - N) / H) + 1;
    const outLen = Math.ceil(nFrames * Hs + N), y = new Float64Array(outLen), ws = new Float64Array(outLen);
    const re = new Float64Array(N), im = new Float64Array(N);
    const mag = new Float64Array(NB), ph = new Float64Array(NB), prevPh = new Float64Array(NB), synPh = new Float64Array(NB), om = new Float64Array(NB);
    for (let k = 0; k < NB; k++) om[k] = TWO_PI * H * k / N;
    for (let f = 0; f < nFrames; f++) {
      const s = f * H;
      for (let i = 0; i < N; i++) { re[i] = (x[s + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k < NB; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
      // phase propagation at spectral peaks, other bins locked to their peak (identity phase locking)
      if (f === 0) { for (let k = 0; k < NB; k++) synPh[k] = ph[k]; }
      else {
        const inst = new Float64Array(NB);
        for (let k = 0; k < NB; k++) { let d = ph[k] - prevPh[k] - om[k]; d -= TWO_PI * Math.round(d / TWO_PI); inst[k] = (om[k] + d) / H; }
        let peak = 0;
        const newPh = new Float64Array(NB);
        // find peaks
        const isPeak = new Uint8Array(NB);
        for (let k = 2; k < NB - 2; k++) if (mag[k] > mag[k - 1] && mag[k] > mag[k + 1] && mag[k] > mag[k - 2] && mag[k] > mag[k + 2]) isPeak[k] = 1;
        for (let k = 0; k < NB; k++) if (isPeak[k]) newPh[k] = synPh[k] + Hs * inst[k];
        // lock each bin to the nearest peak
        let lastPeak = -1;
        const nearest = new Int32Array(NB).fill(-1);
        for (let k = 0; k < NB; k++) { if (isPeak[k]) lastPeak = k; nearest[k] = lastPeak; }
        let nextPeak = -1;
        for (let k = NB - 1; k >= 0; k--) { if (isPeak[k]) nextPeak = k; const p = nearest[k]; if (p < 0 || (nextPeak >= 0 && nextPeak - k < k - p)) nearest[k] = nextPeak; }
        for (let k = 0; k < NB; k++) { const p = nearest[k]; if (p >= 0) newPh[k] = newPh[p] + (ph[k] - ph[p]); else newPh[k] = synPh[k] + Hs * inst[k]; }
        for (let k = 0; k < NB; k++) synPh[k] = newPh[k];
      }
      for (let k = 0; k < NB; k++) prevPh[k] = ph[k];
      for (let k = 0; k < NB; k++) { re[k] = mag[k] * Math.cos(synPh[k]); im[k] = mag[k] * Math.sin(synPh[k]); }
      for (let k = 1; k < NB - 1; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      fft(re, im, true);
      const o = Math.round(f * Hs);
      for (let i = 0; i < N; i++) { const w = win[i]; y[o + i] += (re[i] / N) * w; ws[o + i] += w * w; }
    }
    for (let i = 0; i < outLen; i++) y[i] = ws[i] > 1e-3 ? y[i] / ws[i] : 0;
    return y;
  }
  // band-limited-ish resampling with 4-point cubic interpolation
  function resample(y, ratio, outLen) { // read y at positions i*ratio
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio, k = Math.floor(p), t = p - k;
      const y0 = y[k - 1] || 0, y1 = y[k] || 0, y2 = y[k + 1] || 0, y3 = y[k + 2] || 0;
      out[i] = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
    }
    return out;
  }
  function shift(x, semis, onProgress) {
    if (!semis) return Float32Array.from(x);
    const r = Math.pow(2, semis / 12);
    const st = stretch(x, r); if (onProgress) onProgress(0.9);
    return resample(st, r, x.length);
  }
  return { shift };
})();
if (typeof module !== 'undefined') module.exports = PV;
globalThis.PV = PV;
