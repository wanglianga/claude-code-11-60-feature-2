// 条件化偏差分析的统计工具（纯函数、无 IO）。
// 设计原则：
//  - 所有区间都基于固定种子的确定性重采样，报告可复现、哈希稳定；
//  - 小样本不硬凑：分位/尾部/率差在支持不足时返回 null，由上层标注“不可判定”；
//  - 分布差异使用总变差距离（TVD），比卡方更直观且不依赖期望频数。

import { mulberry32, type Rng } from './prng';

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 样本标准差（n-1）；n<2 时返回 NaN */
export function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

export function meanLog(xs: number[]): number {
  return mean(xs.map((x) => Math.log(Math.max(x, 1e-6))));
}

export function sampleSdLog(xs: number[]): number {
  return sampleSd(xs.map((x) => Math.log(Math.max(x, 1e-6))));
}

/** 排序数组上的分位数（type-7，与常见统计软件一致） */
export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  return quantileSorted(values.slice().sort((a, b) => a - b), q);
}

export function binIndex(v: number, edges: number[]): number {
  if (v <= edges[0]) return 0;
  for (let i = 0; i < edges.length - 1; i++) {
    if (v < edges[i + 1]) return i;
  }
  return edges.length - 2;
}

export function histProportions(values: number[], edges: number[]): number[] {
  const counts = new Array(Math.max(1, edges.length - 1)).fill(0);
  for (const v of values) counts[binIndex(v, edges)]++;
  const total = values.length || 1;
  return counts.map((c) => c / total);
}

/** 总变差距离 TVD = 0.5 * Σ|p_i - q_i| ∈ [0,1] */
export function tvd(p: number[], q: number[]): number {
  const n = Math.max(p.length, q.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs((p[i] ?? 0) - (q[i] ?? 0));
  return s / 2;
}

/** Wilson 得分区间（比例） */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Newcombe 混合得分区间：两个独立比例的差（p1 - p2）的置信区间。
 * 对稀有事件/小样本比正态近似稳，且不依赖重采样。
 */
export function newcombeDiff(k1: number, n1: number, k2: number, n2: number, z = 1.96): [number, number] | null {
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  if (!w1 || !w2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const lo = (p1 - p2) - Math.sqrt((p1 - w1[0]) ** 2 + (w2[1] - p2) ** 2);
  const hi = (p1 - p2) + Math.sqrt((w1[1] - p1) ** 2 + (p2 - w2[0]) ** 2);
  return [lo, hi];
}

/** FNV-1a 32 位串哈希：用于把单元格键混入重采样种子 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function percentileCI(samples: number[], lo = 0.025, hi = 0.975): [number, number] | null {
  if (samples.length < 20) return null;
  const a = samples.slice().sort((x, y) => x - y);
  return [quantileSorted(a, lo), quantileSorted(a, hi)];
}

function resample(rng: Rng, arr: number[]): number[] {
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[Math.floor(rng() * arr.length)];
  return out;
}

export interface BootstrapOpts {
  reps: number;
  seed: number;
  quantiles: number[];
  edges: number[];
  /** 单元格键：混入种子，保证不同单元格独立但整体确定 */
  key?: string;
}

export interface QuantileCompare {
  q: number;
  source: number;
  synthetic: number;
  diff: number;
  ci: [number, number] | null;
}

export interface BootstrapResult {
  tvd: { value: number; ci: [number, number] | null };
  meanDiff: { value: number; ci: [number, number] | null };
  quantiles: QuantileCompare[];
}

/**
 * 对源/合成到达时长做确定性 bootstrap：
 *  - 同时给出 TVD 与各分位差（合成 - 源）的百分位置信区间；
 *  - 任一侧为空时返回 null/NaN，由上层标注不可判定。
 */
export function bootstrapCompare(src: number[], syn: number[], opts: BootstrapOpts): BootstrapResult {
  const srcSorted = src.slice().sort((a, b) => a - b);
  const synSorted = syn.slice().sort((a, b) => a - b);
  const base: BootstrapResult = {
    tvd: {
      value: src.length && syn.length ? tvd(histProportions(src, opts.edges), histProportions(syn, opts.edges)) : NaN,
      ci: null
    },
    meanDiff: {
      value: src.length && syn.length ? mean(syn) - mean(src) : NaN,
      ci: null
    },
    quantiles: opts.quantiles.map((q) => {
      const s = quantileSorted(srcSorted, q);
      const y = quantileSorted(synSorted, q);
      return { q, source: s, synthetic: y, diff: y - s, ci: null };
    })
  };
  const reps = Math.max(0, Math.floor(opts.reps));
  if (!src.length || !syn.length || reps < 20) return base;

  const seed = ((opts.seed >>> 0) ^ fnv1a(opts.key ?? 'cell')) >>> 0;
  const rng = mulberry32(seed);
  const tvdSamples: number[] = [];
  const meanSamples: number[] = [];
  const qSamples: number[][] = opts.quantiles.map(() => []);
  for (let b = 0; b < reps; b++) {
    const rs = resample(rng, src);
    const ry = resample(rng, syn);
    tvdSamples.push(tvd(histProportions(rs, opts.edges), histProportions(ry, opts.edges)));
    meanSamples.push(mean(ry) - mean(rs));
    const ss = rs.slice().sort((a, c) => a - c);
    const yy = ry.slice().sort((a, c) => a - c);
    for (let j = 0; j < opts.quantiles.length; j++) {
      qSamples[j].push(quantileSorted(yy, opts.quantiles[j]) - quantileSorted(ss, opts.quantiles[j]));
    }
  }
  base.tvd.ci = percentileCI(tvdSamples);
  base.meanDiff.ci = percentileCI(meanSamples);
  for (let j = 0; j < opts.quantiles.length; j++) {
    base.quantiles[j].ci = percentileCI(qSamples[j]);
  }
  return base;
}

/** 将比例差映射为百分点并保留 null（区间不可算时） */
export function pp(v: number): number {
  return v * 100;
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
