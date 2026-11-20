// 条件化偏差分析 Worker：在后台线程执行分层/汇聚计算。
// 运行期间批次若被修订，仍使用运行启动快照里的 batchKey 与源行做版本一致性判定。

import { analyzeConditionalBias } from '../domain/conditional';
import type { ConditionalReport } from '../domain/conditional';
import type { RuleSet, TableRows } from '../domain/types';

export interface ConditionalWorkerPayload {
  syn: TableRows;
  src: TableRows;
  ruleSet: RuleSet;
  sourceBatchKey: string;
  synthBatchKey: string;
  synthRunId: string;
  runFileHashes?: Record<string, string>;
  sourceFileHashes?: Record<string, string>;
  sourceRevision?: number;
  latestRevision?: number;
  config?: Parameters<typeof analyzeConditionalBias>[0]['config'];
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== 'conditional') return;
  try {
    const result: Omit<ConditionalReport, 'id' | 'createdAt'> = await analyzeConditionalBias(msg.payload as ConditionalWorkerPayload);
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
