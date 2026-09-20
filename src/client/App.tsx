import {useMemo, useState} from 'react';
import {
  FlaskConical,
  Play,
  Ban,
  RefreshCw,
  ChevronRight,
  AlertTriangle,
  Unlink,
  Clock,
} from 'lucide-react';
import {useRunSession} from './useRunSession';
import {resultsForPath} from '../shared/summary';
import {bucketPaths} from '../shared/paths';
import type {DiffOp, SampleResult, TransformFailure} from '../shared/types';

const CATEGORY_LABEL: Record<string, string> = {
  added: '新增',
  removed: '删除',
  type_changed: '类型变化',
  value_changed: '值变化',
};

const STATUS_META: Record<string, {label: string; tone: string}> = {
  running: {label: '运行中', tone: 'running'},
  completed: {label: '已完成', tone: 'done'},
  cancelled: {label: '已取消', tone: 'warn'},
  expired: {label: '会话过期', tone: 'dead'},
};

const CONNECTION_LABEL: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中',
  open: '实时',
  reconnecting: '重连中',
  closed: '已结束',
  expired: '已过期',
};

function JsonView({value}: {value: unknown}) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

function FailureLine({failure}: {failure: TransformFailure}) {
  return (
    <li className="failure">
      <AlertTriangle size={13} />
      <span className={`side-tag ${failure.side}`}>{failure.side === 'left' ? '左' : '右'}</span>
      <code>{failure.path}</code>
      <span>{failure.message}</span>
    </li>
  );
}

function DiffLine({op}: {op: DiffOp}) {
  return (
    <li className={`op ${op.type}`}>
      <span className={`op-type ${op.type}`}>{CATEGORY_LABEL[op.type]}</span>
      <code>{op.path}</code>
      {op.align && (
        <span className={`align-tag ${op.align}`} title="数组对齐方式">
          {op.align === 'key' ? `稳定键${op.stableKey ? `: ${op.stableKey}` : ''}` : '按位置'}
        </span>
      )}
      <span className="op-values">
        {op.type !== 'added' && (
          <>
            <span className="val left">{preview(op.left)}</span>
            {op.type !== 'removed' && <ChevronRight size={12} />}
          </>
        )}
        {op.type !== 'removed' && <span className="val right">{preview(op.right)}</span>}
      </span>
    </li>
  );
}

function preview(value: unknown): string {
  if (value === undefined) return '—';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function SampleCard({
  sampleId,
  sampleLabel,
  result,
  selectedPath,
}: {
  sampleId: string;
  sampleLabel?: string;
  result: SampleResult;
  selectedPath: string;
}) {
  const buckets = new Set(bucketPaths(selectedPath));
  const diffs = result.diffs.filter(op => buckets.has(op.path));
  const failures = result.failures.filter(f => buckets.has(f.path));
  const diagnostics = result.diagnostics.filter(d => buckets.has(d.path));
  const [showPayload, setShowPayload] = useState(false);

  return (
    <article className={`sample-card ${result.status}`}>
      <header>
        <strong>{sampleLabel ?? sampleId}</strong>
        <code>{sampleId}</code>
        <span className={`sample-status ${result.status}`}>
          {result.status === 'failed' ? '转换失败' : '已对比'}
        </span>
        <small>{result.durationMs}ms</small>
      </header>

      {failures.length > 0 && (
        <ul className="failures">{failures.map((f, i) => <FailureLine key={i} failure={f} />)}</ul>
      )}
      {diffs.length > 0 && (
        <ul className="ops">{diffs.map((op, i) => <DiffLine key={i} op={op} />)}</ul>
      )}
      {diagnostics.length > 0 && (
        <ul className="diagnostics">
          {diagnostics.map((d, i) => (
            <li key={i} className={`diag ${d.code}`}>
              <AlertTriangle size={12} />
              {d.side && <span className={`side-tag ${d.side}`}>{d.side === 'left' ? '左' : '右'}</span>}
              <code>{d.path}</code>
              {d.message}
            </li>
          ))}
        </ul>
      )}
      {result.status === 'diffed' && diffs.length === 0 && failures.length === 0 && (
        <p className="muted">该路径下无差异</p>
      )}
      {result.status === 'diffed' && (
        <button className="link-btn" onClick={() => setShowPayload(v => !v)}>
          {showPayload ? '隐藏转换结果' : '查看转换结果'}
        </button>
      )}
      {showPayload && result.status === 'diffed' && (
        <div className="payloads">
          <div>
            <h4>左侧转换结果</h4>
            <JsonView value={result.transformedLeft} />
          </div>
          <div>
            <h4>右侧转换结果</h4>
            <JsonView value={result.transformedRight} />
          </div>
        </div>
      )}
    </article>
  );
}

export default function App() {
  const session = useRunSession();
  const {catalog, state, totals, buckets} = session;
  const [leftRev, setLeftRev] = useState('rev-legacy');
  const [rightRev, setRightRev] = useState('rev-current');

  const run = state.run;
  const sampleLabels = useMemo(() => {
    const map = new Map<string, string>();
    catalog?.samples.forEach(sample => map.set(sample.id, sample.label));
    return map;
  }, [catalog]);

  const sortedBuckets = useMemo(() => {
    return [...buckets.values()].sort((a, b) => {
      const weight = (x: typeof a) =>
        x.added + x.removed + x.typeChanged + x.conversionFailed;
      const diff = weight(b) - weight(a);
      return diff !== 0 ? diff : a.path.localeCompare(b.path);
    });
  }, [buckets]);

  const pathResults = useMemo(() => {
    if (!run || !session.selectedPath) return [];
    return resultsForPath(run.results, session.selectedPath);
  }, [run, session.selectedPath]);

  const failedSamples = useMemo(() => {
    if (!run) return [];
    return Object.values(run.results).filter(r => r.status === 'failed');
  }, [run]);

  const partial = run?.status === 'running';
  const progress = totals ? Math.round((totals.processedSamples / Math.max(totals.totalSamples, 1)) * 100) : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Payload 迁移 Dry-run 审阅台</strong>
        <small>仅审阅 · 不写回外部系统</small>
        <span className="spacer" />
        {catalog && <span className="gen-tag">样例集合 gen {catalog.sampleGeneration}</span>}
        <button className="ghost" onClick={() => void session.refreshCatalog()} title="刷新目录">
          <RefreshCw size={14} />
        </button>
      </header>

      {state.staleGeneration && state.notice && <div className="banner warn">{state.notice}</div>}
      {state.connection === 'reconnecting' && (
        <div className="banner info">
          <Unlink size={14} /> 连接中断，正在重连并从有界缓冲补发事件…
        </div>
      )}
      {state.bufferLost && (
        <div className="banner warn">事件缓冲已滚动，已通过快照恢复完整状态。</div>
      )}
      {state.connection === 'expired' && (
        <div className="banner dead">
          <Clock size={14} /> 会话已过期，运行结果已被服务端清理。请新建一次 dry-run。
        </div>
      )}
      {session.catalogError && <div className="banner dead">目录加载失败：{session.catalogError}</div>}

      <section className="workspace three">
        {/* 左：运行配置 */}
        <aside className="pane config">
          <h2>流水线 Revision</h2>
          <label>
            左侧（基准）
            <select value={leftRev} onChange={e => setLeftRev(e.target.value)}>
              {catalog?.revisions.map(rev => (
                <option key={rev.id} value={rev.id}>
                  {rev.label}
                </option>
              ))}
            </select>
            <small>{catalog?.revisions.find(r => r.id === leftRev)?.description}</small>
          </label>
          <label>
            右侧（候选）
            <select value={rightRev} onChange={e => setRightRev(e.target.value)}>
              {catalog?.revisions.map(rev => (
                <option key={rev.id} value={rev.id}>
                  {rev.label}
                </option>
              ))}
            </select>
            <small>{catalog?.revisions.find(r => r.id === rightRev)?.description}</small>
          </label>

          <div className="actions">
            <button
              className="primary"
              disabled={!catalog || run?.status === 'running' || leftRev === rightRev}
              onClick={() => void session.startRun(leftRev, rightRev)}
            >
              <Play size={15} /> Dry-run 全部样例
            </button>
            {run?.status === 'running' && (
              <button className="danger" onClick={() => void session.cancelRun()}>
                <Ban size={15} /> 取消
              </button>
            )}
          </div>
          {leftRev === rightRev && <p className="muted">请选择两个不同的 revision。</p>}

          <h2>数组对齐配置</h2>
          <ul className="key-config">
            {Object.entries(catalog?.stableKeys ?? {}).map(([path, keys]) => (
              <li key={path}>
                <code>{path}</code>
                <span>稳定键：{keys.join(' / ')}</span>
              </li>
            ))}
            <li className="muted">未列出的数组按位置比较。</li>
          </ul>

          {run && (
            <>
              <h2>运行状态</h2>
              <div className={`run-status ${STATUS_META[run.status].tone}`}>
                {STATUS_META[run.status].label} · {CONNECTION_LABEL[state.connection]}
              </div>
              <div className="progress">
                <div className="bar" style={{width: `${progress}%`}} />
              </div>
              <p className="muted">
                {partial ? '部分统计：' : ''}
                已处理 {totals?.processedSamples ?? 0}/{run.sampleIds.length}
                {run.inFlight.length > 0 && ` · 进行中 ${run.inFlight.length}`}
              </p>
            </>
          )}
        </aside>

        {/* 中：按路径汇总 */}
        <section className="pane summary">
          <h2>按路径汇总</h2>
          {!totals ? (
            <p className="muted">选择两个 revision 后开始 dry-run，结果会增量到达。</p>
          ) : (
            <>
              <div className="totals">
                <div className="metric added"><b>{totals.categories.added}</b><span>新增</span></div>
                <div className="metric removed"><b>{totals.categories.removed}</b><span>删除</span></div>
                <div className="metric type-changed"><b>{totals.categories.type_changed}</b><span>类型变化</span></div>
                <div className="metric failed"><b>{totals.categories.conversion_failed}</b><span>转换失败</span></div>
                <div className="metric"><b>{totals.valueChanged}</b><span>值变化</span></div>
              </div>
              <p className="muted">
                涉及 {totals.diffedSamples} 个对比样例、{totals.failedSamples} 个失败样例
                {totals.diagnosticCount > 0 && `，${totals.diagnosticCount} 条对齐诊断`}
                {partial && '（运行中，统计为部分结果，完成后自动收敛）'}
              </p>

              {failedSamples.length > 0 && (
                <div className="failed-block">
                  <h3><AlertTriangle size={14} /> 转换失败样例</h3>
                  <ul>
                    {failedSamples.map(result => (
                      <li key={result.sampleId}>
                        <button className="link-btn" onClick={() => session.selectPath('$')}>
                          {sampleLabels.get(result.sampleId) ?? result.sampleId}
                        </button>
                        {result.failures.map((f, i) => (
                          <span key={i} className="inline-failure">
                            <span className={`side-tag ${f.side}`}>{f.side === 'left' ? '左' : '右'}</span>
                            {f.message}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <table className="path-table">
                <thead>
                  <tr>
                    <th>路径</th>
                    <th className="num">新增</th>
                    <th className="num">删除</th>
                    <th className="num">类型变化</th>
                    <th className="num">转换失败</th>
                    <th className="num">样例</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBuckets.map(bucket => (
                    <tr
                      key={bucket.path}
                      className={session.selectedPath === bucket.path ? 'selected' : ''}
                      onClick={() => session.selectPath(bucket.path)}
                    >
                      <td className="path-cell">
                        <code>{bucket.path}</code>
                        {bucket.diagnosticCount > 0 && (
                          <span className="diag-badge" title="对齐诊断">
                            ! {bucket.diagnosticCount}
                          </span>
                        )}
                      </td>
                      <td className="num added">{bucket.added || ''}</td>
                      <td className="num removed">{bucket.removed || ''}</td>
                      <td className="num type-changed">{bucket.typeChanged || ''}</td>
                      <td className="num failed">{bucket.conversionFailed || ''}</td>
                      <td className="num muted">{bucket.sampleCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        {/* 右：路径详情（选中路径在后续结果到达时保持不变） */}
        <aside className="pane detail">
          <h2>路径详情</h2>
          {!session.selectedPath ? (
            <p className="muted">从中间汇总表选择一个路径查看样例级差异。</p>
          ) : (
            <>
              <div className="detail-head">
                <code>{session.selectedPath}</code>
                <button className="link-btn" onClick={() => session.selectPath(null)}>
                  清除选择
                </button>
              </div>
              <p className="muted">
                {pathResults.length} 个样例涉及此路径（后续结果到达时保持当前选择）
              </p>
              {pathResults.length === 0 && partial && <p className="muted">等待结果到达…</p>}
              {pathResults.map(result => (
                <SampleCard
                  key={result.sampleId}
                  sampleId={result.sampleId}
                  sampleLabel={sampleLabels.get(result.sampleId)}
                  result={result}
                  selectedPath={session.selectedPath!}
                />
              ))}
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
