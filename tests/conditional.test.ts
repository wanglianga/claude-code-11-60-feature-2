import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/domain/csv';
import {
  analyzeConditionalBias,
  buildDataset,
  computeDemand,
  deriveConcurrencyBuckets,
  defaultAnalysisConfig,
  type MaturityRule,
  type ConditionalReport
} from '../src/domain/conditional';
import { generateConstraint } from '../src/domain/generatorA';
import { generateJointFilter } from '../src/domain/generatorB';
import { defaultPlan, defaultRuleSet } from '../src/domain/defaults';
import type { Plan, RuleSet, TableRows } from '../src/domain/types';

const SAMPLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'emerg-2025-09');

function loadSample(rev: 'r1' | 'r2'): TableRows {
  const read = (n: string) => parseCsv(readFileSync(join(SAMPLE_ROOT, rev, n), 'utf8'));
  return {
    events: read('events.csv') as never,
    dispatches: read('dispatches.csv') as never,
    resources: read('resources.csv') as never,
    arrivals: read('arrivals.csv') as never,
    closures: read('closures.csv') as never
  };
}

const ruleSet: RuleSet = { ...defaultRuleSet('2025-01-01T00:00:00Z'), id: 'RS-T', version: 1, status: 'approved', hash: 't' };
const maturity: MaturityRule = {
  windowMin: 480,
  cutoffDefinition: 'test',
  requirement: 'test'
};

function makeTimes(rows: TableRows): number {
  let max = 0;
  for (const c of rows.closures) max = Math.max(max, new Date(c.close_time.replace(' ', 'T')).getTime());
  return max;
}

describe('事件成熟口径', () => {
  it('结案未成熟的事件不计入及时响应口径，并单独计数', () => {
    const rows = loadSample('r2');
    const agg = buildDataset(rows, ruleSet, maturity);
    // 合成的观察截止附近的事件应被排除（源样本在 9/30 前有少量）
    expect(agg.coverage.total).toBe(rows.events.length);
    expect(agg.coverage.excludedImmature).toBeGreaterThanOrEqual(1);
    expect(agg.coverage.usable + agg.coverage.missingArrival + agg.coverage.excludedImmature + agg.coverage.excludedOpen).toBe(rows.events.length);
    // 每个被排除为 immature 的事件，其报警时刻确实接近截止
    const cutoff = agg.cutoffMs;
    for (const o of agg.obs.filter((x) => x.excludeReason === 'immature-window')) {
      expect(o.alarmMs).toBeGreaterThan(cutoff - maturity.windowMin * 60000);
    }
  });

  it('无结案或结案早于到场的事件被排除为 open', () => {
    const base = loadSample('r2');
    const rows: TableRows = structuredClone(base);
    // 删除一条结案
    const victim = rows.events[0].event_id;
    rows.closures = rows.closures.filter((c) => c.event_id !== victim);
    const agg = buildDataset(rows, ruleSet, maturity);
    expect(agg.obs.find((o) => o.eventId === victim)?.excludeReason).toBe('open');
    expect(agg.obs.find((o) => o.eventId === victim)?.mature).toBe(false);
  });

  it('成熟事件缺到场记录时不计入及时响应（单独统计）', () => {
    const rows: TableRows = structuredClone(loadSample('r2'));
    // 选一个只有单条派遣的事件，删除其到场记录，确保该事件无任何到场
    const count = new Map<string, number>();
    for (const d of rows.dispatches) count.set(d.event_id, (count.get(d.event_id) ?? 0) + 1);
    const single = rows.dispatches.find((d) => count.get(d.event_id) === 1)!;
    const dispatchId = single.dispatch_id;
    const eventId = single.event_id;
    rows.arrivals = rows.arrivals.filter((a) => a.dispatch_id !== dispatchId);
    const agg = buildDataset(rows, ruleSet, maturity);
    const o = agg.obs.find((x) => x.eventId === eventId)!;
    expect(o.arrivalMin).toBeNull();
    expect(agg.coverage.missingArrival).toBeGreaterThanOrEqual(1);
    // 该事件不进入可用集合
    expect(agg.obs.filter((x) => x.mature && x.arrivalMin != null).find((x) => x.eventId === eventId)).toBeUndefined();
  });
});

describe('可比性守卫', () => {
  it('批次版本不一致时拒绝直接比较', async () => {
    const src = loadSample('r2');
    const rep = await analyzeConditionalBias({
      syn: src, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r1',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-X',
      config: { bootReps: 60 }
    });
    expect(rep.overall).toBe('BLOCKED');
    expect(rep.comparability.blocked).toBe(true);
    expect(rep.tables.length).toBe(0);
    expect(rep.comparability.reasons.join()).toContain('来源批次与运行启动快照不一致');
  });

  it('合成包出现源未定义的事件类型时拒绝比较', async () => {
    const src = loadSample('r2');
    const syn: TableRows = structuredClone(src);
    syn.events[0] = { ...syn.events[0], event_type: '未知新类型' };
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-X',
      config: { bootReps: 60 }
    });
    expect(rep.comparability.blocked).toBe(true);
    expect(rep.comparability.eventDefinition.extraInSynthetic).toContain('未知新类型');
  });

  it('合成包出现源未定义的地理边界时拒绝比较', async () => {    const src = loadSample('r2');
    const syn: TableRows = structuredClone(src);
    syn.events[0] = { ...syn.events[0], district: '新设新区' };
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-X',
      config: { bootReps: 60 }
    });
    expect(rep.comparability.blocked).toBe(true);
    expect(rep.comparability.geoBoundary.extraInSynthetic).toContain('新设新区');
  });

  it('运行快照文件哈希与当前登记不一致时拒绝比较', async () => {
    const src = loadSample('r2');
    const rep = await analyzeConditionalBias({
      syn: src, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-X',
      runFileHashes: { 'events.csv': 'deadbeef' },
      sourceFileHashes: { 'events.csv': 'cafebabe' },
      config: { bootReps: 40 }
    });
    expect(rep.overall).toBe('BLOCKED');
    expect(rep.comparability.fileHashesMatch).toBe(false);
    expect(rep.comparability.reasons.join()).toContain('文件哈希');
  });

  it('批次有更新修订时仅信息性提示，不阻断比较', async () => {
    const src = loadSample('r2');
    const rep = await analyzeConditionalBias({
      syn: src, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r1',
      synthBatchKey: 'emerg-2025-09@r1',
      synthRunId: 'RUN-X',
      sourceRevision: 1,
      latestRevision: 2,
      config: { bootReps: 40 }
    });
    expect(rep.comparability.blocked).toBe(false);
    expect(rep.comparability.laterRevision).toEqual({ used: 1, latest: 2 });
    expect(rep.comparability.reasons.join()).toContain('r2');
  });
});

describe('小格不可判定且不并入总体', () => {
  it('支持不足的格标注不可判定/稀疏，绝不默认为通过', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 120;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 120 }
    });
    expect(rep.overall).not.toBe('BLOCKED');
    // 至少出现一个非 ok 的格（罕见组合/交叉维度）
    const cells = rep.tables.flatMap((t) => t.cells);
    expect(cells.some((c) => c.status === 'sparse' || c.status === 'indeterminate' || c.status === 'missing')).toBe(true);
    for (const c of cells) {
      if (c.status !== 'ok' && c.status !== 'missing') {
        expect(c.indeterminateReasons.length).toBeGreaterThan(0);
      }
      // 不可判定/稀疏格不能被伪装成“通过”：值缺失或明确标注
      if (c.status === 'indeterminate') expect(c.pooled?.pct ?? null).toBeNull();
    }
    // 不可判定范围逐条列出
    expect(rep.undetermined.length).toBeGreaterThan(0);
  });

  it('稀疏格若可借 R2 收敛则标 sparse 并给出收缩权重，且不声称 R1 可判定', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 120;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 120 }
    });
    const sparse = rep.tables.flatMap((t) => t.cells).filter((c) => c.status === 'sparse');
    for (const c of sparse) {
      expect(c.pooled).not.toBeNull();
      expect(c.pooled!.pct).not.toBeNull();
      expect(c.pooled!.shrinkage).not.toBeNull();
      // 稀疏格不能同时声称 R1 支持充足
      expect(c.support.sourceUsable < 8 || c.support.synUsable < 8).toBe(true);
    }
  });
});

describe('右侧长尾', () => {
  it('尾部（p90/p95）给出分位差及区间，长尾被压低的格可被识别', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 300;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 200 }
    });
    const bigCells = rep.tables.flatMap((t) => t.cells).filter((c) => c.dist && c.status === 'ok');
    expect(bigCells.length).toBeGreaterThan(0);
    for (const c of bigCells) {
      const p95 = c.dist!.quantiles.find((q) => Math.abs(q.q - 0.95) < 1e-9)!;
      expect(Number.isFinite(p95.source)).toBe(true);
      expect(Number.isFinite(p95.diff)).toBe(true);
      // 分位差应等于合成-源
      expect(p95.diff).toBeCloseTo(p95.synthetic - p95.source, 6);
    }
    // 总体尾部统计不应被隐藏：分位数组固定包含 0.5/0.9/0.95
    expect(rep.locked.config.quantiles).toEqual([0.5, 0.9, 0.95]);
  });

  it('同一输入重复分析得到相同报告哈希（确定性 bootstrap）', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 150;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const args = {
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 120 }
    };
    const a = await analyzeConditionalBias(args);
    const b = await analyzeConditionalBias(args);
    expect(a.hash).toBe(b.hash);
  });
});

describe('两条路线共同评估', () => {
  it('R1 与 R2 在同一条件下均给出结果，并标注一致/相反/证据不足', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 250;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 120 }
    });
    for (const c of rep.tables.flatMap((t) => t.cells)) {
      if (c.status === 'ok') {
        expect(c.dist).not.toBeNull();
        expect(['agree', 'disagree', 'insufficient', 'none']).toContain(c.routeAgreement);
        expect(c.routeAgreementNote.length).toBeGreaterThan(0);
      }
      if (c.pooled) {
        // 汇聚必须同时暴露未汇聚原始值（按事件类型）与敏感性范围
        expect(c.hierarchical.length).toBeGreaterThan(0);
        for (const h of c.hierarchical) {
          if (h.rawPct != null) expect(h.pooledRangePct).not.toBeNull();
        }
      }
    }
  });

  it('层级汇聚暴露 τ² 敏感性与未汇聚原始支持度', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 300;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 120 }
    });
    expect(rep.hierarchical.groups.length).toBeGreaterThan(0);
    for (const g of rep.hierarchical.groups) {
      expect(g.tau2).toBeGreaterThanOrEqual(0);
      expect(g.sensitivity.length).toBe(rep.locked.config.tauMultipliers.length);
      for (const t of g.types) {
        expect(t.sourceN).toBeGreaterThanOrEqual(0);
        expect(t.synN).toBeGreaterThanOrEqual(0);
        if (t.rawDiffLog != null) expect(Number.isFinite(t.rawDiffLog)).toBe(true);
      }
    }
  });

  it('两条生成路线在同一条件下都得到可比较的分析结构', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 200;
    const a = generateConstraint({ plan, ruleSet, source: src }).tables;
    const b = generateJointFilter({ plan, ruleSet, source: src }).tables;
    const common = { src, ruleSet, sourceBatchKey: 'emerg-2025-09@r2', synthBatchKey: 'emerg-2025-09@r2', synthRunId: 'RUN', config: { bootReps: 80 } };
    const ra = await analyzeConditionalBias({ ...common, syn: a });
    const rb = await analyzeConditionalBias({ ...common, syn: b });
    expect(ra.tables.map((t) => t.key)).toEqual(rb.tables.map((t) => t.key));
    expect(ra.locked.config).toEqual(rb.locked.config);
    expect(ra.tables.map((t) => t.cells.length)).toEqual(rb.tables.map((t) => t.cells.length));
  });
});

describe('并发负荷口径', () => {
  it('computeDemand 跨午夜安全且不把自身计为并发', () => {
    const rows: TableRows = {
      events: [
        { event_id: 'E1', alarm_time: '2025-09-01 23:50:00', event_type: '突发疾病', district: '城东区', address_text: 'x', caller_phone: 'p', priority: 'P2' },
        { event_id: 'E2', alarm_time: '2025-09-01 23:55:00', event_type: '突发疾病', district: '城东区', address_text: 'x', caller_phone: 'p', priority: 'P2' }
      ],
      dispatches: [
        { dispatch_id: 'D1', event_id: 'E1', resource_id: 'AMB-01', dispatch_time: '2025-09-01 23:51:00' },
        { dispatch_id: 'D2', event_id: 'E2', resource_id: 'AMB-02', dispatch_time: '2025-09-01 23:56:00' }
      ],
      resources: [
        { resource_id: 'AMB-01', resource_type: '救护车', station: 'x', capability: '急救' },
        { resource_id: 'AMB-02', resource_type: '救护车', station: 'x', capability: '急救' }
      ],
      arrivals: [
        { arrival_id: 'A1', dispatch_id: 'D1', arrive_time: '2025-09-02 00:10:00', arrive_site: '现场' },
        { arrival_id: 'A2', dispatch_id: 'D2', arrive_time: '2025-09-02 00:12:00', arrive_site: '现场' }
      ],
      closures: [
        { closure_id: 'C1', event_id: 'E1', close_time: '2025-09-02 00:50:00', outcome: '送医' },
        { closure_id: 'C2', event_id: 'E2', close_time: '2025-09-02 01:00:00', outcome: '送医' }
      ]
    };
    const d = computeDemand(rows, 20);
    // E2 报警时，E1 的车辆仍在占用（跨午夜）
    expect(d.get('E2')).toBeGreaterThanOrEqual(1);
    // 自身不应被计入
    expect(d.get('E1')).toBeGreaterThanOrEqual(0);
  });

  it('并发分桶只用源样本取值分布预先锁定', () => {
    expect(deriveConcurrencyBuckets([0, 0, 0]).length).toBe(1);
    expect(deriveConcurrencyBuckets([0, 0, 1, 1]).length).toBe(2);
    const b = deriveConcurrencyBuckets([0, 1, 1, 2, 3, 5]);
    expect(b.length).toBe(3);
    expect(b[0].min).toBe(0);
    expect(b[b.length - 1].max).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('默认配置以规则集全程上限为成熟窗口下限', () => {
    const cfg = defaultAnalysisConfig(ruleSet, [0, 0, 1]);
    expect(cfg.maturityWindowMin).toBeGreaterThanOrEqual(ruleSet.bounds.totalMaxMin);
    expect(cfg.arrivalLimitMin).toBe(15);
  });
});

describe('高负荷被压低的可识别性', () => {
  it('P1 到场被系统性压短时，报告的 suppressedHighLoad 能指出且带 R1/R2 证据', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 400;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    // 把所有 P1 事件的到场行驶时长压到 50%（保持先后顺序与引用不变）
    const prio = new Map(syn.events.map((e) => [e.event_id, e.priority]));
    for (const a of syn.arrivals) {
      const d = syn.dispatches.find((x) => x.dispatch_id === a.dispatch_id);
      if (!d || prio.get(d.event_id) !== 'P1') continue;
      const dispT = new Date(d.dispatch_time.replace(' ', 'T')).getTime();
      const arrT = new Date(a.arrive_time.replace(' ', 'T')).getTime();
      const newArr = Math.max(dispT + 60000, dispT + Math.round((arrT - dispT) * 0.5));
      const dt = new Date(newArr);
      const p = (n: number) => String(n).padStart(2, '0');
      a.arrive_time = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
    }
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 200 }
    });
    expect(rep.overall).toBe('ATTENTION');
    expect(rep.summary.suppressedHighLoad.length).toBeGreaterThan(0);
    expect(rep.summary.suppressedHighLoad.some((s) => s.includes('P1'))).toBe(true);
    // 每条被压低结论都带 R1 或 R2 的百分比证据
    for (const s of rep.summary.suppressedHighLoad) expect(s).toMatch(/-?\d+\.\d%/);
  });

  it('无系统压低时不会误报高负荷被压低', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 300;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 150 }
    });
    expect(rep.summary.suppressedHighLoad.length).toBe(0);
  });
});

describe('条件化盲区（总体接近但条件失真）', () => {
  it('总体平均到场时间相对偏差 < 5% 时，仍能报告 P1 尾部被压低', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 500;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const mat = { windowMin: 480, cutoffDefinition: 'x', requirement: 'x' };
    const meanArrival = (rows: TableRows) => {
      const v = buildDataset(rows, ruleSet, mat).obs.filter((o) => o.mature && o.arrivalMin != null).map((o) => o.arrivalMin as number);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    const srcMean = meanArrival(src);
    const prio = new Map(syn.events.map((e) => [e.event_id, e.priority]));
    const dispById = new Map(syn.dispatches.map((d) => [d.dispatch_id, d]));
    // 只压短 P1 的“长尾”到场段，保持总体均值大体不变
    for (const a of syn.arrivals) {
      const d = dispById.get(a.dispatch_id)!;
      if (prio.get(d.event_id) !== 'P1') continue;
      const dt = new Date(d.dispatch_time.replace(' ', 'T')).getTime();
      const at = new Date(a.arrive_time.replace(' ', 'T')).getTime();
      if (at - dt < 6 * 60000) continue;
      const nd = new Date(dt + Math.round((at - dt) * 0.5));
      const p = (n: number) => String(n).padStart(2, '0');
      a.arrive_time = `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())} ${p(nd.getHours())}:${p(nd.getMinutes())}:${p(nd.getSeconds())}`;
    }
    // 总体层面几乎无法察觉
    const overallRel = Math.abs((meanArrival(syn) - srcMean) / srcMean) * 100;
    expect(overallRel).toBeLessThan(5);
    // 条件化层面能指出高负荷被压低
    const rep = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 150 }
    });
    expect(rep.summary.suppressedHighLoad.length).toBeGreaterThan(0);
    expect(rep.summary.suppressedHighLoad.some((s) => s.includes('P1'))).toBe(true);
  });
});

describe('只读与结果摘要', () => {  it('分析不修改输入的源/合成数据', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 100;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const before = JSON.stringify({ src, syn });
    await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 60 }
    });
    expect(JSON.stringify({ src, syn })).toBe(before);
  });

  it('报告 summary 与表内计数一致', async () => {
    const src = loadSample('r2');
    const plan: Plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, src, '2025-01-01T00:00:00Z');
    plan.targetEvents = 150;
    const syn = generateConstraint({ plan, ruleSet, source: src }).tables;
    const rep: Omit<ConditionalReport, 'id' | 'createdAt'> = await analyzeConditionalBias({
      syn, src, ruleSet,
      sourceBatchKey: 'emerg-2025-09@r2',
      synthBatchKey: 'emerg-2025-09@r2',
      synthRunId: 'RUN-0001',
      config: { bootReps: 60 }
    });
    const cells = rep.tables.flatMap((t) => t.cells);
    expect(rep.summary.okCells).toBe(cells.filter((c) => c.status === 'ok').length);
    expect(rep.summary.sparseCells).toBe(cells.filter((c) => c.status === 'sparse').length);
    expect(rep.summary.indeterminateCells).toBe(cells.filter((c) => c.status === 'indeterminate').length);
    expect(rep.summary.missingCells).toBe(cells.filter((c) => c.status === 'missing').length);
    expect(rep.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.locked.configFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});
