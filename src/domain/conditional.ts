// 条件化效用偏差分析（只读，不修改生成数据）。
//
// 背景：总体报警量与平均到场时间可能接近源样本，但按“严重度 × 所需资源类别 × 并发负荷”
// 交叉查看时，部分高负荷情形可能被明显压低。本模块以「同一来源修订 + 由其生成的运行包」
// 为比较对象，预先锁定：
//   ① 事件成熟口径（观察截止 = 该数据集最晚结案；结案未成熟/缺失的事件不计入及时响应口径）；
//   ② 分层条件（严重度、所需资源类别、并发负荷、严重度×资源类别、严重度×并发负荷）；
//   ③ 业务指标（首程到场时长的中位/尾部/分布距离、未及时响应率）。
// 两条路线在相同条件下评估源/合成的业务指标失真：
//   R1 独立分层：每个足量分层独立计算 TVD 与分位差，直观且不借用其他群体；交叉维度增多后小格稀疏。
//   R2 层级部分汇聚：以「资源类别」为组，在相关事件类型间做 DerSimonian-Laird 随机效应汇聚得到组先验，
//      再把每个单元格自身的对数均值差按方差向组先验收缩。降低稀疏格波动但依赖共享结构假设，
//      故同时输出收缩强度/tau² 敏感性区间与未汇聚原始支持度。
// 小格支持不足一律“不可判定”，绝不并入总体掩盖；版本不一致时拒绝比较。

import type { RuleSet, TableRows } from './types';
import { buildChains } from './stats';
import { hashObject } from './hash';
import { parseTs } from './time';
import {
  bootstrapCompare,
  fnv1a,
  mean,
  meanLog,
  newcombeDiff,
  sampleSdLog,
  wilsonInterval,
  type BootstrapResult
} from './conditionalStats';

// ---------- 配置（预先锁定，报告内回显） ----------

export type StratumDim = 'severity' | 'resourceNeed' | 'concurrency';

export interface MaturityRule {
  /** 成熟窗口（分钟） */
  windowMin: number;
  cutoffDefinition: string;
  requirement: string;
}

export interface ConcurrencyBucket { label: string; min: number; max: number; }

export interface AnalysisConfig {
  /** 未及时响应阈值（分钟）：首程到场时长 > 该值计为未及时响应 */
  arrivalLimitMin: number;
  maturityWindowMin: number;
  /** 单格最小支持（源 / 合成），低于即“不可判定” */
  minSourceN: number;
  minSynN: number;
  /** 分位差 / TVD 区间的最小支持（两侧均需达到） */
  minQuantileN: number;
  bootReps: number;
  bootSeed: number;
  quantiles: number[];
  histEdges: number[];
  /** 并发负荷分桶（由源样本分布预先锁定，见 deriveConcurrencyBuckets） */
  concurrencyBuckets: ConcurrencyBucket[];
  oneDim: StratumDim[];
  crossDims: [StratumDim, StratumDim][];
  /** R2 敏感性：tau² 乘数 */
  tauMultipliers: number[];
}

export const DEFAULT_MATURITY_WINDOW_MIN = 480;

export const BASE_ANALYSIS_CONFIG = {
  arrivalLimitMin: 15,
  minSourceN: 8,
  minSynN: 8,
  minQuantileN: 15,
  bootReps: 600,
  bootSeed: 20251120,
  quantiles: [0.5, 0.9, 0.95],
  histEdges: [0, 3, 6, 10, 15, 22, 32, 45, 60, 90, 120, 180, 400],
  oneDim: ['severity', 'resourceNeed', 'concurrency'] as StratumDim[],
  crossDims: [['severity', 'resourceNeed'], ['severity', 'concurrency']] as [StratumDim, StratumDim][],
  tauMultipliers: [0.5, 1, 2]
};

/**
 * 并发负荷分桶：只用源样本“同刻在处置任务数”的取值分布预先锁定，避免用合成数据反推阈值。
 *  - 取值唯一数 ≤ 1：单层（源样本无并发变化，报告内明确标注并发维度不可分层）；
 *  - 唯一数 = 2：0 / ≥1 两层；
 *  - 唯一数 ≥ 3：在最低两个可区分的正取值处切成 3 层，其余归入“高”。
 * 这样即使源样本负荷很低，也仍能对“有/无并发”给出可判定的条件差异。
 */
export function deriveConcurrencyBuckets(sourceDemand: number[]): ConcurrencyBucket[] {
  const uniq = [...new Set(sourceDemand)].sort((a, b) => a - b);
  if (uniq.length <= 1) {
    return [{ label: '全部(源样本无并发变化)', min: 0, max: Number.MAX_SAFE_INTEGER }];
  }
  if (uniq.length === 2) {
    const cut = uniq[0];
    return [
      { label: rangeLabel(0, cut), min: 0, max: cut },
      { label: rangeLabel(cut + 1, Number.MAX_SAFE_INTEGER), min: cut + 1, max: Number.MAX_SAFE_INTEGER }
    ];
  }
  const cuts = uniq.slice(0, 2);
  return [
    { label: rangeLabel(0, cuts[0]), min: 0, max: cuts[0] },
    { label: rangeLabel(cuts[0] + 1, cuts[1]), min: cuts[0] + 1, max: cuts[1] },
    { label: rangeLabel(cuts[1] + 1, Number.MAX_SAFE_INTEGER), min: cuts[1] + 1, max: Number.MAX_SAFE_INTEGER }
  ];
}

function rangeLabel(lo: number, hi: number): string {
  const n = (v: number) => (v === 0 ? '0 辆' : `${v} 辆`);
  if (lo === 0) return hi === Number.MAX_SAFE_INTEGER ? '≥0 辆' : `≤${n(hi)}`;
  if (hi === Number.MAX_SAFE_INTEGER) return `≥${n(lo)}`;
  return lo === hi ? n(lo) : `${lo}–${hi} 辆`;
}

export const DIM_LABELS: Record<StratumDim, string> = {
  severity: '严重度（优先级）',
  resourceNeed: '所需资源类别',
  concurrency: '并发负荷（同刻同时需求车辆数）'
};

/** 由源样本的并发需求分位锁定分桶，得到完整配置（供 UI 预览与测试使用） */
export function defaultAnalysisConfig(ruleSet: RuleSet, sourceDemand: number[]): AnalysisConfig {
  return {
    ...BASE_ANALYSIS_CONFIG,
    maturityWindowMin: Math.max(DEFAULT_MATURITY_WINDOW_MIN, ruleSet.bounds.totalMaxMin),
    concurrencyBuckets: deriveConcurrencyBuckets(sourceDemand)
  };
}

// ---------- 输出类型 ----------

export interface DistRow {
  q: number;
  source: number;
  synthetic: number;
  diff: number;
  ci: [number, number] | null;
}

export interface DistCompare {
  tvd: number;
  tvdCi: [number, number] | null;
  meanSource: number;
  meanSynthetic: number;
  meanDiff: number;
  meanDiffCi: [number, number] | null;
  quantiles: DistRow[];
}

export interface RateCompare {
  sourceK: number;
  sourceN: number;
  sourceRate: number | null;
  sourceCi: [number, number] | null;
  synK: number;
  synN: number;
  synRate: number | null;
  synCi: [number, number] | null;
  diff: number | null;
  diffCi: [number, number] | null;
}

export interface HierRow {
  eventType: string;
  sourceN: number;
  synN: number;
  rawDiffLog: number | null;
  rawPct: number | null;
  pooledDiffLog: number | null;
  pooledPct: number | null;
  pooledRangeLog: [number, number] | null;
  pooledRangePct: [number, number] | null;
  pooledInGroup: boolean;
}

export interface CellSupport {
  sourceTotal: number;
  sourceMature: number;
  sourceUsable: number;
  sourceExcludedImmature: number;
  sourceExcludedOpen: number;
  sourceMissingArrival: number;
  synTotal: number;
  synMature: number;
  synUsable: number;
  synExcludedImmature: number;
  synExcludedOpen: number;
  synMissingArrival: number;
}

export type CellStatus = 'ok' | 'sparse' | 'indeterminate' | 'missing';

export interface CellResult {
  key: string;
  dims: Partial<Record<StratumDim, string>>;
  support: CellSupport;
  status: CellStatus;
  /** 阻塞性原因：支持不足/区间不可得等，无法稳定估计 */
  indeterminateReasons: string[];
  /** 信息性备注：成熟口径排除数等，不阻塞估计 */
  notes: string[];
  /** R1 独立分层 */
  dist: DistCompare | null;
  late: RateCompare | null;
  /**
   * R2 层级部分汇聚：
   *  - pct/rangePct：本格对数均值差向组先验收缩后的偏差及敏感性范围
   *  - prior：组先验（相关事件类型汇聚）
   *  - shrinkage：本格向先验收缩的比例（0=完全独立，1=完全借用组信息）
   */
  pooled: {
    pct: number | null;
    rangePct: [number, number] | null;
    direction: 'up' | 'down' | 'flat' | 'unknown';
    typesInCell: number;
    supportedTypes: number;
    /** 本格实际借用到的“可共享组”类型数；0 表示 R2 无可共享信息（退化为原始估计） */
    borrowedTypes: number;
    priorLog: number | null;
    shrinkage: number | null;
    tau2: number;
  } | null;
  hierarchical: HierRow[];
  routeAgreement: 'agree' | 'disagree' | 'insufficient' | 'none';
  routeAgreementNote: string;
}

export interface StratumTable {
  key: string;
  label: string;
  dims: StratumDim[];
  cells: CellResult[];
  counts: { ok: number; sparse: number; indeterminate: number; missing: number };
}

export interface Comparability {
  ok: boolean;
  blocked: boolean;
  reasons: string[];
  batchKeyMatch: boolean;
  eventDefinition: { source: string[]; synthetic: string[]; unseenInSynthetic: string[]; extraInSynthetic: string[]; ok: boolean };
  geoBoundary: { source: string[]; synthetic: string[]; unseenInSynthetic: string[]; extraInSynthetic: string[]; ok: boolean };
  /** 分析时该批次是否已有更新修订（信息性，不阻断；比较仍固定在运行启动快照） */
  laterRevision?: { used: number; latest: number } | null;
  /** 运行记录中的批次文件哈希与当前登记哈希是否一致（完整性守卫） */
  fileHashesMatch: boolean;
}

export interface CoverageSummary {
  total: number;
  mature: number;
  usable: number;
  excludedImmature: number;
  excludedOpen: number;
  missingArrival: number;
}

export interface HierGroupOut {
  resourceNeed: string;
  types: HierRow[];
  pooledMeanLog: number | null;
  tau2: number;
  /** 组内可参与汇聚的事件类型数；=1 时 R2 退化为原始估计（无可共享信息） */
  validTypes: number;
  /** 敏感性：不同 tau² 乘数下各类型汇聚结果 */
  sensitivity: { multiplier: number; pooledPctByType: Record<string, number | null> }[];
}

export interface ConditionalReportBody {
  overall: 'OK' | 'WARN' | 'ATTENTION' | 'BLOCKED';
  comparability: Comparability;
  locked: {
    maturity: MaturityRule;
    config: AnalysisConfig;
    cutoffs: { source: string | null; synthetic: string | null };
    sourceBatchKey: string;
    synthRunId: string;
    synthBatchKey: string;
    configFingerprint: string;
  };
  coverage: { source: CoverageSummary; synthetic: CoverageSummary };
  tables: StratumTable[];
  hierarchical: { groups: HierGroupOut[] };
  /** 无法稳定估计的范围（逐格逐项，只含阻塞性原因） */
  undetermined: string[];
  summary: {
    okCells: number;
    sparseCells: number;
    indeterminateCells: number;
    missingCells: number;
    routeDisagreements: number;
    /** 高负荷（P1 / 并发=高）显著被压低的格 */
    suppressedHighLoad: string[];
    /** 高负荷条件下“不可判定/仅 R2 参考”的格——不能据此断言压力下仍有余量 */
    undecidableHighLoad: string[];
  };
  disclaimer: string;
}

export interface ConditionalReport extends ConditionalReportBody {
  id: string;
  runId: string;
  createdAt: string;
  hash: string;
}

// ---------- 事件观测构建 ----------

export interface EventObs {
  eventId: string;
  eventType: string;
  district: string;
  priority: string;
  resourceNeed: string;
  alarmMs: number;
  firstDispatchMs: number | null;
  firstArriveMs: number | null;
  arrivalMin: number | null;
  closeMs: number | null;
  mature: boolean;
  excludeReason: 'none' | 'immature-window' | 'open' | 'close-before-arrival';
  /** 报警时刻的同刻并发需求（其他事件占用车辆 + 已报警未派遣） */
  demand: number;
}

export interface DatasetAgg {
  obs: EventObs[];
  cutoffMs: number;
  coverage: CoverageSummary;
}

function primaryCapability(ruleSet: RuleSet, eventType: string): string {
  const need = ruleSet.capabilityMap[eventType];
  if (!need || need.length === 0) return '未知';
  return need[0];
}

/**
 * 同刻并发需求（“同时待派车辆数”的近似）：
 * 对每个事件的报警时刻 t，统计
 *   (a) 其他事件在该时刻仍占用的车辆数（占用区间 = [派遣, 到场+周转]，按绝对毫秒，跨午夜安全）；
 *   (b) 其他事件已报警但尚未首程派遣的数量（即正在等待派车）。
 * 两者相加作为该事件发生时的并发负荷。
 */
export function computeDemand(rows: TableRows, turnoverMin: number): Map<string, number> {
  const arrByDispatch = new Map(rows.arrivals.map((a) => [a.dispatch_id, a]));
  // 每辆车的占用区间（同一车辆区间互不重叠）
  const byRes = new Map<string, { start: number; end: number; eventId: string }[]>();
  const firstDispatch = new Map<string, number>();
  for (const d of rows.dispatches) {
    const start = parseTs(d.dispatch_time);
    const arr = arrByDispatch.get(d.dispatch_id);
    const end = (arr ? parseTs(arr.arrive_time) : start) + turnoverMin * 60000;
    const list = byRes.get(d.resource_id) ?? [];
    list.push({ start, end, eventId: d.event_id });
    byRes.set(d.resource_id, list);
    const prev = firstDispatch.get(d.event_id);
    if (prev == null || start < prev) firstDispatch.set(d.event_id, start);
  }
  const alarms = rows.events
    .map((e) => ({ eventId: e.event_id, t: parseTs(e.alarm_time) }))
    .sort((a, b) => a.t - b.t);
  // 所有占用区间按起点排序，用于扫描线
  const allIv = [...byRes.values()].flat().sort((a, b) => a.start - b.start);
  // 首程派遣时刻按升序，用于“等待派车”前缀计数
  const dispatchTimes = [...firstDispatch.values()].sort((a, b) => a - b);

  const countLE = (sorted: number[], t: number) => {
    // 第一个 > t 的位置
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const out = new Map<string, number>();
  const active: { end: number; eventId: string }[] = [];
  const alarmTimes = alarms.map((a) => a.t);
  let p = 0;
  for (const e of alarms) {
    const t = e.t;
    while (p < allIv.length && allIv[p].start <= t) {
      active.push({ end: allIv[p].end, eventId: allIv[p].eventId });
      p++;
    }
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= t) active.splice(i, 1);
    // 占用车辆数：排除本事件自身占用的那一辆（若此刻正在占用）
    const selfBusy = active.some((iv) => iv.eventId === e.eventId);
    const occupied = Math.max(0, active.length - (selfBusy ? 1 : 0));
    // 已报警但尚未首程派遣的“其他”事件
    const arrivedTotal = countLE(alarmTimes, t);
    const dispatched = countLE(dispatchTimes, t);
    const fd = firstDispatch.get(e.eventId);
    const selfUndispatched = !(fd != null && fd <= t);
    const awaitingOthers = Math.max(0, arrivedTotal - dispatched - (selfUndispatched ? 1 : 0));
    out.set(e.eventId, occupied + awaitingOthers);
  }
  return out;
}

export function buildDataset(rows: TableRows, ruleSet: RuleSet, maturity: MaturityRule): DatasetAgg {
  const chains = buildChains(rows);
  const demand = computeDemand(rows, ruleSet.bounds.turnoverMin);

  let cutoff = 0;
  for (const c of chains) if (c.closeMs != null) cutoff = Math.max(cutoff, c.closeMs);
  if (cutoff === 0) for (const c of chains) cutoff = Math.max(cutoff, c.alarmMs);

  const obs: EventObs[] = chains.map((c) => {
    const firstArrive = c.legs.reduce<number | null>((acc, l) => {
      if (l.arriveMs == null) return acc;
      return acc == null ? l.arriveMs : Math.min(acc, l.arriveMs);
    }, null);
    const firstDispatch = c.legs.length ? Math.min(...c.legs.map((l) => l.dispatchMs)) : null;
    const hasClosure = c.closeMs != null;
    const closeValid = hasClosure && (firstArrive == null || (c.closeMs as number) >= firstArrive);
    let mature = true;
    let excludeReason: EventObs['excludeReason'] = 'none';
    if (!hasClosure) { mature = false; excludeReason = 'open'; }
    else if (!closeValid) { mature = false; excludeReason = 'close-before-arrival'; }
    else if (c.alarmMs > cutoff - maturity.windowMin * 60000) { mature = false; excludeReason = 'immature-window'; }
    const arrivalMin = firstArrive != null ? (firstArrive - c.alarmMs) / 60000 : null;
    return {
      eventId: c.eventId,
      eventType: c.event_type,
      district: c.district,
      priority: c.priority,
      resourceNeed: primaryCapability(ruleSet, c.event_type),
      alarmMs: c.alarmMs,
      firstDispatchMs: firstDispatch,
      firstArriveMs: firstArrive,
      arrivalMin: arrivalMin != null && arrivalMin >= 0 ? arrivalMin : null,
      closeMs: c.closeMs,
      mature,
      excludeReason,
      demand: demand.get(c.eventId) ?? 0
    };
  });

  const usable = (o: EventObs) => o.mature && o.arrivalMin != null;
  const coverage: CoverageSummary = {
    total: obs.length,
    mature: obs.filter((o) => o.mature).length,
    usable: obs.filter(usable).length,
    excludedImmature: obs.filter((o) => o.excludeReason === 'immature-window').length,
    excludedOpen: obs.filter((o) => o.excludeReason === 'open' || o.excludeReason === 'close-before-arrival').length,
    missingArrival: obs.filter((o) => o.mature && o.arrivalMin == null).length
  };
  return { obs, cutoffMs: cutoff, coverage };
}

function usableValues(obs: EventObs[]): number[] {
  const out: number[] = [];
  for (const o of obs) if (o.mature && o.arrivalMin != null) out.push(o.arrivalMin);
  return out;
}

// ---------- 层级部分汇聚（DerSimonian-Laird） ----------

export interface TypeEffect {
  eventType: string;
  sourceN: number;
  synN: number;
  d: number;
  v: number;
  /** 每个观测的对数尺度合并方差（用于小格的方差建模） */
  varLog: number;
  valid: boolean;
}

export function typeEffects(src: EventObs[], syn: EventObs[]): TypeEffect[] {
  const types = new Set([...src.map((o) => o.eventType), ...syn.map((o) => o.eventType)]);
  const out: TypeEffect[] = [];
  for (const t of types) {
    const sv = usableValues(src.filter((o) => o.eventType === t));
    const yv = usableValues(syn.filter((o) => o.eventType === t));
    const valid = sv.length >= 3 && yv.length >= 3;
    let d = NaN;
    let v = NaN;
    let varLog = NaN;
    if (valid) {
      d = meanLog(yv) - meanLog(sv);
      const vs = sampleSdLog(sv) ** 2;
      const vy = sampleSdLog(yv) ** 2;
      v = vs / sv.length + vy / yv.length;
      if (!Number.isFinite(v) || v <= 0) v = 1e-6;
      varLog = ((sv.length - 1) * vs + (yv.length - 1) * vy) / Math.max(1, sv.length + yv.length - 2);
      if (!Number.isFinite(varLog) || varLog <= 0) varLog = 0.05;
    }
    out.push({ eventType: t, sourceN: sv.length, synN: yv.length, d, v, varLog, valid });
  }
  return out.sort((a, b) => a.eventType.localeCompare(b.eventType));
}

export interface PooledGroup {
  resourceNeed: string;
  types: TypeEffect[];
  mu: number | null;
  tau2: number;
  /** 组内合并的每观测对数方差；无有效类型时为 null */
  sigma2: number | null;
}

export function poolGroup(resourceNeed: string, types: TypeEffect[]): PooledGroup {
  const valid = types.filter((t) => t.valid);
  if (valid.length === 0) return { resourceNeed, types, mu: null, tau2: 0, sigma2: null };
  const w = valid.map((t) => 1 / t.v);
  const sw = w.reduce((a, b) => a + b, 0);
  const mu = valid.reduce((a, t, i) => a + w[i] * t.d, 0) / sw;
  let Q = 0;
  valid.forEach((t, i) => { Q += w[i] * (t.d - mu) ** 2; });
  const df = valid.length - 1;
  const sw2 = w.reduce((a, b) => a + b * b, 0);
  const C = sw - sw2 / sw;
  const tau2 = df > 0 && C > 0 ? Math.max(0, (Q - df) / C) : 0;
  const nW = valid.reduce((a, t) => a + t.sourceN + t.synN, 0);
  const sigma2 = valid.reduce((a, t) => a + t.varLog * (t.sourceN + t.synN), 0) / Math.max(1, nW);
  return { resourceNeed, types, mu, tau2, sigma2 };
}

export function pooledAtTau(d: number, v: number, mu: number, tau2: number): number {
  const wi = 1 / v;
  return tau2 > 0 ? (d / v + mu / tau2) / (wi + 1 / tau2) : mu;
}

/** 收缩权重：0 表示完全独立（原始），1 表示完全借用组先验 */
function shrinkageOf(v: number, tau2: number): number {
  if (tau2 <= 0) return 1;
  const wi = 1 / v;
  return (1 / tau2) / (wi + 1 / tau2);
}

interface PooledTypeRef { group: PooledGroup; te: TypeEffect }

// ---------- 单元格计算 ----------

function supportOf(src: EventObs[], syn: EventObs[]): CellSupport {
  const usable = (o: EventObs) => o.mature && o.arrivalMin != null;
  return {
    sourceTotal: src.length,
    sourceMature: src.filter((o) => o.mature).length,
    sourceUsable: src.filter(usable).length,
    sourceExcludedImmature: src.filter((o) => o.excludeReason === 'immature-window').length,
    sourceExcludedOpen: src.filter((o) => o.excludeReason === 'open' || o.excludeReason === 'close-before-arrival').length,
    sourceMissingArrival: src.filter((o) => o.mature && o.arrivalMin == null).length,
    synTotal: syn.length,
    synMature: syn.filter((o) => o.mature).length,
    synUsable: syn.filter(usable).length,
    synExcludedImmature: syn.filter((o) => o.excludeReason === 'immature-window').length,
    synExcludedOpen: syn.filter((o) => o.excludeReason === 'open' || o.excludeReason === 'close-before-arrival').length,
    synMissingArrival: syn.filter((o) => o.mature && o.arrivalMin == null).length
  };
}

function pctOf(logDiff: number | null): number | null {
  if (logDiff == null || !Number.isFinite(logDiff)) return null;
  return (Math.exp(logDiff) - 1) * 100;
}

function directionOf(pct: number | null, range: [number, number] | null): 'up' | 'down' | 'flat' | 'unknown' {
  if (pct == null) return 'unknown';
  if (range && range[0] <= 0 && range[1] >= 0) return 'flat';
  if (Math.abs(pct) < 3) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

function buildCell(
  key: string,
  dims: Partial<Record<StratumDim, string>>,
  src: EventObs[],
  syn: EventObs[],
  cfg: AnalysisConfig,
  pooledByType: Map<string, PooledTypeRef>
): CellResult {
  const support = supportOf(src, syn);
  const reasons: string[] = [];
  const notes: string[] = [];
  const sv = usableValues(src);
  const yv = usableValues(syn);
  const enough = sv.length >= cfg.minSourceN && yv.length >= cfg.minSynN;
  const anyPresent = src.length > 0 || syn.length > 0;

  if (sv.length < cfg.minSourceN) reasons.push(`源可用成熟支持 ${sv.length} < 最小 ${cfg.minSourceN}`);
  if (yv.length < cfg.minSynN) reasons.push(`合成可用成熟支持 ${yv.length} < 最小 ${cfg.minSynN}`);
  if (support.sourceExcludedImmature > 0) notes.push(`源有 ${support.sourceExcludedImmature} 条结案未成熟被排除`);
  if (support.synExcludedImmature > 0) notes.push(`合成有 ${support.synExcludedImmature} 条结案未成熟被排除`);
  if (support.sourceExcludedOpen > 0) notes.push(`源有 ${support.sourceExcludedOpen} 条无有效结案被排除`);
  if (support.synExcludedOpen > 0) notes.push(`合成有 ${support.synExcludedOpen} 条无有效结案被排除`);
  if (support.sourceMissingArrival > 0) notes.push(`源有 ${support.sourceMissingArrival} 条成熟事件缺到场记录，未计入及时响应口径`);
  if (support.synMissingArrival > 0) notes.push(`合成有 ${support.synMissingArrival} 条成熟事件缺到场记录，未计入及时响应口径`);

  // ---- R1 独立分层 ----
  let dist: DistCompare | null = null;
  let late: RateCompare | null = null;
  if (sv.length > 0 && yv.length > 0) {
    const boot: BootstrapResult = bootstrapCompare(sv, yv, {
      reps: cfg.bootReps, seed: cfg.bootSeed, quantiles: cfg.quantiles, edges: cfg.histEdges, key
    });
    dist = {
      tvd: boot.tvd.value,
      tvdCi: boot.tvd.ci,
      meanSource: mean(sv),
      meanSynthetic: mean(yv),
      meanDiff: boot.meanDiff.value,
      meanDiffCi: boot.meanDiff.ci,
      quantiles: boot.quantiles.map((q) => ({ q: q.q, source: q.source, synthetic: q.synthetic, diff: q.diff, ci: q.ci }))
    };
    const sK = sv.filter((v) => v > cfg.arrivalLimitMin).length;
    const yK = yv.filter((v) => v > cfg.arrivalLimitMin).length;
    late = {
      sourceK: sK, sourceN: sv.length, sourceRate: sK / sv.length, sourceCi: wilsonInterval(sK, sv.length),
      synK: yK, synN: yv.length, synRate: yK / yv.length, synCi: wilsonInterval(yK, yv.length),
      diff: yK / yv.length - sK / sv.length,
      diffCi: newcombeDiff(sK, sv.length, yK, yv.length)
    };
    if (sv.length < cfg.minQuantileN || yv.length < cfg.minQuantileN) {
      if (dist.tvdCi == null) reasons.push(`分布距离区间不可稳定估计（支持 < ${cfg.minQuantileN}）`);
      for (const q of dist.quantiles) {
        if (q.ci == null) reasons.push(`分位 p${Math.round(q.q * 100)} 差区间不可稳定估计（支持 < ${cfg.minQuantileN}）`);
      }
    }
    if (late.diffCi == null) reasons.push('未及时响应率差的区间不可得（样本不足）');
  } else {
    if (sv.length === 0) reasons.push('源在该群体无可用成熟样本');
    if (yv.length === 0) reasons.push('合成在该群体无可用成熟样本');
  }

  // ---- 本格各事件类型的可用计数（作权重与先验） ----
  const typeWeight = new Map<string, number>();
  for (const o of src) if (o.mature && o.arrivalMin != null) typeWeight.set(o.eventType, (typeWeight.get(o.eventType) ?? 0) + 1);
  for (const o of syn) if (o.mature && o.arrivalMin != null) typeWeight.set(o.eventType, (typeWeight.get(o.eventType) ?? 0) + 1);
  const cellTypes = [...typeWeight.keys()].sort();
  const hierarchical: HierRow[] = [];
  let priorLog: number | null = null;
  let tau2Cell = 0;
  let supportedTypes = 0;
  let priorW = 0;
  let priorSum = 0;
  const groupsTouched = new Set<PooledGroup>();
  for (const t of cellTypes) {
    const ref = pooledByType.get(t);
    const w = typeWeight.get(t) ?? 0;
    if (!ref) {
      hierarchical.push({ eventType: t, sourceN: 0, synN: 0, rawDiffLog: null, rawPct: null, pooledDiffLog: null, pooledPct: null, pooledRangeLog: null, pooledRangePct: null, pooledInGroup: false });
      continue;
    }
    const { group, te } = ref;
    const vals = group.mu != null ? cfg.tauMultipliers.map((m) => pooledAtTau(te.d, te.v, group.mu as number, group.tau2 * m)) : [];
    const rangeLog: [number, number] | null = vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
    const pooledBase = group.mu != null ? pooledAtTau(te.d, te.v, group.mu, group.tau2) : null;
    hierarchical.push({
      eventType: t,
      sourceN: te.sourceN,
      synN: te.synN,
      rawDiffLog: te.d,
      rawPct: pctOf(te.d),
      pooledDiffLog: pooledBase,
      pooledPct: pctOf(pooledBase),
      pooledRangeLog: rangeLog,
      pooledRangePct: rangeLog ? [pctOf(rangeLog[0]) as number, pctOf(rangeLog[1]) as number] : null,
      pooledInGroup: true
    });
    groupsTouched.add(group);
    if (group.mu != null && w > 0) {
      supportedTypes++;
      priorSum += group.mu * w;
      priorW += w;
      tau2Cell += group.tau2 * w;
    }
  }
  if (priorW > 0) { priorLog = priorSum / priorW; tau2Cell /= priorW; }
  // 真正“借用”到的相关类型数：这些组里存在、但不是本格成分的事件类型
  let borrowedTypes = 0;
  const cellTypeSet = new Set(cellTypes);
  for (const g of groupsTouched) {
    for (const te of g.types) if (te.valid && !cellTypeSet.has(te.eventType)) borrowedTypes++;
  }

  // 本格自身的对数均值差与方差（用于向组先验收缩）。
  // 小格（n<2）无法估计方差时，用所借用组的每观测合并方差 σ² 与“等效最小样本”建模，
  // 使估计强烈收缩到组先验——这正是 R2 对稀疏格的价值所在。
  const cellD = sv.length >= 2 && yv.length >= 2 ? meanLog(yv) - meanLog(sv) : null;
  let cellV: number | null = null;
  if (sv.length >= 2 && yv.length >= 2) {
    cellV = sampleSdLog(sv) ** 2 / sv.length + sampleSdLog(yv) ** 2 / yv.length;
  } else if (priorW > 0) {
    // 用组内合并方差估计：方差 ≈ σ² · (1/n_src + 1/n_syn)，n 下限取 1 以避免无穷大
    const sigma2 = [...groupsTouched]
      .filter((g) => g.sigma2 != null)
      .reduce((a, g) => a + (g.sigma2 as number), 0) / Math.max(1, [...groupsTouched].filter((g) => g.sigma2 != null).length);
    const ns = Math.max(1, sv.length);
    const ny = Math.max(1, yv.length);
    if (Number.isFinite(sigma2)) cellV = sigma2 * (1 / ns + 1 / ny);
  }
  let pooled: CellResult['pooled'] = null;
  if ((src.length > 0 || syn.length > 0) && cellTypes.length > 0) {
    let pooledPct: number | null = null;
    let rangePct: [number, number] | null = null;
    let shrink: number | null = null;
    const dForCell = cellD ?? (priorLog != null ? priorLog : null);
    if (dForCell != null && cellV != null && priorLog != null) {
      const vv = Math.max(cellV, 1e-6);
      const base = pooledAtTau(dForCell, vv, priorLog, tau2Cell);
      pooledPct = pctOf(base);
      shrink = shrinkageOf(vv, tau2Cell);
      // 敏感性：原始（不汇聚）→ 完全汇聚，以及 τ² 乘数
      const rawPct = cellD != null ? pctOf(cellD) : null;
      const candidates: number[] = [pctOf(base) as number];
      if (rawPct != null) {
        candidates.push(rawPct);
        candidates.push((rawPct + (pctOf(base) as number)) / 2);
      } else {
        candidates.push(pctOf(priorLog * 0.5) as number, pctOf(priorLog) as number);
      }
      for (const m of cfg.tauMultipliers) {
        candidates.push(pctOf(pooledAtTau(dForCell, vv, priorLog, tau2Cell * m)) as number);
      }
      const finite = candidates.filter((v) => Number.isFinite(v));
      if (finite.length) rangePct = [Math.min(...finite), Math.max(...finite)];
    }
    pooled = {
      pct: pooledPct,
      rangePct,
      direction: directionOf(pooledPct, rangePct),
      typesInCell: cellTypes.length,
      supportedTypes,
      borrowedTypes,
      priorLog,
      shrinkage: shrink,
      tau2: tau2Cell
    };
    if (pooledPct == null) reasons.push('R2 层级汇聚在本格无可用类型（相关事件类型支持不足）');
  }

  // ---- 状态 ----
  let status: CellStatus;
  if (!anyPresent) status = 'missing';
  else if (enough) status = 'ok';
  else status = pooled?.pct != null ? 'sparse' : 'indeterminate';

  // ---- 两路线方向一致性（仅在两侧均可判定时判“相反”，否则标“证据不足”） ----
  const r1Pct = dist && dist.meanSource > 0 ? ((dist.meanSynthetic - dist.meanSource) / dist.meanSource) * 100 : null;
  const r1Determinate = dist?.meanDiffCi != null && (dist.meanDiffCi[0] > 0) === (dist.meanDiffCi[1] > 0);
  const r2Determinate = pooled?.rangePct != null && !(pooled.rangePct[0] <= 0 && pooled.rangePct[1] >= 0);
  let routeAgreement: CellResult['routeAgreement'] = 'none';
  let routeAgreementNote = '';
  if (r1Pct != null && pooled?.pct != null) {
    const sameSign = Math.sign(r1Pct) === Math.sign(pooled.pct) || Math.abs(r1Pct) < 3 || Math.abs(pooled.pct) < 3;
    if (!sameSign && r1Determinate && r2Determinate) {
      routeAgreement = 'disagree';
      routeAgreementNote = `R1 均值差 ${r1Pct.toFixed(1)}% 与 R2 汇聚 ${pooled.pct.toFixed(1)}% 方向相反，需谨慎解释`;
    } else if (sameSign && r1Determinate && r2Determinate) {
      routeAgreement = 'agree';
      routeAgreementNote = '两条路线均判定存在同向偏差';
    } else if (sameSign) {
      routeAgreement = 'agree';
      routeAgreementNote = '方向一致；至少一条路线区间覆盖 0（差异不显著）';
    } else {
      routeAgreement = 'insufficient';
      routeAgreementNote = '方向不一致但至少一条路线区间覆盖 0，证据不足以下结论';
    }
  } else if (r1Pct != null || pooled?.pct != null) {
    routeAgreement = 'insufficient';
    routeAgreementNote = r1Pct != null ? '仅 R1 可判定；R2 因相关类型支持不足不可用' : '仅 R2 可参考（依赖共享结构假设）；R1 支持不足';
  } else {
    routeAgreementNote = '两条路线在本格均不可判定';
  }

  return { key, dims, support, status, indeterminateReasons: reasons, notes, dist, late, pooled, hierarchical, routeAgreement, routeAgreementNote };
}

function cartesian(lists: string[][]): string[][] {
  if (lists.length === 0) return [[]];
  const [first, ...rest] = lists;
  const tails = cartesian(rest);
  const out: string[][] = [];
  for (const v of first) for (const t of tails) out.push([v, ...t]);
  return out;
}

// ---------- 主入口 ----------

export interface ConditionalInput {
  syn: TableRows;
  src: TableRows;
  ruleSet: RuleSet;
  sourceBatchKey: string;
  synthRunId: string;
  synthBatchKey: string;
  /** 运行启动快照中的批次文件哈希（完整性守卫用） */
  runFileHashes?: Record<string, string>;
  /** 当前登记来源批次的文件哈希 */
  sourceFileHashes?: Record<string, string>;
  /** 来源批次修订号 / 当前最新修订（信息性提示用） */
  sourceRevision?: number;
  latestRevision?: number;
  config?: Partial<AnalysisConfig>;
}

export async function analyzeConditionalBias(input: ConditionalInput): Promise<Omit<ConditionalReport, 'id' | 'createdAt'>> {
  const { syn, src, ruleSet, sourceBatchKey, synthRunId, synthBatchKey } = input;
  const sourceFileHashes = input.sourceFileHashes ?? {};
  const srcDemandProbe = computeDemand(src, ruleSet.bounds.turnoverMin);
  const defaultBuckets = deriveConcurrencyBuckets([...srcDemandProbe.values()]);
  const cfg: AnalysisConfig = {
    ...BASE_ANALYSIS_CONFIG,
    maturityWindowMin: Math.max(DEFAULT_MATURITY_WINDOW_MIN, ruleSet.bounds.totalMaxMin),
    concurrencyBuckets: input.config?.concurrencyBuckets ?? defaultBuckets,
    ...input.config,
    quantiles: input.config?.quantiles ?? BASE_ANALYSIS_CONFIG.quantiles,
    histEdges: input.config?.histEdges ?? BASE_ANALYSIS_CONFIG.histEdges,
    oneDim: input.config?.oneDim ?? BASE_ANALYSIS_CONFIG.oneDim,
    crossDims: input.config?.crossDims ?? BASE_ANALYSIS_CONFIG.crossDims,
    tauMultipliers: input.config?.tauMultipliers ?? BASE_ANALYSIS_CONFIG.tauMultipliers
  };
  const maturity: MaturityRule = {
    windowMin: cfg.maturityWindowMin,
    cutoffDefinition: '观察截止 = 该数据集内最晚结案时间（含跨午夜，按绝对时间）；报警时刻距截止不足成熟窗口的事件视为尚未成熟。',
    requirement: '事件须有到场记录与有效结案（结案不早于末次到场），且报警距观察截止 ≥ 成熟窗口。未满足者不计入及时响应口径，单独计数排除。'
  };

  const srcAgg = buildDataset(src, ruleSet, maturity);
  const synAgg = buildDataset(syn, ruleSet, maturity);

  // ---- 可比性守卫 ----
  const srcTypes = [...new Set(src.events.map((e) => e.event_type))].sort();
  const synTypes = [...new Set(syn.events.map((e) => e.event_type))].sort();
  const srcDistricts = [...new Set(src.events.map((e) => e.district))].sort();
  const synDistricts = [...new Set(syn.events.map((e) => e.district))].sort();
  const unseenTypes = srcTypes.filter((t) => !synTypes.includes(t));
  const extraTypes = synTypes.filter((t) => !srcTypes.includes(t));
  const unseenDistricts = srcDistricts.filter((d) => !synDistricts.includes(d));
  const extraDistricts = synDistricts.filter((d) => !srcDistricts.includes(d));
  const batchKeyMatch = sourceBatchKey === synthBatchKey;
  const eventDefOk = extraTypes.length === 0;
  const geoOk = extraDistricts.length === 0;
  // 完整性守卫：运行记录中的批次文件哈希必须与当前登记哈希逐项一致
  const fileHashesMatch = input.runFileHashes
    ? Object.entries(input.runFileHashes).every(([name, h]) => sourceFileHashes[name] === h)
    : true;
  const reasons: string[] = [];
  if (!batchKeyMatch) reasons.push(`来源批次与运行启动快照不一致（${sourceBatchKey} ≠ ${synthBatchKey}）：事件定义/地理边界版本可能不同，拒绝直接比较`);
  if (!fileHashesMatch) reasons.push('运行记录中的来源批次文件哈希与当前登记哈希不一致（批次内容被改动或登记异常），拒绝直接比较');
  if (extraTypes.length > 0) reasons.push(`合成包出现源样本未定义的事件类型：${extraTypes.join('、')}`);
  if (extraDistricts.length > 0) reasons.push(`合成包出现源样本未定义的地理边界（行政区）：${extraDistricts.join('、')}`);
  const blocked = !batchKeyMatch || !fileHashesMatch || !eventDefOk || !geoOk;
  const laterRevision = input.latestRevision != null && input.sourceRevision != null && input.latestRevision > input.sourceRevision
    ? { used: input.sourceRevision, latest: input.latestRevision }
    : null;
  const comparability: Comparability = {
    ok: !blocked,
    blocked,
    reasons,
    batchKeyMatch,
    eventDefinition: { source: srcTypes, synthetic: synTypes, unseenInSynthetic: unseenTypes, extraInSynthetic: extraTypes, ok: eventDefOk },
    geoBoundary: { source: srcDistricts, synthetic: synDistricts, unseenInSynthetic: unseenDistricts, extraInSynthetic: extraDistricts, ok: geoOk },
    laterRevision,
    fileHashesMatch
  };
  if (laterRevision) {
    comparability.reasons.push(`（信息）该批次已登记更新的修订 r${laterRevision.latest}；本报告固定在运行启动快照 r${laterRevision.used} 上比较，未混入新修订`);
  }

  let tables: StratumTable[] = [];
  const groups: HierGroupOut[] = [];
  const undetermined: string[] = [];
  const suppressedHighLoad: string[] = [];
  const undecidableHighLoad: string[] = [];
  let okCells = 0;
  let sparseCells = 0;
  let indeterminateCells = 0;
  let missingCells = 0;
  let routeDisagreements = 0;

  if (!blocked) {
    const allNeeds = new Set([...srcAgg.obs.map((o) => o.resourceNeed), ...synAgg.obs.map((o) => o.resourceNeed)]);
    const pooledByType = new Map<string, PooledTypeRef>();
    for (const need of [...allNeeds].sort()) {
      const tes = typeEffects(srcAgg.obs.filter((o) => o.resourceNeed === need), synAgg.obs.filter((o) => o.resourceNeed === need));
      const pg = poolGroup(need, tes);
      const sensitivity = cfg.tauMultipliers.map((m) => {
        const byType: Record<string, number | null> = {};
        for (const te of tes) {
          byType[te.eventType] = te.valid && pg.mu != null ? pctOf(pooledAtTau(te.d, te.v, pg.mu, pg.tau2 * m)) : null;
        }
        return { multiplier: m, pooledPctByType: byType };
      });
      const rows: HierRow[] = tes.map((te) => {
        const vals = te.valid && pg.mu != null ? cfg.tauMultipliers.map((m) => pooledAtTau(te.d, te.v, pg.mu as number, pg.tau2 * m)) : [];
        const base = te.valid && pg.mu != null ? pooledAtTau(te.d, te.v, pg.mu, pg.tau2) : null;
        return {
          eventType: te.eventType,
          sourceN: te.sourceN,
          synN: te.synN,
          rawDiffLog: te.valid ? te.d : null,
          rawPct: te.valid ? pctOf(te.d) : null,
          pooledDiffLog: base,
          pooledPct: pctOf(base),
          pooledRangeLog: vals.length ? [Math.min(...vals), Math.max(...vals)] : null,
          pooledRangePct: vals.length ? [pctOf(Math.min(...vals)) as number, pctOf(Math.max(...vals)) as number] : null,
          pooledInGroup: te.valid
        };
      });
      groups.push({ resourceNeed: need, types: rows, pooledMeanLog: pg.mu, tau2: pg.tau2, validTypes: tes.filter((t) => t.valid).length, sensitivity });
      for (const te of tes) if (te.valid && pg.mu != null) pooledByType.set(te.eventType, { group: pg, te });
    }

    const dimTables: { key: string; dims: StratumDim[]; label: string }[] = [
      ...cfg.oneDim.map((d) => ({ key: d, dims: [d] as StratumDim[], label: DIM_LABELS[d] })),
      ...cfg.crossDims.map(([a, b]) => ({ key: `${a}×${b}`, dims: [a, b] as [StratumDim, StratumDim], label: `${DIM_LABELS[a]} × ${DIM_LABELS[b]}` }))
    ];

    const levelOf = (o: EventObs, dim: StratumDim): string => {
      if (dim === 'severity') return o.priority;
      if (dim === 'resourceNeed') return o.resourceNeed;
      const b = cfg.concurrencyBuckets.find((x) => o.demand >= x.min && o.demand <= x.max);
      return b?.label ?? cfg.concurrencyBuckets[cfg.concurrencyBuckets.length - 1].label;
    };

    for (const dt of dimTables) {
      const levelLists = dt.dims.map((d) => {
        const set = new Set<string>();
        for (const o of srcAgg.obs) set.add(levelOf(o, d));
        for (const o of synAgg.obs) set.add(levelOf(o, d));
        return [...set].sort();
      });
      const combos = cartesian(levelLists);
      const cells: CellResult[] = combos.map((combo) => {
        const key = `${dt.key}|${combo.join('|')}`;
        const dimMap: Partial<Record<StratumDim, string>> = {};
        dt.dims.forEach((d, i) => { dimMap[d] = combo[i]; });
        const filter = (o: EventObs) => dt.dims.every((d, i) => levelOf(o, d) === combo[i]);
        const cell = buildCell(key, dimMap, srcAgg.obs.filter(filter), synAgg.obs.filter(filter), cfg, pooledByType);
        if (cell.status === 'ok') okCells++;
        else if (cell.status === 'sparse') sparseCells++;
        else if (cell.status === 'indeterminate') indeterminateCells++;
        else missingCells++;
        if (cell.routeAgreement === 'disagree') {
          routeDisagreements++;
          undetermined.push(`[${dt.label}] ${combo.join(' / ')} — 两路线方向相反：${cell.routeAgreementNote}`);
        }
        if (cell.status !== 'ok' && cell.indeterminateReasons.length > 0) {
          undetermined.push(`[${dt.label}] ${combo.join(' / ')} — ${cell.indeterminateReasons.join('；')}`);
        } else if (cell.status === 'ok' && cell.indeterminateReasons.length > 0) {
          undetermined.push(`[${dt.label}] ${combo.join(' / ')} — ${cell.indeterminateReasons.join('；')}`);
        }
        const highBucket = cfg.concurrencyBuckets[cfg.concurrencyBuckets.length - 1].label;
        const highLoad = dimMap.severity === 'P1' || dimMap.concurrency === highBucket;
        if (highLoad && cell.status !== 'missing') {
          const pct = cell.pooled?.pct ?? null;
          const r1 = cell.dist && cell.dist.meanSource > 0 ? ((cell.dist.meanSynthetic - cell.dist.meanSource) / cell.dist.meanSource) * 100 : null;
          if (cell.status !== 'ok') {
            undecidableHighLoad.push(`[${dt.label}] ${combo.join(' / ')}：支持不足（${cell.status === 'sparse' ? '仅 R2 参考' : '不可判定'}），不能据此判断高负荷下仍有余量`);
          }
          // 仅当证据自洽时才判“被压低”：
          //  - R2 汇聚确定向下且敏感性区间上界 < 0；
          //  - 若 R1 也可判定，则 R1 必须同向（否则归为方向矛盾，不在此断言）。
          const r1Determinate = cell.dist?.meanDiffCi != null && cell.dist.meanDiffCi[1] < 0;
          const r2Down = pct != null && pct < -5 && cell.pooled?.rangePct != null && cell.pooled.rangePct[1] < 0;
          const r1Agrees = r1 == null || r1 < 0;
          if (r2Down && r1Agrees) {
            const rr = cell.pooled?.rangePct;
            suppressedHighLoad.push(`[${dt.label}] ${combo.join(' / ')}：到场时长偏差 R1 ${r1 != null ? r1.toFixed(1) + '%' : '不可判定（仅 R2 证据）'} / R2 ${pct.toFixed(1)}%（敏感性区间 ${rr ? `${rr[0].toFixed(1)}% ~ ${rr[1].toFixed(1)}%` : '—'}）`);
          } else if (r1Determinate && r1 != null && r1 < -10 && (!r2Down || (pct != null && pct < 0))) {
            const ci = cell.dist?.meanDiffCi;
            suppressedHighLoad.push(`[${dt.label}] ${combo.join(' / ')}：到场时长偏差 R1 ${r1.toFixed(1)}%${ci ? ` [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]` : ''} / R2 ${pct != null ? pct.toFixed(1) + '%' : '—'}`);
          }
        }
        return cell;
      });
      tables.push({
        key: dt.key,
        label: dt.label,
        dims: dt.dims,
        cells,
        counts: {
          ok: cells.filter((c) => c.status === 'ok').length,
          sparse: cells.filter((c) => c.status === 'sparse').length,
          indeterminate: cells.filter((c) => c.status === 'indeterminate').length,
          missing: cells.filter((c) => c.status === 'missing').length
        }
      });
    }
  }

  const overall: ConditionalReportBody['overall'] = blocked
    ? 'BLOCKED'
    : suppressedHighLoad.length > 0
      ? 'ATTENTION'
      : undecidableHighLoad.length > 0 || indeterminateCells > 0 || routeDisagreements > 0
        ? 'WARN'
        : 'OK';

  const body: Omit<ConditionalReport, 'id' | 'createdAt' | 'hash'> = {
    runId: synthRunId,
    overall,
    comparability,
    locked: {
      maturity,
      config: cfg,
      cutoffs: {
        source: srcAgg.cutoffMs ? new Date(srcAgg.cutoffMs).toISOString() : null,
        synthetic: synAgg.cutoffMs ? new Date(synAgg.cutoffMs).toISOString() : null
      },
      sourceBatchKey,
      synthRunId,
      synthBatchKey,
      configFingerprint: fnv1a(JSON.stringify(cfg)).toString(16).padStart(8, '0')
    },
    coverage: { source: srcAgg.coverage, synthetic: synAgg.coverage },
    tables,
    hierarchical: { groups },
    undetermined: undetermined.slice(0, 200),
    summary: { okCells, sparseCells, indeterminateCells, missingCells, routeDisagreements, suppressedHighLoad, undecidableHighLoad },
    disclaimer:
      '条件化偏差分析只比较同一来源修订与其生成包在锁定口径下的业务指标。分位差与分布距离区间来自确定性重采样；' +
      'R2 层级汇聚依赖“同资源类别的相关事件类型可部分共享”的结构假设，其收缩强度/tau² 敏感性范围与未汇聚原始支持度应同时阅读。' +
      '小格支持不足一律标注“不可判定”，不并入总体掩盖；本分析只读，不修改任何生成数据。'
  };
  const hash = await hashObject(body);
  return { ...body, hash };
}

export { pctOf, directionOf };
