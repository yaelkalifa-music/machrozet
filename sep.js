// Vocal remover: MDX-Net (UVR KARA 2) via onnxruntime-web. Runs in a Web Worker (or node for tests).
// Input: stereo Float32Arrays at 44100 Hz. Output: instrumental (lead vocal removed), same length.
const SEP = (() => {
  const N_FFT = 4096, HOP = 1024, DIM_F = 2048, DIM_T = 256, COMP = 1.065;
  const CHUNK = HOP * (DIM_T - 1), TRIM = N_FFT / 2, GEN = CHUNK - 2 * TRIM, NB = N_FFT / 2 + 1;
  const win = new Float32Array(N_FFT); for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT); // periodic hann

  // ---- radix-2 complex FFT (in place), size N_FFT
  const rev = new Uint32Array(N_FFT); { const bits = Math.log2(N_FFT); for (let i = 0; i < N_FFT; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; } }
  const cosT = new Float64Array(N_FFT / 2), sinT = new Float64Array(N_FFT / 2);
  for (let i = 0; i < N_FFT / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N_FFT); sinT[i] = Math.sin(2 * Math.PI * i / N_FFT); }
  function fft(re, im, inverse) {
    for (let i = 0; i < N_FFT; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N_FFT; size <<= 1) {
      const half = size >> 1, step = N_FFT / size;
      for (let i = 0; i < N_FFT; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cosT[k], wi = inverse ? sinT[k] : -sinT[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);

  // STFT of one channel chunk (length CHUNK), centre=True with reflect padding -> fills spec[ri][f][t] slices
  function stft(x, outRe, outIm) { // outRe/outIm: Float32Array(DIM_F*DIM_T), index f*DIM_T+t
    const P = N_FFT / 2;
    for (let t = 0; t < DIM_T; t++) {
      const start = t * HOP - P;
      for (let i = 0; i < N_FFT; i++) {
        let k = start + i; if (k < 0) k = -k; else if (k >= CHUNK) k = 2 * (CHUNK - 1) - k;
        re[i] = x[k] * win[i]; im[i] = 0;
      }
      fft(re, im, false);
      for (let f = 0; f < DIM_F; f++) { outRe[f * DIM_T + t] = re[f]; outIm[f * DIM_T + t] = im[f]; }
    }
  }
  // inverse STFT (bins >= DIM_F are zero), returns CHUNK samples
  const ola = new Float64Array(CHUNK + N_FFT), wsum = new Float64Array(CHUNK + N_FFT);
  function istft(sRe, sIm, out) {
    ola.fill(0); wsum.fill(0);
    for (let t = 0; t < DIM_T; t++) {
      re.fill(0); im.fill(0);
      for (let f = 0; f < DIM_F; f++) { re[f] = sRe[f * DIM_T + t]; im[f] = sIm[f * DIM_T + t]; }
      for (let f = 1; f < NB - 1; f++) { re[N_FFT - f] = re[f]; im[N_FFT - f] = -im[f]; } // hermitian
      fft(re, im, true);
      const o = t * HOP;
      for (let i = 0; i < N_FFT; i++) { const w = win[i]; ola[o + i] += (re[i] / N_FFT) * w; wsum[o + i] += w * w; }
    }
    for (let i = 0; i < CHUNK; i++) { const k = i + N_FFT / 2; out[i] = ola[k] / Math.max(wsum[k], 1e-8); }
  }

  async function run(ort, session, L, R, onProgress) {
    const n = L.length, pad = GEN - (n % GEN), tot = TRIM + n + pad + TRIM;
    const xL = new Float32Array(tot), xR = new Float32Array(tot); xL.set(L, TRIM); xR.set(R, TRIM);
    const oL = new Float32Array(tot), oR = new Float32Array(tot);
    const inp = new Float32Array(4 * DIM_F * DIM_T), cL = new Float32Array(CHUNK), cR = new Float32Array(CHUNK), r = new Float32Array(CHUNK);
    const S = DIM_F * DIM_T;
    const steps = Math.ceil((tot - 2 * TRIM) / GEN);
    for (let s = 0, i = 0; i < tot - 2 * TRIM; i += GEN, s++) {
      cL.fill(0); cR.fill(0); cL.set(xL.subarray(i, Math.min(tot, i + CHUNK))); cR.set(xR.subarray(i, Math.min(tot, i + CHUNK)));
      stft(cL, inp.subarray(0, S), inp.subarray(S, 2 * S));
      stft(cR, inp.subarray(2 * S, 3 * S), inp.subarray(3 * S, 4 * S));
      const res = await session.run({ input: new ort.Tensor('float32', inp, [1, 4, DIM_F, DIM_T]) });
      const o = res.output.data;
      istft(o.subarray(0, S), o.subarray(S, 2 * S), r); for (let k = 0; k < GEN; k++) oL[i + TRIM + k] = r[TRIM + k] * COMP;
      istft(o.subarray(2 * S, 3 * S), o.subarray(3 * S, 4 * S), r); for (let k = 0; k < GEN; k++) oR[i + TRIM + k] = r[TRIM + k] * COMP;
      if (onProgress) onProgress((s + 1) / steps);
    }
    return { L: oL.slice(TRIM, TRIM + n), R: oR.slice(TRIM, TRIM + n) };
  }
  return { run, SR: 44100 };
})();
if (typeof module !== 'undefined') module.exports = SEP;
globalThis.SEP = SEP;
