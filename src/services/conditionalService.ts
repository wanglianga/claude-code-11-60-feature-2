// 条件化偏差分析编排：校验运行与来源批次一致性 -> WebWorker 计算 -> 报告落库。
// 只读：不修改任何生成数据、方案或批次。

import { db } from '../db/db';
import type { ConditionalReport } from '../domain/conditional';
import type { Run, TableRows, BatchMeta } from '../domain/types';
import { getRunOutput } from './runService';

export interface ConditionalRunResult {
  ok: true;
  report: ConditionalReport;
}
export type ConditionalRunOutcome = ConditionalRunResult | { ok: false; error: string };

/** 分析某次已完成运行；来源批次默认为该运行启动快照中的 batchKey */
export async function startConditionalAnalysis(runId: string): Promise<ConditionalRunOutcome> {
  const run = await db.runs.get(runId);
  if (!run) return { ok: false, error: '运行不存在' };
  if (run.status !== 'done') return { ok: false, error: '运行尚未完成' };
  const syn = await getRunOutput(runId);
  if (!syn) return { ok: false, error: '运行输出缺失' };

  const sourceBatch = await db.batches.get(run.batchKey);
  const src = (await db.batchRows.get(run.batchKey))?.tables;
  if (!sourceBatch || !src) return { ok: false, error: `来源批次 ${run.batchKey} 缺失，无法比较` };
  const sourceFileHashes: Record<string, string> = {};
  for (const f of sourceBatch.files) sourceFileHashes[f.name] = f.sha256;
  const siblings = await db.batches.where('batchId').equals(sourceBatch.batchId).toArray();
  const latestRevision = siblings.length ? Math.max(...siblings.map((b) => b.revision)) : sourceBatch.revision;

  try {
    const body = await runConditionalWorker(run, syn, src, sourceBatch, {
      sourceFileHashes,
      sourceRevision: sourceBatch.revision,
      latestRevision
    });
    const report: ConditionalReport = {
      ...body,
      id: `CND-${String(run.seq).padStart(4, '0')}`,
      runId: run.id,
      createdAt: new Date().toISOString()
    };
    await db.conditionalReports.put(report);
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function runConditionalWorker(
  run: Run,
  syn: TableRows,
  src: TableRows,
  sourceBatch: BatchMeta,
  extra: { sourceFileHashes: Record<string, string>; sourceRevision: number; latestRevision: number }
): Promise<Omit<ConditionalReport, 'id' | 'createdAt'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/conditional.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('条件化分析超时（180s）')); }, 180_000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg.result); }
      else if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(msg.error)); }
    };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({
      type: 'conditional',
      payload: {
        syn,
        src,
        ruleSet: run.ruleSetSnapshot,
        // 来源侧用批次登记键；合成侧用运行启动快照中的批次键（版本一致性守卫的依据）
        sourceBatchKey: sourceBatch.key,
        synthBatchKey: run.batchKey,
        synthRunId: run.id,
        runFileHashes: run.batchFileHashes,
        sourceFileHashes: extra.sourceFileHashes,
        sourceRevision: extra.sourceRevision,
        latestRevision: extra.latestRevision
      }
    });
  });
}
