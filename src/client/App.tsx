import {useEffect, useRef, useState} from 'react';
import {FlaskConical, Play, RefreshCw, Square} from 'lucide-react';
import type {DryrunEvent, RevisionInfo, SampleResult, SampleSetInfo, SessionStatus, SessionView, SummaryRow} from '../shared/types';

interface Bootstrap {
  revisions: RevisionInfo[];
  sampleSets: SampleSetInfo[];
}

interface RunState {
  sessionId: string;
  status: SessionStatus | 'expired';
  total: number;
  completed: number;
  summary: SummaryRow[];
  samples: Map<string, SampleResult>;
  fromRevision: string;
  toRevision: string;
  sampleSetId: string;
  sampleSetVersion: number;
  maxConcurrency: number;
}

const emptyRun = (view: SessionView): RunState => ({
  sessionId: view.id,
  status: view.status,
  total: view.total,
  completed: view.completed,
  summary: view.summary,
  samples: new Map(),
  fromRevision: view.fromRevision,
  toRevision: view.toRevision,
  sampleSetId: view.sampleSetId,
  sampleSetVersion: view.sampleSetVersion,
  maxConcurrency: view.stats.maxConcurrency,
});

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({revisions: [], sampleSets: []});
  const [fromRevision, setFromRevision] = useState('rev-1');
  const [toRevision, setToRevision] = useState('rev-2');
  const [sampleSetId, setSampleSetId] = useState('orders');
  const [run, setRun] = useState<RunState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Generation guard: bumped on start/cancel so late events from a previous run are dropped.
  const generation = useRef(0);
  const stream = useRef<EventSource | null>(null);

  const loadBootstrap = () => {
    fetch('/api/bootstrap')
      .then((res) => res.json())
      .then((data: Bootstrap & {count: number}) => setBootstrap({revisions: data.revisions, sampleSets: data.sampleSets}))
      .catch(() => setNotice('无法加载配置'));
  };
  useEffect(loadBootstrap, []);

  const closeStream = () => {
    stream.current?.close();
    stream.current = null;
  };

  const stale = (gen: number) => gen !== generation.current;

  const applyEvent = (gen: number, event: DryrunEvent) => {
    if (stale(gen)) return;
    if (event.type === 'snapshot') {
      setRun({
        ...emptyRun(event.session),
        samples: new Map(event.samples.map((sample) => [sample.sampleId, sample])),
      });
      return;
    }
    setRun((current) => {
      if (!current || stale(gen)) return current;
      switch (event.type) {
        case 'started':
          return {...current, total: event.total};
        case 'sample': {
          const samples = new Map(current.samples);
          samples.set(event.sample.sampleId, event.sample);
          return {...current, samples, completed: event.completed, total: event.total};
        }
        case 'summary':
          return {...current, summary: event.summary, completed: event.completed, total: event.total};
        case 'done':
          return {...current, status: 'done', completed: event.completed, maxConcurrency: event.stats.maxConcurrency};
        case 'cancelled':
          return {...current, status: 'cancelled', completed: event.completed};
        default:
          return current;
      }
    });
  };

  const markExpiredIfGone = async (gen: number, sessionId: string) => {
    try {
      const res = await fetch(`/api/dryrun/sessions/${sessionId}`);
      if (stale(gen)) return;
      if (res.status === 410) {
        setRun((current) => (current ? {...current, status: 'expired'} : current));
        setNotice('会话已过期，统计结果不再可用');
        closeStream();
      }
    } catch {
      /* network blip: EventSource keeps retrying */
    }
  };

  const openStream = (gen: number, sessionId: string) => {
    const source = new EventSource(`/api/dryrun/sessions/${sessionId}/events`);
    stream.current = source;
    for (const type of ['started', 'sample', 'summary', 'done', 'cancelled', 'snapshot'] as const) {
      source.addEventListener(type, (message) => {
        if (stale(gen)) return;
        const event = JSON.parse((message as MessageEvent).data) as DryrunEvent;
        applyEvent(gen, event);
        if (event.type === 'done' || event.type === 'cancelled') closeStream();
      });
    }
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) void markExpiredIfGone(gen, sessionId);
      // Otherwise the browser reconnects automatically with Last-Event-ID; the server replays
      // missed events (or a snapshot if its bounded buffer evicted them).
    };
  };

  const start = async () => {
    generation.current += 1;
    const gen = generation.current;
    closeStream();
    setNotice(null);
    setRun(null);
    const res = await fetch('/api/dryrun/sessions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({fromRevision, toRevision, sampleSetId}),
    });
    if (stale(gen)) return;
    if (!res.ok) {
      setNotice(`启动失败: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
      return;
    }
    const view = (await res.json()) as SessionView;
    setRun(emptyRun(view));
    openStream(gen, view.id);
  };

  const cancel = async () => {
    if (!run) return;
    const sessionId = run.sessionId;
    generation.current += 1; // reject late results from this run
    closeStream();
    setRun((current) => (current ? {...current, status: 'cancelled'} : current));
    await fetch(`/api/dryrun/sessions/${sessionId}/cancel`, {method: 'POST'}).catch(() => undefined);
  };

  const currentSet = bootstrap.sampleSets.find((set) => set.id === (run?.sampleSetId ?? sampleSetId));
  const setUpdated = run !== null && currentSet !== undefined && currentSet.version !== run.sampleSetVersion;
  const partial = run !== null && run.status === 'running';
  const detailEntries =
    run && selectedPath
      ? [...run.samples.values()].flatMap((sample) =>
          sample.entries
            .filter((entry) => entry.group === selectedPath)
            .map((entry) => ({sampleId: sample.sampleId, entry})),
        )
      : [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Payload Migration Workbench</strong>
        <small>dry-run only · 不写回外部系统</small>
      </header>
      <section className="controls">
        <label>
          From
          <select value={fromRevision} onChange={(event) => setFromRevision(event.target.value)} disabled={partial}>
            {bootstrap.revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select value={toRevision} onChange={(event) => setToRevision(event.target.value)} disabled={partial}>
            {bootstrap.revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          样例集合
          <select value={sampleSetId} onChange={(event) => setSampleSetId(event.target.value)} disabled={partial}>
            {bootstrap.sampleSets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.id} · v{set.version} · {set.count} 样例
              </option>
            ))}
          </select>
        </label>
        {partial ? (
          <button className="danger" onClick={cancel}>
            <Square size={14} /> 取消
          </button>
        ) : (
          <button className="primary" onClick={start}>
            <Play size={14} /> 开始 dry-run
          </button>
        )}
        <button onClick={loadBootstrap} title="刷新配置">
          <RefreshCw size={14} />
        </button>
        {run && (
          <span className="progress">
            {run.completed}/{run.total}
            {partial && <em className="partial-badge">部分统计 PARTIAL</em>}
            {run.status === 'done' && <em className="ok-badge">完成 · 峰值并发 {run.maxConcurrency}</em>}
            {run.status === 'cancelled' && <em className="warn-badge">已取消（迟到结果已丢弃）</em>}
            {run.status === 'expired' && <em className="warn-badge">会话已过期</em>}
          </span>
        )}
        {notice && <span className="notice">{notice}</span>}
        {setUpdated && currentSet && (
          <span className="notice">
            样例集合已更新到 v{currentSet.version}，本次运行基于 v{run.sampleSetVersion} 快照
          </span>
        )}
      </section>
      <section className="workspace">
        <section className="pane">
          <h2>按路径汇总 {partial && <span className="pill">部分统计</span>}</h2>
          {!run && <p className="muted">选择两个 revision 后开始 dry-run。</p>}
          {run && run.summary.length === 0 && <p className="muted">{partial ? '等待首批样例结果…' : '无差异'}</p>}
          {run && run.summary.length > 0 && (
            <table className="summary">
              <thead>
                <tr>
                  <th>路径</th>
                  <th>新增</th>
                  <th>删除</th>
                  <th>类型变化</th>
                  <th>值变化</th>
                  <th>转换失败</th>
                  <th>样例数</th>
                </tr>
              </thead>
              <tbody>
                {run.summary.map((row) => (
                  <tr
                    key={row.path}
                    className={row.path === selectedPath ? 'active' : ''}
                    onClick={() => setSelectedPath(row.path)}
                  >
                    <td className="path">{row.path}</td>
                    <td>{row.added || ''}</td>
                    <td>{row.removed || ''}</td>
                    <td>{row.typeChanged || ''}</td>
                    <td>{row.valueChanged || ''}</td>
                    <td className={row.conversionFailed ? 'failed' : ''}>{row.conversionFailed || ''}</td>
                    <td>{row.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside className="pane">
          <h2>样例详情 {selectedPath && <span className="pill">{selectedPath}</span>}</h2>
          {!selectedPath && <p className="muted">在汇总表中选择路径查看各样例差异。运行期间选择会保持。</p>}
          {selectedPath && detailEntries.length === 0 && (
            <p className="muted">{partial ? '该路径暂无结果，后续样例到达后会自动补充。' : '该路径无差异条目。'}</p>
          )}
          {detailEntries.length > 0 && (
            <table className="details">
              <thead>
                <tr>
                  <th>样例</th>
                  <th>类型</th>
                  <th>侧</th>
                  <th>路径</th>
                  <th>前 → 后</th>
                </tr>
              </thead>
              <tbody>
                {detailEntries.map(({sampleId, entry}, index) => (
                  <tr key={`${sampleId}:${entry.path}:${index}`}>
                    <td>{sampleId}</td>
                    <td>
                      <span className={`kind kind-${entry.kind}`}>{entry.kind}</span>
                    </td>
                    <td>{entry.side ?? ''}</td>
                    <td className="path">{entry.path}</td>
                    <td className="values">
                      {entry.kind === 'conversion_failed'
                        ? entry.message
                        : `${formatValue(entry.before)} → ${formatValue(entry.after)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </aside>
      </section>
    </main>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  const text = JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}
