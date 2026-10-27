// VoiceDen voice gate. It used to run in the page's requestAnimationFrame loop,
// which the browser freezes in a background tab — so a gated mic went silent the
// moment you alt-tabbed into a game. On the audio thread it keeps working.
//
// Level = RMS over a sliding 512-sample window: the same window and scale as the
// AnalyserNode the UI meters read, so the slider means the same thing in both.
class VdGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.thr = 0.029;
    this.holdFrames = Math.round(0.32 * sampleRate);
    this.left = 0;                       // frames the gate stays open after the last loud one
    this.gain = 1;
    this.win = new Float32Array(512);
    this.wi = 0;
    this.sum = 0;
    this.sinceExact = 0;
    // one-pole smoothing: ~4 ms to open, ~20 ms to close, so it never clicks
    this.att = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.rel = 1 - Math.exp(-1 / (0.020 * sampleRate));
    this.port.onmessage = e => {
      const d = e.data || {};
      if ('on' in d) { this.on = !!d.on; this.left = 0; }
      if ('thr' in d) this.thr = +d.thr || 0;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    if (!inp) { out.fill(0); return true; }

    for (let i = 0; i < inp.length; i++) {
      const s = inp[i], old = this.win[this.wi];
      this.sum += s * s - old * old;
      this.win[this.wi] = s;
      this.wi = (this.wi + 1) & 511;
    }
    // the running sum drifts with float error; re-add it exactly once a second
    if ((this.sinceExact += inp.length) >= sampleRate) {
      this.sinceExact = 0;
      let t = 0;
      for (let i = 0; i < 512; i++) t += this.win[i] * this.win[i];
      this.sum = t;
    }
    const level = Math.sqrt(Math.max(0, this.sum) / 512);

    let target = 1;
    if (this.on) {
      if (level > this.thr) this.left = this.holdFrames;
      else this.left -= inp.length;
      target = this.left > 0 ? 1 : 0;
    }
    const k = target > this.gain ? this.att : this.rel;
    for (let i = 0; i < inp.length; i++) {
      this.gain += (target - this.gain) * k;
      out[i] = inp[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('vd-gate', VdGate);
