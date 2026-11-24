// monteCarloCore.js — In-browser Monte Carlo Simulation Engine
// Adapted from ANUBIS Gotobi USDJPY Monte Carlo Core (sfc32 PRNG + bootstrap resampling)

export function makeRng(seed = Date.now()) {
  let a = (seed >>> 0) ^ 0xdeadbeef;
  let b = 0x9e3779b9;
  let c = 0x243f6a88;
  let d = 0xb7e15162;

  function sfc() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    return (t >>> 0) / 4294967296;
  }
  for (let i = 0; i < 24; i++) sfc();
  return sfc;
}

export const METRIC_KEYS = [
  'final_equity',
  'net_profit',
  'net_profit_pct',
  'profit_factor',
  'win_rate',
  'mean_R',
  'max_dd_usd',
  'max_dd_pct',
  'max_cons_losses',
  'max_cons_wins',
  'sharpe',
  'sortino',
  'cagr_wealth',
  'risk_of_ruin',
];

/**
 * Runs Monte Carlo simulation
 * @param {Object} p - Input data { R: number[], dates?: Date[], month_idx?: number[], year_idx?: number[], is_sl?: boolean[] }
 * @param {Object} o - Options { iters, start, riskPct, method, policy, withdrawPct, haircut, seed, bandPaths, samplePaths }
 */
export function simulate(p, o) {
  const N = p.R.length;
  if (N === 0) throw new Error('No trades available for simulation.');

  const H = Math.min(o.horizon || N, N);
  const S = o.iters || 2000;
  const method = o.method || 'resample'; // 'resample' | 'shuffle' | 'block' | 'original'
  const start = o.start || 10000;
  const f = (o.riskPct || 1) / 100;
  const policy = o.policy || 'compound'; // 'compound' | 'fixed' | 'withdraw'
  const fixed = policy === 'fixed';
  const wp = policy === 'withdraw' ? (o.withdrawPct !== undefined ? o.withdrawPct : 0.5) : 0;
  const hc = o.haircut || 0; // extra R haircut/slippage per trade

  const unit = new Float64Array(N);
  for (let i = 0; i < N; i++) unit[i] = p.R[i] - hc;

  const m0 = p.month_idx ? p.month_idx[0] : 0;
  const y0 = p.year_idx ? p.year_idx[0] : 0;
  const M = p.M || Math.max(1, Math.ceil(N / 20)); // approximate months if not given
  const yrs = Math.max(1 / 12, M / 12);

  const mi = new Int32Array(H);
  const yi = new Int32Array(H);
  for (let j = 0; j < H; j++) {
    mi[j] = p.month_idx ? p.month_idx[j] - m0 : Math.floor((j / H) * M);
    yi[j] = p.year_idx ? p.year_idx[j] - y0 : Math.floor((j / H) * yrs);
  }

  const out = {};
  for (const key of METRIC_KEYS) out[key] = new Float64Array(S);

  const nBand = Math.min(S, o.bandPaths || 1000);
  const eqStore = new Float32Array(nBand * H);
  const samples = [];
  const nSample = Math.min(S, o.samplePaths || 20);

  const rng = makeRng(o.seed || Date.now());
  const idx = new Int32Array(H);
  const perm = new Int32Array(N);
  const monthly = new Float64Array(M);
  const pBlock = 1 / (o.blockMean || 10);

  let ruinCount = 0;

  for (let s = 0; s < S; s++) {
    if (method === 'resample') {
      for (let j = 0; j < H; j++) idx[j] = Math.floor(rng() * N);
    } else if (method === 'shuffle') {
      for (let i = 0; i < N; i++) perm[i] = i;
      for (let i = N - 1; i > 0; i--) {
        const r = Math.floor(rng() * (i + 1));
        const t = perm[i];
        perm[i] = perm[r];
        perm[r] = t;
      }
      for (let j = 0; j < H; j++) idx[j] = perm[j % N];
    } else if (method === 'block') {
      idx[0] = Math.floor(rng() * N);
      for (let j = 1; j < H; j++) {
        idx[j] = rng() < pBlock ? Math.floor(rng() * N) : (idx[j - 1] + 1) % N;
      }
    } else {
      for (let j = 0; j < H; j++) idx[j] = j % N;
    }

    monthly.fill(0);
    let eq = start;
    let peak = start;
    let ystart = start;
    let ms = start;
    let withdrawn = 0;
    let mdd = 0;
    let mddp = 0;
    let gp = 0;
    let gl = 0;
    let wins = 0;
    let sumR = 0;
    let cw = 0;
    let cl = 0;
    let mw = 0;
    let ml = 0;

    const keepEq = s < nBand;
    const keepSample = s < nSample;
    const sample = keepSample ? new Float32Array(H) : null;

    const closeYear = (last) => {
      const ny = eq - ystart;
      if (wp > 0 && !last && ny > 0) {
        const w = wp * ny;
        eq -= w;
        peak -= w;
        withdrawn += w;
      }
      ystart = eq;
    };

    let isRuined = false;

    for (let j = 0; j < H; j++) {
      if (j > 0 && mi[j] !== mi[j - 1]) {
        const mIdx = Math.min(M - 1, Math.max(0, mi[j - 1]));
        monthly[mIdx] = fixed ? (eq - ms) / start : ms > 0 ? (eq - ms) / ms : 0;
        if (yi[j] !== yi[j - 1]) closeYear(false);
        ms = eq;
      }

      const t = idx[j];
      const u = unit[t];
      const risk = fixed ? f * start : f * eq;
      const pl = risk * u;

      if (!isRuined) {
        eq += pl;
        if (eq <= start * 0.1) {
          // If lost 90%+ or 0
          if (eq <= 0) eq = 0;
          isRuined = true;
        }
      }

      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > mdd) mdd = dd;
      const ddp = peak > 0 ? dd / peak : 0;
      if (ddp > mddp) mddp = ddp;

      const win = u > 0;
      sumR += u;
      if (win) {
        gp += u;
        wins++;
        cw++;
        cl = 0;
        if (cw > mw) mw = cw;
      } else {
        gl -= u;
        cl++;
        cw = 0;
        if (cl > ml) ml = cl;
      }

      if (keepEq) eqStore[s * H + j] = eq;
      if (keepSample) sample[j] = eq;
    }

    if (isRuined) ruinCount++;

    const lastMIdx = Math.min(M - 1, Math.max(0, mi[H - 1]));
    monthly[lastMIdx] = fixed ? (eq - ms) / start : ms > 0 ? (eq - ms) / ms : 0;
    closeYear(true);

    if (keepSample) samples.push(sample);

    let mu = 0;
    for (let q = 0; q < M; q++) mu += monthly[q];
    mu /= M;

    let v = 0;
    let dn = 0;
    for (let q = 0; q < M; q++) {
      const r = monthly[q];
      v += (r - mu) * (r - mu);
      const mn = Math.min(r, 0);
      dn += mn * mn;
    }
    const sd = Math.sqrt(v / Math.max(1, M - 1));
    const dsd = Math.sqrt(dn / Math.max(1, M));
    const wealth = eq + withdrawn;

    out.final_equity[s] = eq;
    out.net_profit[s] = wealth - start;
    out.net_profit_pct[s] = ((wealth - start) / start) * 100;
    out.profit_factor[s] = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
    out.win_rate[s] = (wins / H) * 100;
    out.mean_R[s] = sumR / H;
    out.max_dd_usd[s] = mdd;
    out.max_dd_pct[s] = mddp * 100;
    out.max_cons_losses[s] = ml;
    out.max_cons_wins[s] = mw;
    out.sharpe[s] = sd > 0 ? (mu / sd) * Math.sqrt(12) : 0;
    out.sortino[s] = dsd > 0 ? (mu / dsd) * Math.sqrt(12) : 0;
    out.cagr_wealth[s] = (Math.pow(Math.max(wealth, 1e-9) / start, 1 / yrs) - 1) * 100;
  }

  // Calculate equity percentile bands (5%, 25%, 50%, 75%, 95%)
  const bands = {
    5: new Float64Array(H),
    25: new Float64Array(H),
    50: new Float64Array(H),
    75: new Float64Array(H),
    95: new Float64Array(H),
  };
  const col = new Float32Array(nBand);
  for (let j = 0; j < H; j++) {
    for (let s = 0; s < nBand; s++) col[s] = eqStore[s * H + j];
    col.sort();
    bands[5][j] = col[Math.max(0, Math.floor(0.05 * nBand))];
    bands[25][j] = col[Math.max(0, Math.floor(0.25 * nBand))];
    bands[50][j] = col[Math.max(0, Math.floor(0.50 * nBand))];
    bands[75][j] = col[Math.max(0, Math.floor(0.75 * nBand))];
    bands[95][j] = col[Math.min(nBand - 1, Math.floor(0.95 * nBand))];
  }

  // Summary stats
  const summary = {};
  for (const k of METRIC_KEYS) {
    if (k === 'risk_of_ruin') {
      summary[k] = (ruinCount / S) * 100;
      continue;
    }
    const arr = Float64Array.from(out[k]).sort();
    summary[k] = {
      p5: arr[Math.max(0, Math.floor(0.05 * S))],
      p25: arr[Math.max(0, Math.floor(0.25 * S))],
      median: arr[Math.max(0, Math.floor(0.50 * S))],
      p75: arr[Math.max(0, Math.floor(0.75 * S))],
      p95: arr[Math.min(S - 1, Math.floor(0.95 * S))],
      mean: out[k].reduce((acc, v) => acc + (isFinite(v) ? v : 0), 0) / S,
      min: arr[0],
      max: arr[S - 1],
    };
  }

  return { summary, bands, samples, H, S, start };
}
