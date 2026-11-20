import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { startConditionalAnalysis } from '../services/conditionalService';
import { exportJson } from '../services/exportService';
import { Empty, HashChip } from '../ui/widgets';
import { useToast } from '../ui/toast';
import type { ConditionalReport, CellResult, StratumTable, CellStatus } from '../domain/conditional';
import type { Run } from '../domain/types';

const STATUS_BADGE: Record<CellStatus, { cls: string; text: string }> = {
  ok: { cls: 'ok', text: '可判定' },
  sparse: { cls: 'warn', text: '稀疏·仅 R2 参考' },
  indeterminate: { cls: 'bad', text: '不可判定' },
  missing: { cls: '', text: '该群体缺失' }
};

function StatusBadge({ status }: { status: CellStatus }) {
  const m = STATUS_BADGE[status];
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

function OverallBadge({ overall }: { overall: ConditionalReport['overall'] }) {
  const map: Record<ConditionalReport['overall'], { cls: string; text: string }> = {
    OK: { cls: 'ok', text: 'OK' },
    WARN: { cls: 'warn', text: 'WARN' },
    ATTENTION: { cls: 'bad', text: 'ATTENTION' },
    BLOCKED: { cls: 'bad', text: 'BLOCKED' }
  };
  const m = map[overall];
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function num(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function ciText(ci: [number, number] | null | undefined, digits = 1): string {
  if (!ci) return '区间不可得';
  return `[${ci[0].toFixed(digits)}, ${ci[1].toFixed(digits)}]`;
}

export default function Conditional() {
  const toast = useToast();
  const runs = useLiveQuery(() => db.runs.orderBy('seq').reverse().toArray(), []);
  const reports = useLiveQuery(() => db.conditionalReports.toArray(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const doneRuns = (runs ?? []).filter((r) => r.status === 'done');
  const reportByRun = useMemo(() => {
    const m = new Map<string, ConditionalReport>();
    for (const r of reports ?? []) m.set(r.runId, r);
    return m;
  }, [reports]);
  const sel = selected ? reports?.find((r) => r.id === selected) : undefined;

  const analyze = async (run: Run) => {
    setBusy(run.id);
    const res = await startConditionalAnalysis(run.id);
    setBusy(null);
    if (res.ok) {
      toast(`条件化偏差分析完成：${res.report.overall}`, res.report.overall === 'ATTENTION' || res.report.overall === 'BLOCKED' ? 'bad' : 'ok');
      setSelected(res.report.id);
    } else toast(res.error, 'bad');
  };

  return (
    <div>
      <h1 className="page-title">条件化偏差分析</h1>
      <p className="page-sub">
        以「同一来源修订 + 由其生成的运行包」为比较对象，预先锁定事件成熟口径、分层条件与到场时长/未及时响应指标，
        逐群体给出样本支持、分布差异、尾部分位差与无法稳定估计的范围。只读分析，不修改任何生成数据。
      </p>

      <div className="card">
        <h3>选择运行</h3>
        {doneRuns.length === 0 ? <Empty text="暂无已完成运行，请先在「生成运行」完成一次生成" /> : (
          <table className="data">
            <thead><tr><th>运行</th><th>路线</th><th>批次快照</th><th>规模</th><th>已有条件化报告</th><th></th></tr></thead>
            <tbody>
              {doneRuns.map((r) => {
                const rep = reportByRun.get(r.id);
                return (
                  <tr key={r.id}>
                    <td><b>{r.id}</b><div className="small muted">{new Date(r.startedAt).toLocaleString()}</div></td>
                    <td>{r.method === 'constraint' ? '约束驱动' : '分布+筛选'}</td>
                    <td className="small">{r.batchKey}</td>
                    <td className="small">{r.stats ? `${r.stats.events} 事件` : '-'}</td>
                    <td>{rep ? <span className="badge ok">{rep.id}</span> : <span className="muted small">无</span>}</td>
                    <td>
                      <div className="btn-row">
                        <button className="primary" disabled={busy !== null} onClick={() => void analyze(r)}>
                          {busy === r.id ? '分析中…' : rep ? '重新分析' : '开始分析'}
                        </button>
                        {rep && <button onClick={() => setSelected(rep.id)}>查看报告</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && sel && <ReportView report={sel} />}
      {selected && !sel && <div className="card"><Empty text="报告不存在或已失效，请重新分析" /></div>}
    </div>
  );
}

function ReportView({ report }: { report: ConditionalReport }) {
  const [tab, setTab] = useState<string>(report.tables[0]?.key ?? '');
  const table = report.tables.find((t) => t.key === tab) ?? report.tables[0];

  return (
    <div>
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>
            条件化偏差报告 {report.id} <span className="muted">（{report.runId}）</span>
          </h3>
          <div className="btn-row">
            <OverallBadge overall={report.overall} />
            <button onClick={() => exportJson(`${report.id}-conditional.json`, report)}>导出 JSON</button>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          {new Date(report.createdAt).toLocaleString()} · 报告哈希 <HashChip text={report.hash} len={16} /> ·
          配置指纹 <span className="mono">{report.locked.configFingerprint}</span>
        </div>

        <div className={`notice ${report.comparability.blocked ? 'bad' : 'ok'}`} style={{ marginTop: 12 }}>
          <b>可比性守卫：{report.comparability.blocked ? '拒绝比较' : '通过'}</b>
          {report.comparability.blocked ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {report.comparability.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          ) : (
            <div className="small" style={{ marginTop: 4 }}>
              批次一致性：{report.comparability.batchKeyMatch ? '是' : '否'} ·
              文件哈希一致：{report.comparability.fileHashesMatch ? '是' : '否'} ·
              事件定义：源 {report.comparability.eventDefinition.source.length} 类 / 合成 {report.comparability.eventDefinition.synthetic.length} 类
              {report.comparability.eventDefinition.unseenInSynthetic.length > 0 &&
                `（合成未覆盖：${report.comparability.eventDefinition.unseenInSynthetic.join('、')}）`} ·
              地理边界：源 {report.comparability.geoBoundary.source.length} 区 / 合成 {report.comparability.geoBoundary.synthetic.length} 区
              {report.comparability.geoBoundary.unseenInSynthetic.length > 0 &&
                `（合成未覆盖：${report.comparability.geoBoundary.unseenInSynthetic.join('、')}）`}
              {report.comparability.laterRevision && (
                <div className="badge warn" style={{ marginTop: 6 }}>
                  该批次已登记更新修订 r{report.comparability.laterRevision.latest}；本报告固定在运行快照 r{report.comparability.laterRevision.used} 比较
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid4" style={{ marginTop: 4 }}>
          {[
            { label: '可判定格', value: report.summary.okCells },
            { label: '稀疏·仅 R2 参考', value: report.summary.sparseCells },
            { label: '不可判定格', value: report.summary.indeterminateCells },
            { label: '该群体缺失', value: report.summary.missingCells }
          ].map((s) => (
            <div key={s.label}>
              <div className="stat-num">{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>预先锁定的口径（报告内固定）</h3>
        <div className="kv">
          <dt>成熟窗口</dt><dd>≥ {report.locked.maturity.windowMin} 分钟（报警距该数据集观察截止）</dd>
          <dt>观察截止</dt>
          <dd>源 {report.locked.cutoffs.source ? new Date(report.locked.cutoffs.source).toLocaleString() : '—'} ·
            合成 {report.locked.cutoffs.synthetic ? new Date(report.locked.cutoffs.synthetic).toLocaleString() : '—'}</dd>
          <dt>未及时响应阈值</dt><dd>首程到场时长 &gt; {report.locked.config.arrivalLimitMin} 分钟</dd>
          <dt>最小支持</dt>
          <dd>源 ≥ {report.locked.config.minSourceN} · 合成 ≥ {report.locked.config.minSynN} ·
            分位/TVD 区间两侧均需 ≥ {report.locked.config.minQuantileN}</dd>
          <dt>分位</dt><dd>{report.locked.config.quantiles.map((q) => `p${Math.round(q * 100)}`).join(' / ')}</dd>
          <dt>并发分桶</dt><dd>{report.locked.config.concurrencyBuckets.map((b) => b.label).join(' · ')}</dd>
          <dt>比较对象</dt><dd>{report.locked.sourceBatchKey} → {report.locked.synthRunId}</dd>
        </div>
        <div className="notice info small" style={{ marginTop: 10 }}>
          <b>成熟口径：</b>{report.locked.maturity.requirement}
        </div>

        <div className="grid2" style={{ marginTop: 6 }}>
          <Coverage title="源样本" c={report.coverage.source} />
          <Coverage title="合成包" c={report.coverage.synthetic} />
        </div>
      </div>

      {(report.summary.suppressedHighLoad.length > 0 || report.summary.undecidableHighLoad.length > 0) && (
        <div className={`notice ${report.summary.suppressedHighLoad.length > 0 ? 'bad' : 'warn'}`}>
          {report.summary.suppressedHighLoad.length > 0 && (
            <>
              <b>高负荷情形被显著压低（需培训负责人确认用途）：</b>
              <ul style={{ margin: '6px 0 6px', paddingLeft: 18 }}>
                {report.summary.suppressedHighLoad.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </>
          )}
          {report.summary.undecidableHighLoad.length > 0 && (
            <>
              <b>高负荷情形不可判定（不能据此认为压力下仍有余量）：</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {report.summary.undecidableHighLoad.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3>分层差异报告</h3>
        <div className="tabs">
          {report.tables.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              {t.label}（{t.cells.length}）
            </button>
          ))}
        </div>
        {table && <StratumTableView table={table} />}
      </div>

      <div className="card">
        <h3>层级汇聚模型（R2）与敏感性</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          以「资源类别」为组，在相关事件类型间做随机效应汇聚得到组先验，再把各格的对数到场时长差按方差向先验收缩。
          依赖“同类事件类型可部分共享偏差结构”的假设；τ² 越大表示组内异质越强、共享越不可信。
        </p>
        {report.hierarchical.groups.length === 0 ? <Empty text="无可用汇聚组" /> : (
          <table className="data">
            <thead>
              <tr>
                <th>资源类别</th><th>有效类型数</th><th>组先验（对数差）</th><th>τ²</th>
                <th>类型</th><th>源/合成支持</th><th>未汇聚原始偏差</th><th>汇聚后偏差</th><th>τ² 敏感性范围</th>
              </tr>
            </thead>
            <tbody>
              {report.hierarchical.groups.flatMap((g) => g.types.map((t, i) => (
                <tr key={`${g.resourceNeed}-${t.eventType}`}>
                  {i === 0 && (
                    <>
                      <td rowSpan={g.types.length}><b>{g.resourceNeed}</b></td>
                      <td rowSpan={g.types.length}>{g.validTypes}</td>
                      <td rowSpan={g.types.length}>{num(g.pooledMeanLog, 3)}</td>
                      <td rowSpan={g.types.length}>{g.tau2.toFixed(4)}</td>
                    </>
                  )}
                  <td className="small">{t.eventType}</td>
                  <td className="small">{t.sourceN} / {t.synN}</td>
                  <td className="small">{t.rawPct == null ? '—' : pct(t.rawPct)}{!t.pooledInGroup && t.sourceN > 0 ? '（支持不足，不借用）' : ''}</td>
                  <td className="small">{t.pooledInGroup ? pct(t.pooledPct) : '不借用'}</td>
                  <td className="small">{t.pooledRangePct ? `${pct(t.pooledRangePct[0])} ~ ${pct(t.pooledRangePct[1])}` : '—'}</td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>无法稳定估计的范围（{report.undetermined.length}）</h3>
        {report.undetermined.length === 0 ? <Empty text="所有分层均支持稳定估计" /> : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {report.undetermined.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        )}
      </div>

      <div className="notice info small"><b>分析范围声明：</b>{report.disclaimer}</div>
    </div>
  );
}

function Coverage({ title, c }: { title: string; c: ConditionalReport['coverage']['source'] }) {
  return (
    <div className="card" style={{ background: '#fafbfe', marginBottom: 0 }}>
      <h4 style={{ marginTop: 0 }}>{title}</h4>
      <div className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
        <dt>事件总数</dt><dd>{c.total}</dd>
        <dt>成熟事件</dt><dd>{c.mature}</dd>
        <dt>可用（含到场）</dt><dd>{c.usable}</dd>
        <dt>因结案未成熟排除</dt><dd>{c.excludedImmature}</dd>
        <dt>因无有效结案排除</dt><dd>{c.excludedOpen}</dd>
        <dt>成熟但缺到场</dt><dd>{c.missingArrival}</dd>
      </div>
    </div>
  );
}

function StratumTableView({ table }: { table: StratumTable }) {
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        可判定 {table.counts.ok} · 稀疏（仅 R2 参考）{table.counts.sparse} · 不可判定 {table.counts.indeterminate} · 缺失 {table.counts.missing}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              {table.dims.map((d) => <th key={d}>{d === 'severity' ? '严重度' : d === 'resourceNeed' ? '资源类别' : '并发负荷'}</th>)}
              <th>状态</th>
              <th>支持（源/合成 可用）</th>
              <th>到场均值 源→合成（差）</th>
              <th>分布距离 TVD [95%]</th>
              <th>中位差 [95%]</th>
              <th>p90 差 [95%]</th>
              <th>p95 差 [95%]</th>
              <th>未及时响应率 源→合成</th>
              <th>率差 [95%]</th>
              <th>R2 汇聚偏差 [敏感性]</th>
              <th>收缩权重</th>
              <th>两路线一致性</th>
            </tr>
          </thead>
          <tbody>
            {table.cells.map((cell) => <CellRow key={cell.key} cell={cell} dims={table.dims} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellRow({ cell, dims }: { cell: CellResult; dims: StratumTable['dims'] }) {
  const [open, setOpen] = useState(false);
  const q = (p: number) => cell.dist?.quantiles.find((x) => Math.abs(x.q - p) < 1e-9) ?? null;
  const q50 = q(0.5);
  const q90 = q(0.9);
  const q95 = q(0.95);
  const lateDif = cell.late && cell.late.diff != null ? cell.late.diff * 100 : null;
  const lateCi = cell.late?.diffCi ? [cell.late.diffCi[0] * 100, cell.late.diffCi[1] * 100] as [number, number] : null;
  return (
    <>
      <tr>
        {dims.map((d) => <td key={d} className="small">{cell.dims[d] ?? '—'}</td>)}
        <td><StatusBadge status={cell.status} /></td>
        <td className="small">{cell.support.sourceUsable} / {cell.support.synUsable}
          {cell.support.sourceMissingArrival + cell.support.synMissingArrival > 0 && (
            <div className="muted">缺到场 {cell.support.sourceMissingArrival}/{cell.support.synMissingArrival}</div>
          )}
        </td>
        <td className="small">
          {cell.dist ? `${num(cell.dist.meanSource)}→${num(cell.dist.meanSynthetic)}（${pct(((cell.dist.meanSynthetic - cell.dist.meanSource) / (cell.dist.meanSource || 1)) * 100)}）` : '—'}
          {cell.dist?.meanDiffCi && <div className="muted">差 {num(cell.dist.meanDiff)} 分 {ciText(cell.dist.meanDiffCi)}</div>}
        </td>
        <td className="small">{cell.dist ? `${num(cell.dist.tvd, 3)} ${ciText(cell.dist.tvdCi, 3)}` : '—'}</td>
        <td className="small">{q50 ? `${num(q50.diff)} ${ciText(q50.ci)}` : '—'}</td>
        <td className="small">{q90 ? `${num(q90.diff)} ${ciText(q90.ci)}` : '—'}</td>
        <td className="small">{q95 ? `${num(q95.diff)} ${ciText(q95.ci)}` : '—'}</td>
        <td className="small">
          {cell.late ? `${num((cell.late.sourceRate ?? 0) * 100)}%→${num((cell.late.synRate ?? 0) * 100)}%` : '—'}
          {cell.late && <div className="muted">n={cell.late.sourceN}/{cell.late.synN}</div>}
        </td>
        <td className="small">{cell.late ? `${pct(lateDif)} ${lateCi ? ciText(lateCi) + 'pp' : ''}` : '—'}</td>
        <td className="small">
          {cell.pooled?.pct != null ? pct(cell.pooled.pct) : '不可判定'}
          {cell.pooled?.rangePct && <div className="muted">{pct(cell.pooled.rangePct[0])} ~ {pct(cell.pooled.rangePct[1])}</div>}
          {cell.pooled && cell.pooled.borrowedTypes === 0 && cell.pooled.pct != null && (
            <div className="muted">无可共享类型，等同原始</div>
          )}
        </td>
        <td className="small">{cell.pooled?.shrinkage != null ? `${(cell.pooled.shrinkage * 100).toFixed(0)}%` : '—'}</td>
        <td className="small">
          <span className={`badge ${cell.routeAgreement === 'disagree' ? 'bad' : cell.routeAgreement === 'agree' ? 'ok' : ''}`}>
            {cell.routeAgreement === 'agree' ? '一致' : cell.routeAgreement === 'disagree' ? '相反' : cell.routeAgreement === 'insufficient' ? '证据不足' : '均不可判定'}
          </span>
          {(cell.indeterminateReasons.length > 0 || cell.notes.length > 0) && (
            <button style={{ marginLeft: 6, padding: '1px 8px', fontSize: 11 }} onClick={() => setOpen(!open)}>{open ? '收起' : '详情'}</button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={dims.length + 12} style={{ background: '#fafbfe' }}>
            <div className="small" style={{ lineHeight: 1.7 }}>
              <div><b>路线一致性：</b>{cell.routeAgreementNote}</div>
              {cell.indeterminateReasons.length > 0 && (
                <div><b>不可稳定估计：</b>{cell.indeterminateReasons.join('；')}</div>
              )}
              {cell.notes.length > 0 && <div className="muted"><b>口径说明：</b>{cell.notes.join('；')}</div>}
              {cell.pooled && (
                <div className="muted">
                  <b>R2：</b>本格类型数 {cell.pooled.typesInCell}，可共享类型 {cell.pooled.borrowedTypes}，
                  组先验 {num(cell.pooled.priorLog, 3)}（对数差），τ² {cell.pooled.tau2.toFixed(4)}
                </div>
              )}
              {cell.hierarchical.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <b>按事件类型（未汇聚原始 → 汇聚）：</b>{' '}
                  {cell.hierarchical.map((h) => `${h.eventType}: ${h.rawPct == null ? '支持不足' : pct(h.rawPct)} → ${h.pooledPct == null ? '不借用' : pct(h.pooledPct)}（n ${h.sourceN}/${h.synN}）`).join('；')}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
