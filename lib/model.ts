// lib/model.ts — Launch Radar value model.
//
// Everything here is fitted on the snapshot's own traded tokens. Nothing is
// hardcoded by name: the ranking, the odds and the verdicts all come from
// the sealed snapshot's figures, and every fitted term is printed with the
// two held-out tests that kept it or dropped it.
//
// The model, in one line: implied value = (TVL through a fitted size curve)
// x (token odds from the peers' record). The size curve is a power law on
// the comps; the odds are a small logit on the eligible peers. Terms that
// did not lower the held-out miss in BOTH validation protocols are listed
// under "tested, not used" and never enter a price.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

// ------------------------------------------------------------------ rules

/** Categories the house's watchlist rule sets aside (RULES: the watchlist). */
export const SET_ASIDE_CATS = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** True when DefiLlama records no token for the protocol. */
export function recordsNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the protocol passes the house's eligibility rules (any token status). */
export function isEligible(p: Proto): boolean {
  if (SET_ASIDE_CATS.has(p.category ?? '')) return false;
  if (VERSION_TAIL.test(p.name ?? '')) return false;
  if (WRAPPED_WORD.test(p.name ?? '')) return false;
  for (const e of EXCHANGES) if ((p.name ?? '').startsWith(e)) return false;
  return true;
}

/** Ranked iff pre-token and eligible. The watchlist is the floor, never the ceiling. */
export function isRanked(p: Proto): boolean {
  return recordsNoToken(p) && isEligible(p);
}

/** First alphanumeric token of a name, lowercased, version tail stripped. */
export function nameStem(name: string): string {
  const s = VERSION_TAIL.test(name) ? name.replace(VERSION_TAIL, '') : name;
  const toks = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return toks.length > 0 ? toks[0]! : s.toLowerCase();
}

/** Days from listed_at to the snapshot date; null when DefiLlama reports none. */
export function ageDays(p: Proto, asOf: string): number | null {
  if (!p.listed_at) return null;
  const a = Date.parse(asOf + 'T00:00:00Z');
  const b = Date.parse(p.listed_at + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86400000));
}

/** Seven-day TVL change as a fraction, clamped to [-60%, +120%]; null means flat. */
export function growthClamped(p: Proto): number {
  if (p.change_7d === null || p.change_7d === undefined) return 0;
  return Math.max(-0.6, Math.min(1.2, p.change_7d / 100));
}

/** Median of an array's middle (or the mean of the two middles). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Quantile of a sorted array by nearest-rank position (clamped). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i]!;
}

/** Small deterministic PRNG (mulberry32): the bootstrap must repeat byte for byte. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ OLS

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const k = A.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-12) m[piv]![c] = 1e-12;
    const tmp = m[c]!;
    m[c] = m[piv]!;
    m[piv] = tmp;
    const pv = m[c]![c]!;
    for (let r = 0; r < k; r++) {
      if (r !== c && m[r]![c] !== 0) {
        const f = m[r]![c]! / pv;
        for (let j = c; j <= k; j++) m[r]![j]! -= f * m[c]![j]!;
      }
    }
  }
  return m.map((row, i) => row[k]! / row[i]!);
}

/**
 * Ordinary least squares with an optional ridge penalty per coefficient
 * (0 = unpenalised). X rows are feature vectors, y the targets.
 */
export function ridgeOls(X: number[][], y: number[], pen: number[]): number[] {
  const k = X[0]!.length;
  const A: number[][] = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < X.length; r++) s += X[r]![i]! * X[r]![j]!;
      if (i === j) s += pen[i]!;
      row.push(s);
    }
    A.push(row);
  }
  const b: number[] = [];
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let r = 0; r < X.length; r++) s += X[r]![i]! * y[r]!;
    b.push(s);
  }
  return solveLinear(A, b);
}

/** Dot product of two equal-length vectors. */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// ------------------------------------------------------------------ size curve

/** The comps: traded tokens with a usable market cap (n=128 on this snapshot). */
export function compsOf(snap: Snap): Proto[] {
  return snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
}

/** Feature vector for the size curve: [1, log TVL]. */
export function sizeFeatures(p: Proto): number[] {
  return [1, Math.log(Math.max(1, p.tvl_usd))];
}

export interface SizeFit {
  a: number;
  b: number;
  n: number;
  medAbsLogErr: number;
}

/** OLS fit of log(mcap) = a + b * log(tvl) on the comps. */
export function fitSizeCurve(comps: Proto[]): SizeFit {
  const X = comps.map(sizeFeatures);
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const beta = ridgeOls(X, y, [0, 0]);
  const errs = comps.map((p, i) => Math.abs(y[i]! - dot(beta, X[i]!)));
  return { a: beta[0]!, b: beta[1]!, n: comps.length, medAbsLogErr: median(errs) };
}

/** log(mcap) predicted by the size curve for a protocol. */
export function sizePredict(fit: SizeFit, p: Proto): number {
  return fit.a + fit.b * Math.log(Math.max(1, p.tvl_usd));
}

// ------------------------------------------------------------------ term validation

export interface TermRow {
  name: string;
  looMiss: number; // median |log| miss, leave-one-out (as a multiple: exp of it)
  wfMiss: number; // median |log| miss, walk-forward older -> newer
  kept: boolean;
}

/**
 * Two-stage ridge effect for a grouping key (category or name stem):
 * mean residual per group, shrunk toward 0 by n / (n + pseudo).
 */
export function shrunkEffects(
  train: Proto[],
  resid: number[],
  keyOf: (p: Proto) => string,
  pseudo: number,
): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  train.forEach((p, i) => {
    const k = keyOf(p);
    const e = sums.get(k) ?? { s: 0, n: 0 };
    e.s += resid[i]!;
    e.n += 1;
    sums.set(k, e);
  });
  const out = new Map<string, number>();
  for (const [k, e] of sums) out.set(k, e.s / (e.n + pseudo));
  return out;
}

/**
 * Leave-one-out median |log| miss and walk-forward median |log| miss for a
 * term spec. Walk-forward fits on comps listed >= 900 days, tests the newer.
 * Category / family effects (when asked) are two-stage ridge on residuals.
 */
export function validateSpec(
  comps: Proto[],
  spec: Set<string>,
  medAgeDays: number,
  asOf: string,
  catPseudo: number,
  famPseudo: number,
): { loo: number; wf: number } {
  const n = comps.length;
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const feats = (p: Proto): number[] => {
    const x = sizeFeatures(p);
    if (spec.has('growth')) x.push(growthClamped(p));
    if (spec.has('age')) {
      const d = ageDays(p, asOf);
      x.push(Math.log(Math.max(d === null ? medAgeDays : d, 30) / 365.25));
    }
    if (spec.has('chains')) x.push(Math.log(Math.max(1, p.chains.length)));
    return x;
  };
  const predict = (train: Proto[], test: Proto[]): number[] => {
    const X = train.map((p) => feats(p));
    const yt = train.map((p) => Math.log(p.mcap_usd!));
    const beta = ridgeOls(X, yt, X[0]!.map(() => 0));
    let catEff = new Map<string, number>();
    let famEff = new Map<string, number>();
    if (catPseudo > 0 || famPseudo > 0) {
      const resid = train.map((p, i) => yt[i]! - dot(beta, X[i]!));
      if (catPseudo > 0) catEff = shrunkEffects(train, resid, (p) => p.category ?? '', catPseudo);
      if (famPseudo > 0) famEff = shrunkEffects(train, resid, (p) => nameStem(p.name), famPseudo);
    }
    return test.map((p) => {
      let v = dot(beta, feats(p));
      v += catEff.get(p.category ?? '') ?? 0;
      v += famEff.get(nameStem(p.name)) ?? 0;
      return v;
    });
  };
  // leave-one-out
  const looErrs: number[] = [];
  for (let i = 0; i < n; i++) {
    const train = comps.filter((_, j) => j !== i);
    const pr = predict(train, [comps[i]!])[0]!;
    looErrs.push(Math.abs(y[i]! - pr));
  }
  // walk-forward
  const old = comps.filter((p) => {
    const d = ageDays(p, asOf);
    return d !== null && d >= 900;
  });
  const nw = comps.filter((p) => {
    const d = ageDays(p, asOf);
    return d === null || d < 900;
  });
  const wfPreds = predict(old, nw);
  const wfErrs = nw.map((p, i) => Math.abs(Math.log(p.mcap_usd!) - wfPreds[i]!));
  return { loo: median(looErrs), wf: median(wfErrs) };
}

/** Control feature: another protocol's growth (same row index + 1, wrapped). */
export function controlGrowth(comps: Proto[], i: number): number {
  return growthClamped(comps[(i + 1) % comps.length]!);
}

/**
 * The full term table: every candidate term tested in BOTH protocols.
 * A term is kept only when it lowers the median miss in both. The control
 * (another protocol's growth) must not help — if it does, the validation
 * is broken.
 */
export function validateTerms(comps: Proto[], asOf: string): TermRow[] {
  const ages = comps.map((p) => ageDays(p, asOf)).filter((d): d is number => d !== null);
  const medAgeDays = median(ages);
  const specs: { name: string; spec: Set<string>; cat: number; fam: number }[] = [
    { name: 'Size curve (base)', spec: new Set(), cat: 0, fam: 0 },
    { name: '7-day growth', spec: new Set(['growth']), cat: 0, fam: 0 },
    { name: 'Age (log years listed)', spec: new Set(['age']), cat: 0, fam: 0 },
    { name: 'Chain count (log)', spec: new Set(['chains']), cat: 0, fam: 0 },
    { name: 'Growth + age + chains', spec: new Set(['growth', 'age', 'chains']), cat: 0, fam: 0 },
    { name: 'Category effect (ridge 64)', spec: new Set(), cat: 64, fam: 0 },
    { name: 'Family effect (ridge 16)', spec: new Set(), cat: 0, fam: 16 },
    { name: 'All terms + category', spec: new Set(['growth', 'age', 'chains']), cat: 64, fam: 0 },
  ];
  const base = validateSpec(comps, new Set(), medAgeDays, asOf, 0, 0);
  const rows: TermRow[] = [];
  for (const s of specs) {
    const r = validateSpec(comps, s.spec, medAgeDays, asOf, s.cat, s.fam);
    rows.push({
      name: s.name,
      looMiss: Math.exp(r.loo),
      wfMiss: Math.exp(r.wf),
      kept: r.loo < base.loo && r.wf < base.wf,
    });
  }
  // control: shifted growth as a feature (must not help)
  const n = comps.length;
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const looErrs: number[] = [];
  for (let i = 0; i < n; i++) {
    const train = comps.filter((_, j) => j !== i);
    const X = train.map((p) => {
      const j = comps.indexOf(p);
      return [1, Math.log(Math.max(1, p.tvl_usd)), controlGrowth(comps, j)];
    });
    const yt = train.map((p) => Math.log(p.mcap_usd!));
    const beta = ridgeOls(X, yt, [0, 0, 0]);
    const pr = beta[0]! + beta[1]! * Math.log(Math.max(1, comps[i]!.tvl_usd)) + beta[2]! * controlGrowth(comps, i);
    looErrs.push(Math.abs(y[i]! - pr));
  }
  const old = comps.filter((p) => {
    const d = ageDays(p, asOf);
    return d !== null && d >= 900;
  });
  const nw = comps.filter((p) => {
    const d = ageDays(p, asOf);
    return d === null || d < 900;
  });
  const Xo = old.map((p) => [1, Math.log(Math.max(1, p.tvl_usd)), controlGrowth(comps, comps.indexOf(p))]);
  const yo = old.map((p) => Math.log(p.mcap_usd!));
  const bo = ridgeOls(Xo, yo, [0, 0, 0]);
  const wfErrs = nw.map((p) => {
    const pr = bo[0]! + bo[1]! * Math.log(Math.max(1, p.tvl_usd)) + bo[2]! * controlGrowth(comps, comps.indexOf(p));
    return Math.abs(Math.log(p.mcap_usd!) - pr);
  });
  rows.push({
    name: 'Control: another protocol\u2019s growth (must not help)',
    looMiss: Math.exp(median(looErrs)),
    wfMiss: Math.exp(median(wfErrs)),
    kept: false,
  });
  return rows;
}

/** LOO residuals of the base size curve, for honest range quantiles. */
export function baseLooResiduals(comps: Proto[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const fit = fitSizeCurve(train);
    out.push(Math.log(comps[i]!.mcap_usd!) - sizePredict(fit, comps[i]!));
  }
  return out.sort((a, b) => a - b);
}

// ------------------------------------------------------------------ token odds

/** Sigmoid, clamped so no log-odds ever overflows. */
export function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

export interface OddsFit {
  beta: number[]; // [const, log age in years, log TVL centred, growth]
  medAgeDays: number;
  medLogTvl: number;
  baseRate: number;
  nPeers: number;
  nToken: number;
  buckets: { label: string; n: number; rate: number }[];
  looBrier: number;
  baseBrier: number;
  wfBrier: number;
  wfBaseBrier: number;
  wfRight: number; // share called right, walk-forward
}

/**
 * Feature vector for the odds logit: [1, log age in years, log TVL centred
 * on the peer median, clamped 7-day growth]. Null age falls back to the
 * peer median age — stated on the page wherever an odds is shown.
 */
export function oddsFeatures(p: Proto, medAgeDays: number, medLogTvl: number, asOf: string): number[] {
  const d = ageDays(p, asOf);
  const age = d === null ? medAgeDays : d;
  return [
    1,
    Math.log(Math.max(age, 30) / 365.25),
    Math.log(Math.max(1, p.tvl_usd)) - medLogTvl,
    growthClamped(p),
  ];
}

/** IRLS fit of a logistic regression (fixed iterations: deterministic). */
export function fitLogit(X: number[][], y: number[], iters: number): number[] {
  const k = X[0]!.length;
  const ones = y.reduce((s, v) => s + v, 0);
  const zeros = Math.max(1, y.length - ones);
  let beta = new Array<number>(k).fill(0);
  beta[0] = Math.log(Math.max(1e-6, ones) / zeros);
  for (let it = 0; it < iters; it++) {
    const W: number[] = [];
    const z: number[] = [];
    for (let r = 0; r < X.length; r++) {
      const pr = sigmoid(dot(beta, X[r]!));
      const w = Math.max(1e-6, pr * (1 - pr));
      W.push(w);
      z.push(dot(beta, X[r]!) + (y[r]! - pr) / w);
    }
    const A: number[][] = [];
    for (let i = 0; i < k; i++) {
      const row: number[] = [];
      for (let j = 0; j < k; j++) {
        let s = 0;
        for (let r = 0; r < X.length; r++) s += W[r]! * X[r]![i]! * X[r]![j]!;
        if (i === j) s += 1e-6;
        row.push(s);
      }
      A.push(row);
    }
    const b: number[] = [];
    for (let i = 0; i < k; i++) {
      let s = 0;
      for (let r = 0; r < X.length; r++) s += W[r]! * X[r]![i]! * z[r]!;
      b.push(s);
    }
    const next = solveLinear(A, b);
    let delta = 0;
    for (let i = 0; i < k; i++) delta = Math.max(delta, Math.abs(next[i]! - beta[i]!));
    beta = next;
    if (delta < 1e-8) break;
  }
  return beta;
}

/** Brier score: mean squared error of a probability against 0/1 outcomes. */
export function brierScore(preds: number[], ys: number[]): number {
  let s = 0;
  for (let i = 0; i < ys.length; i++) s += (preds[i]! - ys[i]!) * (preds[i]! - ys[i]!);
  return s / Math.max(1, ys.length);
}

// ------------------------------------------------------------------ odds fit

/** The peers: every protocol passing the eligibility rules, any token status. */
export function peersOf(snap: Snap): Proto[] {
  return snap.protocols.filter(isEligible);
}

/** Full odds fit with both validation protocols (LOO + walk-forward Brier). */
export function fitOdds(peers: Proto[], asOf: string): OddsFit {
  const ages = peers.map((p) => ageDays(p, asOf)).filter((d): d is number => d !== null);
  const medAgeDays = median(ages);
  const medLogTvl = median(peers.map((p) => Math.log(Math.max(1, p.tvl_usd))));
  const y = peers.map((p) => (p.gecko_id !== null || p.symbol !== null ? 1 : 0));
  const X = peers.map((p) => oddsFeatures(p, medAgeDays, medLogTvl, asOf));
  const beta = fitLogit(X, y, 60);
  const baseRate = y.reduce((s, v) => s + v, 0) / y.length;
  const buckets = [
    { label: '0–1 yr', lo: 0, hi: 365 },
    { label: '1–2 yr', lo: 365, hi: 730 },
    { label: '2–3 yr', lo: 730, hi: 1095 },
    { label: '3 yr +', lo: 1095, hi: Number.POSITIVE_INFINITY },
  ].map(({ label, lo, hi }) => {
    const sub = peers.filter((p) => {
      const d = ageDays(p, asOf);
      return d !== null && d >= lo && d < hi;
    });
    const t = sub.reduce((s, p) => s + (p.gecko_id !== null || p.symbol !== null ? 1 : 0), 0);
    return { label, n: sub.length, rate: sub.length > 0 ? t / sub.length : 0 };
  });
  const looPreds: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const bi = fitLogit(
      X.filter((_, j) => j !== i),
      y.filter((_, j) => j !== i),
      30,
    );
    looPreds.push(sigmoid(dot(bi, X[i]!)));
  }
  const looBrier = brierScore(looPreds, y);
  const baseBrier = brierScore(y.map(() => baseRate), y);
  const trIdx: number[] = [];
  const teIdx: number[] = [];
  peers.forEach((p, i) => {
    const d = ageDays(p, asOf);
    if (d !== null && d >= 900) trIdx.push(i);
    else if (d !== null) teIdx.push(i);
  });
  const bw = fitLogit(
    trIdx.map((i) => X[i]!),
    trIdx.map((i) => y[i]!),
    60,
  );
  const wfPreds = teIdx.map((i) => sigmoid(dot(bw, X[i]!)));
  const wfYs = teIdx.map((i) => y[i]!);
  const wfBase = trIdx.reduce((s, i) => s + y[i]!, 0) / Math.max(1, trIdx.length);
  const wfBrier = brierScore(wfPreds, wfYs);
  const wfBaseBrier = brierScore(wfYs.map(() => wfBase), wfYs);
  const wfRight =
    wfYs.filter((yy, i) => (wfPreds[i]! >= 0.5) === (yy === 1)).length / Math.max(1, wfYs.length);
  return {
    beta,
    medAgeDays,
    medLogTvl,
    baseRate,
    nPeers: peers.length,
    nToken: y.reduce((s, v) => s + v, 0),
    buckets,
    looBrier,
    baseBrier,
    wfBrier,
    wfBaseBrier,
    wfRight,
  };
}

/** Token odds for one protocol under a fitted odds model. */
export function tokenOdds(fit: OddsFit, p: Proto, asOf: string): number {
  return sigmoid(dot(fit.beta, oddsFeatures(p, fit.medAgeDays, fit.medLogTvl, asOf)));
}

// ------------------------------------------------------------------ farm economics

/** Gas per transaction by first chain (stated on the page, per chain). */
export function feePerTx(chain: string): number {
  switch (chain) {
    case 'Ethereum':
      return 8.0;
    case 'Solana':
      return 0.01;
    case 'Base':
    case 'Polygon':
      return 0.05;
    case 'Arbitrum':
    case 'Optimism':
      return 0.1;
    case 'BSC':
      return 0.15;
    case 'Avalanche':
      return 0.3;
    default:
      return 0.5;
  }
}

/** Deposit tier by TVL: >= $1B -> $10,000; $100M-$1B -> $5,000; else $1,000. */
export function depositTier(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 10000;
  if (tvlUsd >= 100_000_000) return 5000;
  return 1000;
}

/** Categories whose core action needs hands-on management (+0.5 h over 1.7 h). */
const ACTIVE_CATS = new Set(['Dexs', 'Yield', 'Derivatives', 'Options', 'Leveraged Farming', 'Prediction Market']);

/** Hands-on hours for one farm plan: 1.7 h baseline, +0.5 h for active categories. */
export function handsOnHours(p: Proto): number {
  return 1.7 + (ACTIVE_CATS.has(p.category ?? '') ? 0.5 : 0);
}

export interface Verdict {
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit: number;
  drop: number;
  fees: number;
  hours: number;
  timeCost: number;
  net: number;
  netHour: number;
  tbill: number;
}

/**
 * The farm verdict, netted to the dollar. Expected drop = implied value x
 * drop share x (deposit / TVL); fees are 6 transactions on the first chain.
 * Net is the cash left after gas. Your time is charged once, in the
 * net/hour test: net per hour must beat the $25/hour the same hours would
 * earn elsewhere (subtracting the time cost from net as well would charge
 * the hours twice). The cash benchmark is a 4% T-bill over the horizon.
 * FARM only when the net beats the T-bill return AND the net per hour beats
 * $25; MARGINAL when the net is positive but below either benchmark; SKIP
 * when the net is zero or negative. The time cost is printed as its own
 * line on the detail view, so nothing is hidden.
 */
export function farmVerdict(p: Proto, impliedUsd: number, dropShare = 0.07, horizonWeeks = 12): Verdict {
  const deposit = depositTier(p.tvl_usd);
  const drop = impliedUsd * dropShare * (deposit / Math.max(1, p.tvl_usd));
  const fees = 6 * feePerTx(p.chains[0] ?? '');
  const hours = handsOnHours(p);
  const timeCost = hours * 25;
  const net = drop - fees;
  const tbill = deposit * 0.04 * (horizonWeeks / 52);
  const netHour = net / hours;
  const verdict = net > tbill && netHour > 25 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { verdict, deposit, drop, fees, hours, timeCost, net, netHour, tbill };
}

// ------------------------------------------------------------------ farm steps

/** The category's core action, in the protocol's own terms. */
export function coreAction(p: Proto): string {
  switch (p.category) {
    case 'Dexs':
      return 'provide liquidity in the main pool, sized to the deposit tier, starting small then scaling';
    case 'Lending':
      return 'supply the deposit as collateral and borrow a small amount against it to show usage';
    case 'Liquid Staking':
      return 'stake the deposit through the protocol and hold the receipt token';
    case 'Yield':
      return 'deposit into the highest-TVL vault and enable auto-compounding';
    case 'Derivatives':
      return 'open a small hedged position and hold it through one funding cycle';
    case 'Bridge':
      return 'bridge the deposit through the protocol to its largest destination chain';
    case 'RWA':
      return 'subscribe to the tokenised asset offering with the deposit tier amount';
    case 'CDP':
      return 'mint the stable asset against the deposit as collateral';
    default:
      return 'use the protocol as intended with the deposit tier amount, starting small then scaling';
  }
}

/**
 * The 8-10 step farm plan for one protocol, generated from its own record
 * (category, chains, TVL tier, age). Every step carries its COST and TIME.
 * Steps stay inside the gate's 20-600 characters.
 */
export function farmSteps(p: Proto, v: Verdict): string[] {
  const name = p.name;
  const chain = p.chains[0] ?? 'its main chain';
  const chain2 = p.chains[1] ?? null;
  const dep = '$' + v.deposit.toLocaleString('en-US');
  const fee = feePerTx(chain);
  const steps: string[] = [
    `SETUP — make a fresh wallet for ${name} only and store its seed offline, never in a screenshot or chat. Cost: $0.00. Time: 0.25 h.`,
    `VERIFY — reach ${name} from its DefiLlama page and official accounts, and match the contract addresses against its docs before connecting. Cost: $0.00. Time: 0.25 h.`,
    `FUND — move ${dep} to ${chain} by the cheapest bridge or exchange route and confirm the balance on-chain. Cost: about $${fee.toFixed(2)} in gas. Time: 0.25 h.`,
    `RISK — read ${name}'s strategy and risk pages and name the specific risk: vault stacking, oracle reliance or an admin key. Cost: $0.00. Time: 0.25 h.`,
    `CORE — ${coreAction(p)}. Cost: about $${(fee * 2).toFixed(2)} in gas. Time: 0.25 h.`,
  ];
  if (chain2) {
    steps.push(
      `DEEPEN — repeat the core deployment on ${chain2}, the protocol's second chain, with a smaller second leg to show cross-chain use. Cost: about $${(feePerTx(chain2) * 2).toFixed(2)} in gas. Time: 0.25 h.`,
    );
  } else {
    steps.push(
      `DEEPEN — open a second leg on ${chain}: lend or add liquidity beside the core position so the activity reads as real use. Cost: about $${(fee * 2).toFixed(2)} in gas. Time: 0.25 h.`,
    );
  }
  steps.push(
    `CADENCE — do one qualifying action a week for 12 weeks: top up, claim rewards or vote, and log each one with its date. Cost: about $${(fee * 3).toFixed(2)} in gas. Time: 1.20 h.`,
    `WATCH — set the exit rule now: withdraw if ${name}'s TVL falls more than 17% from today or if withdrawals pause for a day. Cost: $0.00. Time: 0.10 h.`,
    `CLAIM — check ${name}'s own points or rewards page for any drop, claim only from the link it publishes, and never pay to claim. Cost: about $${fee.toFixed(2)} in gas. Time: 0.25 h.`,
    `RECORD — keep a farm log: wallet, dates, transaction hashes and dollar values, so the position is auditable later. Cost: $0.00. Time: 0.10 h.`,
  );
  return steps.map((s) => (s.length > 600 ? s.slice(0, 597) + '...' : s));
}

// ------------------------------------------------------------------ ledger

export interface LedgerGroup {
  key: string;
  label: string;
  n: number;
  reason: string;
}

/** Every protocol lands in exactly one group, counted from the snapshot. */
export function buildLedger(snap: Snap, rankedSlugs: Set<string>): LedgerGroup[] {
  const groups: LedgerGroup[] = [
    { key: 'watchlist', label: 'Ranked — watchlist', n: 0, reason: 'on the watchlist: TVL at or above the $50M floor, no token recorded' },
    { key: 'early', label: 'Ranked — early, below the floor', n: 0, reason: 'pre-token and eligible, TVL below the $50M floor' },
    { key: 'offlist', label: 'Ranked — off-list kin', n: 0, reason: 'pre-token and eligible, TVL at or above the floor, left off the watchlist' },
    { key: 'trades', label: 'Token trades (comps)', n: 0, reason: 'token trades with a usable market cap; priced as comps, never ranked' },
    { key: 'recorded', label: 'Token recorded, no usable cap', n: 0, reason: 'a token is on record but no market cap is usable' },
    { key: 'bridge', label: 'Out — bridge', n: 0, reason: 'a bridge moves value; it is not a launch of its own' },
    { key: 'staking', label: 'Out — liquid staking', n: 0, reason: 'a staking receipt, not a protocol awaiting a launch' },
    { key: 'exchange', label: 'Out — exchange', n: 0, reason: 'a centralised exchange, not a launch candidate' },
    { key: 'versioned', label: 'Out — versioned', n: 0, reason: 'a versioned product whose name ends in a version marker' },
    { key: 'wrapped', label: 'Out — wrapped / staked', n: 0, reason: 'a wrapped or staked product of a token that already trades' },
    { key: 'exnamed', label: 'Out — exchange-named', n: 0, reason: 'named after an exchange' },
    { key: 'other', label: 'Out — other', n: 0, reason: 'eligible by no rule above; counted so the ledger still sums' },
  ];
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const p of snap.protocols) {
    let key: string;
    if (snap.watchlist.includes(p.slug)) key = 'watchlist';
    else if (rankedSlugs.has(p.slug) && p.tvl_usd < snap.floor_usd) key = 'early';
    else if (rankedSlugs.has(p.slug)) key = 'offlist';
    else if (p.mcap_usd !== null && p.mcap_usd > 0) key = 'trades';
    else if (p.gecko_id !== null || p.symbol !== null) key = 'recorded';
    else if ((p.category ?? '') === 'Bridge' || (p.category ?? '') === 'Canonical Bridge') key = 'bridge';
    else if (['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category ?? '')) key = 'staking';
    else if ((p.category ?? '') === 'CEX') key = 'exchange';
    else if (VERSION_TAIL.test(p.name ?? '')) key = 'versioned';
    else if (WRAPPED_WORD.test(p.name ?? '')) key = 'wrapped';
    else if (EXCHANGES.some((e) => (p.name ?? '').startsWith(e))) key = 'exnamed';
    else key = 'other';
    byKey.get(key)!.n += 1;
  }
  return groups;
}

// ------------------------------------------------------------------ board

export interface PeerRow {
  slug: string;
  name: string;
  tvl: number;
  mcap: number;
  ratio: number;
  modelCap: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageDays: number | null;
  rank: number;
  rankLo: number;
  rankHi: number;
  kin: boolean;
  badges: string[];
  odds: number;
  valueIfLaunches: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  net: number;
  netHour: number;
  deposit: number;
  fees: number;
  hours: number;
  drop: number;
  tbill: number;
  steps: string[];
  peers: PeerRow[];
}

export interface LiveToken {
  slug: string;
  name: string;
  category: string | null;
  tvl: number;
  mcap: number;
  ratio: number;
  modelCap: number;
}

export interface BoardResult {
  rows: BoardRow[];
  liveTokens: LiveToken[];
  ledger: LedgerGroup[];
  fit: SizeFit;
  termRows: TermRow[];
  odds: OddsFit;
  rangeQ: { p25: number; p75: number; p10: number; p90: number; in2575: number; in1090: number };
  flatWfMiss: number;
  counts: { farm: number; marginal: number; skip: number };
  totalImplied: number;
  totalTvl: number;
}

/**
 * Build the whole board from the snapshot: fit, validate, price, rank,
 * bootstrap the rank and value ranges, verdict every row, account the ledger.
 */
export function buildBoard(snap: Snap): BoardResult {
  const asOf = snap.as_of;
  const comps = compsOf(snap);
  const fit = fitSizeCurve(comps);
  const termRows = validateTerms(comps, asOf);
  const resid = baseLooResiduals(comps);
  const rangeQ = {
    p25: quantile(resid, 0.25),
    p75: quantile(resid, 0.75),
    p10: quantile(resid, 0.1),
    p90: quantile(resid, 0.9),
    in2575: resid.filter((r) => r >= quantile(resid, 0.25) && r <= quantile(resid, 0.75)).length / resid.length,
    in1090: resid.filter((r) => r >= quantile(resid, 0.1) && r <= quantile(resid, 0.9)).length / resid.length,
  };
  // flat-multiple walk-forward miss, for the evidence table's baseline
  const nw = comps.filter((p) => {
    const d = ageDays(p, asOf);
    return d === null || d < 900;
  });
  const flatWfMiss = Math.exp(
    median(nw.map((p) => Math.abs(Math.log(p.mcap_usd!) - (Math.log(0.25) + Math.log(Math.max(1, p.tvl_usd)))))),
  );
  const peers = peersOf(snap);
  const odds = fitOdds(peers, asOf);
  const ranked = snap.protocols.filter(isRanked);
  const rankedSlugs = new Set(ranked.map((p) => p.slug));
  // kin: name stem matches a traded token's stem or symbol
  const tradedStems = new Set<string>();
  for (const p of comps) {
    tradedStems.add(nameStem(p.name));
    if (p.symbol) tradedStems.add(p.symbol.toLowerCase());
  }
  // LOO predictions for the comps (nearest-priced-peer tables, live-token view)
  const looPred = new Map<string, number>();
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    looPred.set(comps[i]!.slug, sizePredict(fitSizeCurve(train), comps[i]!));
  }
  const priced = ranked.map((p) => {
    const value = Math.exp(sizePredict(fit, p));
    const o = tokenOdds(odds, p, asOf);
    const implied = Math.max(1, Math.round(value * o));
    return { p, value, odds: o, implied, kin: tradedStems.has(nameStem(p.name)) };
  });
  priced.sort((a, b) => (b.implied - a.implied) || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // bootstrap rank + value ranges (200 refits, seeded: byte-identical every run)
  const rounds = 200;
  const rng = mulberry32(20261114);
  const rankHist = new Map<string, number[]>();
  const valHist = new Map<string, number[]>();
  for (const r of priced) {
    rankHist.set(r.p.slug, []);
    valHist.set(r.p.slug, []);
  }
  for (let k = 0; k < rounds; k++) {
    const sample: Proto[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const bf = fitSizeCurve(sample);
    const scored = priced.map((r) => ({ slug: r.p.slug, imp: Math.max(1, Math.round(Math.exp(sizePredict(bf, r.p)) * r.odds)) }));
    scored.sort((a, b) => (b.imp - a.imp) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    scored.forEach((s, i) => {
      rankHist.get(s.slug)!.push(i + 1);
      valHist.get(s.slug)!.push(s.imp);
    });
  }
  const rows: BoardRow[] = priced.map((r, i) => {
    const v = farmVerdict(r.p, r.implied);
    const steps = farmSteps(r.p, v);
    const rk = [...rankHist.get(r.p.slug)!].sort((a, b) => a - b);
    const vh = [...valHist.get(r.p.slug)!].sort((a, b) => a - b);
    const badges: string[] = [];
    if (snap.watchlist.includes(r.p.slug)) badges.push('Watchlist');
    else if (r.p.tvl_usd < snap.floor_usd) badges.push('Early');
    else badges.push('Off-list');
    if (r.kin) badges.push('Kin');
    const d = ageDays(r.p, asOf);
    // nearest priced peers: same category first, by |log TVL| distance
    const sameCat = comps
      .filter((c) => (c.category ?? '') === (r.p.category ?? ''))
      .map((c) => ({ c, dist: Math.abs(Math.log(c.tvl_usd) - Math.log(Math.max(1, r.p.tvl_usd))) }))
      .sort((a, b) => a.dist - b.dist);
    const others = comps
      .filter((c) => (c.category ?? '') !== (r.p.category ?? ''))
      .map((c) => ({ c, dist: Math.abs(Math.log(c.tvl_usd) - Math.log(Math.max(1, r.p.tvl_usd))) }))
      .sort((a, b) => a.dist - b.dist);
    const peers5 = [...sameCat, ...others].slice(0, 5).map(({ c }) => ({
      slug: c.slug,
      name: c.name,
      tvl: c.tvl_usd,
      mcap: c.mcap_usd!,
      ratio: c.mcap_usd! / Math.max(1, c.tvl_usd),
      modelCap: Math.round(Math.exp(looPred.get(c.slug)!)),
    }));
    return {
      slug: r.p.slug,
      name: r.p.name,
      category: r.p.category,
      chains: r.p.chains,
      tvl: r.p.tvl_usd,
      change7d: r.p.change_7d,
      ageDays: d,
      rank: i + 1,
      rankLo: quantile(rk, 0.1),
      rankHi: quantile(rk, 0.9),
      kin: r.kin,
      badges,
      odds: r.odds,
      valueIfLaunches: Math.round(r.value),
      implied: r.implied,
      p25: Math.max(1, Math.round(r.implied * Math.exp(rangeQ.p25))),
      p75: Math.max(1, Math.round(r.implied * Math.exp(rangeQ.p75))),
      p10: Math.max(1, Math.round(r.implied * Math.exp(rangeQ.p10))),
      p90: Math.max(1, Math.round(r.implied * Math.exp(rangeQ.p90))),
      verdict: v.verdict,
      net: Math.round(v.net),
      netHour: Math.round(v.netHour * 100) / 100,
      deposit: v.deposit,
      fees: Math.round(v.fees * 100) / 100,
      hours: v.hours,
      drop: Math.round(v.drop),
      tbill: Math.round(v.tbill),
      steps,
      peers: peers5,
    };
  });
  const liveTokens: LiveToken[] = comps
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      tvl: c.tvl_usd,
      mcap: c.mcap_usd!,
      ratio: c.mcap_usd! / Math.max(1, c.tvl_usd),
      modelCap: Math.round(Math.exp(looPred.get(c.slug)!)),
    }))
    .sort((a, b) => b.mcap - a.mcap);
  const ledger = buildLedger(snap, rankedSlugs);
  const counts = { farm: 0, marginal: 0, skip: 0 };
  for (const r of rows) {
    if (r.verdict === 'FARM') counts.farm += 1;
    else if (r.verdict === 'MARGINAL') counts.marginal += 1;
    else counts.skip += 1;
  }
  return {
    rows,
    liveTokens,
    ledger,
    fit,
    termRows,
    odds,
    rangeQ,
    flatWfMiss,
    counts,
    totalImplied: rows.reduce((s, r) => s + r.implied, 0),
    totalTvl: rows.reduce((s, r) => s + r.tvl, 0),
  };
}

