// Game views: terminal, editor, dashboard, CI, database, monitoring, cloud, costs, postmortems.
import React, { useEffect, useRef, useState } from 'react';
import { api, GameView, FsEntry, OutLine, SqlResult } from './lib/api';
import { MetricCard, Spark, highlight } from './lib/ui';

type Refresh = () => void;

// =====================================================================
// TERMINAL
// =====================================================================
export function Terminal({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [lines, setLines] = useState<OutLine[]>([
    { text: 'SHIP IT secure shell — your laptop (local). Everything you run here executes inside the simulated world only.', cls: 'dim' },
    { text: 'Hint: read handoff.txt, then ssh into the company server. Recall commands with ↑/↓.', cls: 'dim' },
    { text: '(scrollback from a previous session is not kept — the world state is)', cls: 'dim' },
    { text: '' }
  ]);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<string[]>([]);

  useEffect(() => { outRef.current?.scrollTo(0, outRef.current.scrollHeight); }, [lines]);
  useEffect(() => { inRef.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    const cmd = input;
    if (!cmd.trim() && !view.session.pending) return;
    setInput('');
    setHistIdx(-1);
    if (cmd.trim()) histRef.current.push(cmd);
    setBusy(true);
    try {
      const res = await api.terminal(game, cmd);
      const newLines: OutLine[] = [];
      if (!view.session.pending) newLines.push({ text: `${view.session.prompt} ${cmd}`, cls: 'dim' });
      for (const l of res.lines) {
        if (l.text === '__CLEAR__') { setLines([]); setBusy(false); inRef.current?.focus(); return; }
        newLines.push(l);
      }
      if (!newLines.length) newLines.push({ text: `${view.session.prompt} ${cmd}`, cls: 'dim' });
      setLines((prev) => [...prev, ...newLines]);
      refresh();
    } catch (e) {
      setLines((prev) => [...prev, { text: String(e), cls: 'err' }]);
    }
    setBusy(false);
    inRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const h = histRef.current;
      if (!h.length) return;
      const next = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(h[next]);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const h = histRef.current;
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= h.length) { setHistIdx(-1); setInput(''); } else { setHistIdx(next); setInput(h[next]); }
    }
  };

  return (
    <div className="term" onClick={() => inRef.current?.focus()}>
      <div className="term-out" ref={outRef}>
        {lines.map((l, i) => <div key={i} className={l.cls ?? ''}>{l.text}</div>)}
      </div>
      <div className="term-in">
        <span className="prompt">{view.session.pending ? 'password:' : `${view.session.prompt}`}</span>
        <input
          ref={inRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

// =====================================================================
// EDITOR
// =====================================================================
const TREE_ROOTS = ['/opt/app', '/etc/systemd/system', '/etc/nginx/sites-enabled', '/etc/logrotate.d'];

function langFor(path: string): string {
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.includes('Dockerfile')) return 'dockerfile';
  if (path.endsWith('.js')) return 'js';
  return 'conf';
}

export function Editor({ game, refresh }: { game: string; refresh: Refresh }) {
  const [trees, setTrees] = useState<Record<string, FsEntry[] | null>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [orig, setOrig] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    for (const root of TREE_ROOTS) {
      api.fs(game, root).then((r) => setTrees((t) => ({ ...t, [root]: r.entries })));
    }
  }, [game]);

  const open = async (path: string) => {
    const f = await api.readFile(game, path);
    setSel(path);
    setContent(f.content);
    setOrig(f.content);
    setWarnings([]);
    setSaved(false);
  };

  const save = async () => {
    if (!sel) return;
    const r = await api.writeFile(game, sel, content);
    setWarnings(r.warnings ?? []);
    setOrig(content);
    setSaved(true);
    refresh();
  };

  const lineCount = content.split('\n').length;

  return (
    <div className="editor-wrap">
      <div className="filetree">
        <div className="dimtxt" style={{ padding: '4px 6px' }}>web-01 filesystem</div>
        {TREE_ROOTS.map((root) => (
          <div key={root}>
            <div className="dir">▸ {root}</div>
            {(trees[root] ?? []).map((e) => (
              <div key={e.name} className={`file ${sel === `${root}/${e.name}` ? 'sel' : ''}`} onClick={() => open(`${root}/${e.name}`)}>
                <span>{e.type === 'dir' ? '▸' : '·'} {e.name}</span>
                <span className="meta">{e.owner}:{e.mode}</span>
              </div>
            ))}
            {trees[root] === null ? <div className="dimtxt" style={{ padding: '2px 18px' }}>(not present yet)</div> : null}
          </div>
        ))}
        <div className="dimtxt" style={{ padding: '10px 6px', lineHeight: 1.5 }}>
          Create new files (e.g. .env, .gitignore, Dockerfile, configs) with the terminal:<br />
          <code style={{ color: 'var(--green)' }}>touch /opt/app/Dockerfile</code> — then reload this tab.
        </div>
      </div>
      <div className="code-area">
        <div className="code-head">
          <span>{sel ?? 'select a file'}</span>
          {sel && content !== orig && <span style={{ color: 'var(--yellow)' }}>● modified</span>}
          {saved && content === orig && <span style={{ color: 'var(--green)' }}>saved</span>}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="primary" disabled={!sel || content === orig} onClick={save}>SAVE</button>
        </div>
        <div className="code-body">
          <div className="code-gutter">
            {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setSaved(false); }}
            spellCheck={false}
            placeholder={sel ? '' : 'Open a file from the tree on the left.'}
          />
        </div>
        {warnings.length > 0 && (
          <div className="warnings" style={{ padding: '0 12px 10px' }}>
            {warnings.map((w, i) => <div key={i} className="warnbox">⚠ {w}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// DASHBOARD (architecture map + KPIs + audit)
// =====================================================================
const TIER_X = [80, 240, 400, 560, 720, 880, 1040];

export function Dashboard({ view }: { view: GameView }) {
  const [sel, setSel] = useState<string | null>(null);
  const nodes = view.architecture.nodes;
  const byTier: Record<number, typeof nodes> = {};
  for (const n of nodes) {
    const tier = Math.round(n.tier);
    (byTier[tier] ??= []).push(n);
  }
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [tier, list] of Object.entries(byTier)) {
    list.forEach((n, i) => {
      pos[n.id] = { x: TIER_X[Math.min(Number(tier), TIER_X.length - 1)] ?? 1200, y: 40 + i * 78 };
    });
  }
  const maxRows = Math.max(...Object.values(byTier).map((l) => l.length));
  const H = Math.max(240, maxRows * 78 + 40);
  const W = 1200;
  const selNode = nodes.find((n) => n.id === sel);

  const m = view.metrics.latest;
  const s = view.metrics.series;

  return (
    <div>
      <div className="grid3" style={{ marginBottom: 14 }}>
        <MetricCard label="Req/s" value={m.req_rate ?? 0} series={s.req_rate} />
        <MetricCard label="Error %" value={m.error_pct ?? 0} unit="%" series={s.error_pct} warnAt={2} badAt={5} color="#f4635e" />
        <MetricCard label="P95 latency" value={m.p95_ms ?? 0} unit="ms" series={s.p95_ms} warnAt={400} badAt={1200} />
        <MetricCard label="CPU" value={m.cpu_pct ?? 0} unit="%" series={s.cpu_pct} warnAt={70} badAt={90} color="#e3b341" />
        <MetricCard label="Disk" value={m.disk_pct ?? 0} unit="%" series={s.disk_pct} warnAt={80} badAt={92} color="#f0883e" />
        <MetricCard label={view.db.provisioned ? 'DB CPU' : 'DB (sqlite)'} value={view.db.provisioned ? (m.db_cpu_pct ?? 0) : 'local file'} unit={view.db.provisioned ? '%' : ''} series={s.db_cpu_pct} warnAt={75} badAt={90} color="#bc8cff" />
      </div>

      <div className="panel">
        <h2>Architecture <span className="hintInline">click a node to inspect</span></h2>
        <svg className="archsvg" viewBox={`0 0 ${W} ${H}`} style={{ height: H }}>
          {view.architecture.edges.map(([a, b], i) => {
            const pa = pos[a]; const pb = pos[b];
            if (!pa || !pb) return null;
            return <path key={i} d={`M${pa.x + 110},${pa.y + 24} C ${pa.x + 150},${pa.y + 24} ${pb.x - 40},${pb.y + 24} ${pb.x},${pb.y + 24}`} fill="none" stroke="#2a3442" strokeWidth="1.4" markerEnd="url(#arrow)" />;
          })}
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8" fill="none" stroke="#2a3442" strokeWidth="1.2" />
            </marker>
          </defs>
          {nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const sub = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
            return (
              <g key={n.id} className={`arch-node st-${n.status} ${sel === n.id ? 'sel' : ''}`} onClick={() => setSel(n.id)}>
                <rect x={p.x} y={p.y} width={112} height={48} rx={8} />
                <text x={p.x + 56} y={p.y + 21} textAnchor="middle">{sub.split(' ')[0]}</text>
                <text x={p.x + 56} y={p.y + 36} textAnchor="middle" className="sub">{sub.split(' ').slice(1).join(' ') || n.kind}</text>
              </g>
            );
          })}
        </svg>
        {selNode && (
          <div className="detail-panel" style={{ marginTop: 10 }}>
            <b style={{ color: 'var(--blue)' }}>{selNode.label}</b> <span className={`pill ${selNode.status === 'ok' ? 'ok' : selNode.status === 'warn' ? 'warn' : 'err'}`}>{selNode.status}</span>
            <div style={{ marginTop: 6 }}>{selNode.detail}</div>
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Audit log <span className="hintInline">everything that happened, most recent first</span></h2>
          <div className="auditview" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {view.audit.map((a, i) => (
              <div key={i}>
                <span className="t">d{Math.floor(a.t / 1440) + 1} {String(Math.floor((a.t % 1440) / 60)).padStart(2, '0')}:{String(a.t % 60).padStart(2, '0')}</span>
                <span className="who">{a.actor}</span>
                <span className="kind">[{a.kind}]</span>
                {a.text}
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Company</h2>
          <table className="list">
            <tbody>
              <tr><td>Users</td><td>{Math.round(view.company.users).toLocaleString()}</td></tr>
              <tr><td>Satisfaction</td><td>{view.company.satisfaction.toFixed(2)} / 5</td></tr>
              <tr><td>Uptime (30d window)</td><td>{view.company.uptime.toFixed(2)}%</td></tr>
              <tr><td>Cash</td><td>${Math.round(view.company.cash).toLocaleString()}</td></tr>
              <tr><td>Infra cost</td><td>${view.company.monthlyInfra.toLocaleString()}/mo</td></tr>
              <tr><td>Payroll</td><td>${view.costs.payroll.toLocaleString()}/mo</td></tr>
              <tr><td>Skills XP</td><td>{view.xp} total</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// CI / CD
// =====================================================================
export function CiView({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(view.ci.runs[0]?.id ?? null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.ciRun(game, '.ci/pipeline.yml');
      setOpenRun(r.run.id);
    } catch (e) { alert(String(e)); }
    setBusy(false);
    refresh();
  };
  const rollback = async (depId: string) => {
    const r = await api.rollback(game, depId);
    alert(r.message);
    refresh();
  };
  return (
    <div>
      <div className="panel">
        <h2>Pipeline <span className="hintInline">.ci/pipeline.yml in the repo — write it in the EDITOR, commit with git, then run</span></h2>
        <div className="row">
          <button className="primary" onClick={run} disabled={busy}>{busy ? 'running…' : '▶ RUN PIPELINE'}</button>
          <span className="dimtxt">
            {view.git
              ? `repo: ${view.git.branch} @ ${view.git.commits} commits ${view.git.dirty ? `(dirty: ${view.git.dirty})` : '(clean)'} ${view.git.conflicts.length ? `⚠ conflicts: ${view.git.conflicts.join(', ')}` : ''}`
              : 'no repository — init one in the terminal (git init in /opt/app)'}
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Runs</h2>
        {view.ci.runs.length === 0 ? <div className="dimtxt">No runs yet.</div> : null}
        {view.ci.runs.map((r) => (
          <div key={r.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
              <span className={`pill ${r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'warn'}`}>{r.status}</span>
              <b>{r.id}</b>
              <span className="dimtxt">{r.pipelinePath} · day {Math.floor(r.startedAtMin / 1440) + 1} · {r.commitSha.slice(0, 7)}</span>
            </div>
            {openRun === r.id && (
              <div style={{ margin: '8px 0 0 16px' }}>
                {r.stages.map((st, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div>
                      <span className={st.status === 'success' ? 'stage-ok' : st.status === 'failed' ? 'stage-fail' : 'stage-skip'}>
                        {st.status === 'success' ? '✓' : st.status === 'failed' ? '✗' : '–'} {st.name}
                      </span>
                    </div>
                    {st.log.length > 0 && <div className="logview">{st.log.join('\n')}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Deployments</h2>
        <table className="list">
          <thead><tr><th>image</th><th>service</th><th>source</th><th>state</th><th></th></tr></thead>
          <tbody>
            {view.ci.deployments.map((d) => (
              <tr key={d.id}>
                <td>{d.image}</td>
                <td>{d.service}</td>
                <td>{d.source}</td>
                <td>{d.active ? <span className="pill ok">ACTIVE</span> : <span className="dimtxt">previous</span>}</td>
                <td>{d.active ? <button onClick={() => rollback(d.id)}>↩ Roll back</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.ci.deployments.length === 0 ? <div className="dimtxt">No deployments yet.</div> : null}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Images (local)</h2>
          {view.docker.images.map((i) => (
            <div key={i.tag} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>{i.tag}</span>
              <span className="dimtxt">{i.sizeMB}MB · user={i.user} {i.healthcheck ? '· healthcheck ✓' : ''}</span>
            </div>
          ))}
          {view.docker.images.length === 0 ? <div className="dimtxt">Nothing built yet.</div> : null}
        </div>
        <div className="panel">
          <h2>Registry (registry.acme.dev)</h2>
          {view.docker.registry.map((i) => (
            <div key={i.tag} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>{i.tag}</span>
              <span className="dimtxt">{i.sizeMB}MB</span>
            </div>
          ))}
          {view.docker.registry.length === 0 ? <div className="dimtxt">Nothing pushed yet. (docker push after docker build)</div> : null}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// DATABASE
// =====================================================================
export function DbView({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [sql, setSql] = useState("EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid';");
  const [result, setResult] = useState<SqlResult | null>(null);
  const [migLines, setMigLines] = useState<OutLine[]>([]);

  const query = async () => {
    const r = await api.dbQuery(game, sql);
    setResult(r);
  };
  const migrate = async () => {
    const r = await api.dbMigrate(game);
    setMigLines(r.lines ?? []);
    refresh();
  };

  return (
    <div>
      <div className="panel">
        <h2>Managed database</h2>
        {view.db.provisioned ? (
          <div className="row" style={{ gap: 20 }}>
            <span className="pill ok">{view.db.plan}</span>
            <span>{view.db.endpoint}</span>
            <span className="dimtxt">CPU {view.db.cpu}% · conns {view.db.connections}</span>
            <span className={`pill ${view.db.migrationsDone ? 'ok' : 'warn'}`}>{view.db.migrationsDone ? 'schema migrated' : 'migrations pending'}</span>
          </div>
        ) : (
          <div className="dimtxt">No managed database. Provision one in the CLOUD tab. The app currently uses a local sqlite file on web-01.</div>
        )}
        {view.db.provisioned && !view.db.migrationsDone && (
          <div style={{ marginTop: 10 }}>
            <button className="primary" onClick={migrate}>RUN MIGRATIONS</button>
          </div>
        )}
        {migLines.length > 0 && <div className="logview" style={{ marginTop: 10 }}>{migLines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}</div>}
        {view.db.tables.length > 0 && (
          <table className="list" style={{ marginTop: 12 }}>
            <thead><tr><th>table</th><th>rows</th><th>indexes</th></tr></thead>
            <tbody>
              {view.db.tables.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.rows.toLocaleString()}</td>
                  <td className="dimtxt">{t.indexes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>SQL console <span className="hintInline">psql against the managed database</span></h2>
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} style={{ width: '100%', minHeight: 70, fontFamily: 'inherit' }} spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={query} disabled={!view.db.provisioned}>▶ RUN</button>
          <button onClick={() => setSql("EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid';")}>EXPLAIN orders</button>
          <button onClick={() => setSql('SELECT id, email, plan FROM users LIMIT 10;')}>SELECT users</button>
        </div>
        {result && (
          <div style={{ marginTop: 10 }}>
            {result.error ? <div className="stage-fail">{result.error}</div> : (
              <>
                {result.columns.length > 0 && (
                  <table className="list">
                    <thead><tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.slice(0, 30).map((r, i) => (
                        <tr key={i}>{r.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {result.notice && <div className="dimtxt" style={{ marginTop: 6 }}>{result.notice}</div>}
                {result.commandTag && <div className="dimtxt" style={{ marginTop: 6 }}>{result.commandTag}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// MONITORING
// =====================================================================
export function Monitoring({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [metric, setMetric] = useState('error_pct');
  const [threshold, setThreshold] = useState('2');
  const s = view.metrics.series;
  const m = view.metrics.latest;

  const add = async () => {
    await api.addAlert(game, metric, '>', Number(threshold));
    refresh();
  };
  const del = async (id: string) => {
    await api.delAlert(game, id);
    refresh();
  };

  const Chart = ({ title, points, color, unit }: { title: string; points: number[]; color: string; unit?: string }) => (
    <div className="panel">
      <h2>{title} <span className="hintInline">latest: {(points.at(-1) ?? 0).toFixed(1)}{unit}</span></h2>
      <svg viewBox="0 0 600 120" style={{ width: '100%', background: '#0a0e14', borderRadius: 8 }}>
        {points.length > 1 ? (() => {
          const min = Math.min(...points, 0);
          const max = Math.max(...points, 0.001);
          const span = max - min || 1;
          const step = 600 / (points.length - 1);
          const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(116 - ((v - min) / span) * 108).toFixed(1)}`).join(' ');
          return <path d={path} fill="none" stroke={color} strokeWidth="1.8" />;
        })() : <text x={300} y={60} textAnchor="middle" fill="#7d8b9e" fontSize={12}>waiting for data…</text>}
      </svg>
    </div>
  );

  return (
    <div>
      {!view.agentInstalled ? (
        <div className="panel">
          <h2>No observability agent</h2>
          <div className="dimtxt">Install the agent in the CLOUD tab to start collecting metrics from web-01.</div>
        </div>
      ) : null}
      <div className="grid2">
        <Chart title="Error rate %" points={s.error_pct ?? []} color="#f4635e" unit="%" />
        <Chart title="P95 latency ms" points={s.p95_ms ?? []} color="#58a6ff" unit="ms" />
        <Chart title="CPU %" points={s.cpu_pct ?? []} color="#e3b341" unit="%" />
        <Chart title="DB CPU %" points={s.db_cpu_pct ?? []} color="#bc8cff" unit="%" />
        <Chart title="Disk %" points={s.disk_pct ?? []} color="#f0883e" unit="%" />
        <Chart title="Requests/s" points={s.req_rate ?? []} color="#3fb970" />
      </div>

      <div className="panel">
        <h2>Alert rules</h2>
        <div className="row">
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="error_pct">error_pct</option>
            <option value="cpu_pct">cpu_pct</option>
            <option value="mem_pct">mem_pct</option>
            <option value="disk_pct">disk_pct</option>
            <option value="db_cpu_pct">db_cpu_pct</option>
            <option value="p95_ms">p95_ms</option>
          </select>
          <span>&gt;</span>
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 80 }} />
          <button className="primary" onClick={add}>+ ADD RULE</button>
        </div>
        <table className="list" style={{ marginTop: 10 }}>
          <thead><tr><th>metric</th><th>condition</th><th>state</th><th></th></tr></thead>
          <tbody>
            {view.alerts.map((a) => (
              <tr key={a.id}>
                <td>{a.metric}</td>
                <td>{a.op} {a.threshold}</td>
                <td><span className={`pill ${a.state === 'firing' ? 'err' : a.state === 'pending' ? 'warn' : 'ok'}`}>{a.state}</span></td>
                <td><button onClick={() => del(a.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.alerts.length === 0 ? <div className="dimtxt" style={{ marginTop: 6 }}>No rules — you are flying blind.</div> : null}
        <div className="dimtxt" style={{ marginTop: 8 }}>Latest: error {(m.error_pct ?? 0).toFixed(1)}% · cpu {(m.cpu_pct ?? 0).toFixed(0)}% · disk {(m.disk_pct ?? 0).toFixed(0)}%</div>
      </div>
    </div>
  );
}

// =====================================================================
// CLOUD CONSOLE
// =====================================================================
export function Cloud({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [dnsName, setDnsName] = useState('api');
  const [dnsValue, setDnsValue] = useState('203.0.113.10');
  const [fwPort, setFwPort] = useState('80');
  const [msg, setMsg] = useState('');

  const say = (m: string) => { setMsg(m); refresh(); };

  return (
    <div>
      {msg && <div className="panel" style={{ borderColor: 'var(--green)' }}><span style={{ color: 'var(--green)' }}>✓ {msg}</span></div>}
      <div className="grid2">
        <div className="panel">
          <h2>DNS — zone {view.dns.zone}</h2>
          <table className="list">
            <thead><tr><th>name</th><th>type</th><th>value</th><th>ttl</th></tr></thead>
            <tbody>
              {view.dns.records.map((r) => (
                <tr key={r.name}><td>{r.name}</td><td>{r.type}</td><td>{r.value}</td><td>{r.ttl}</td></tr>
              ))}
            </tbody>
          </table>
          {view.dns.records.length === 0 ? <div className="dimtxt">No records yet.</div> : null}
          <div className="row" style={{ marginTop: 10 }}>
            <input value={dnsName} onChange={(e) => setDnsName(e.target.value)} style={{ width: 140 }} placeholder="name" />
            <select defaultValue="A"><option>A</option><option>CNAME</option></select>
            <span>→</span>
            <input value={dnsValue} onChange={(e) => setDnsValue(e.target.value)} style={{ width: 140 }} placeholder="203.0.113.10" />
            <button className="primary" onClick={async () => { const r = await api.cloudDns(game, dnsName, 'A', dnsValue, 300); say(r.message); }}>ADD RECORD</button>
          </div>
        </div>

        <div className="panel">
          <h2>Firewall</h2>
          <div className="dimtxt">Status: {view.firewall.enabled ? 'active' : 'inactive'} — allowed ports: {view.firewall.allowedPorts.join(', ')}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <input value={fwPort} onChange={(e) => setFwPort(e.target.value)} style={{ width: 90 }} />
            <button className="primary" onClick={async () => { await api.cloudFw(game, Number(fwPort)); say(`port ${fwPort}/tcp allowed`); }}>ALLOW PORT</button>
          </div>
        </div>

        <div className="panel">
          <h2>Compute — virtual machines</h2>
          {view.vms.map((vm) => (
            <div key={vm.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #202938' }}>
              <span><b>{vm.id}</b> <span className="dimtxt">{vm.ip}</span></span>
              <span className="row">
                <span className={`pill ${vm.serving ? 'ok' : 'warn'}`}>{vm.serving ? 'serving API' : 'not serving'}</span>
                {vm.id !== 'web-01' && (
                  <button
                    disabled={view.registryTags.length === 0}
                    onClick={async () => { const r = await api.cloudVmDeploy(game, vm.id); say(r.message); }}
                  >Deploy latest image</button>
                )}
              </span>
            </div>
          ))}
          {!view.vms.some((v) => v.id === 'vm-02') && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={async () => { const r = await api.cloudVm(game); say(r.message); }}>Provision second VM ($73/mo)</button>
              <span className="dimtxt">web-01 alone is a single point of failure</span>
            </div>
          )}
          {view.registryTags.length === 0 && <div className="dimtxt" style={{ marginTop: 6 }}>Deploying to other VMs needs an image in the registry — run the CI pipeline first.</div>}
        </div>

        <div className="panel">
          <h2>Load balancer</h2>
          {view.lb.provisioned ? (
            <div>
              <div className="row" style={{ gap: 14 }}>
                <span className="pill ok">lb-01</span>
                <span className="dimtxt">{view.lb.ip}</span>
                {view.lb.drillUnderway ? <span className="pill err">CHAOS DRILL: web-01 DOWN</span> : <span className={`pill ${view.lb.haReady ? 'ok' : 'warn'}`}>{view.lb.haReady ? 'can survive losing web-01' : 'no failover capacity'}</span>}
              </div>
              <table className="list" style={{ marginTop: 8 }}>
                <thead><tr><th>backend</th><th>health</th></tr></thead>
                <tbody>
                  {view.lb.backends.map((b) => (
                    <tr key={b.id}><td>{b.id}</td><td><span className={`pill ${b.healthy ? 'ok' : 'err'}`}>{b.healthy ? 'healthy' : 'DOWN'}</span></td></tr>
                  ))}
                  {view.lb.backends.length === 0 ? <tr><td colSpan={2} className="dimtxt">no backends registered — nothing is serving the API</td></tr> : null}
                </tbody>
              </table>
              <div className="dimtxt" style={{ marginTop: 6 }}>Point the <b>api</b> DNS record at {view.lb.ip} to route traffic through the LB.</div>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" onClick={async () => { const r = await api.cloudLb(game); say(r.message); }}>Provision load balancer ($25/mo)</button>
              <span className="dimtxt">health-checked backends, automatic failover</span>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Managed databases</h2>
          {view.db.provisioned ? (
            <div className="row" style={{ gap: 14 }}>
              <span className="pill ok">{view.db.plan}</span>
              <span className="dimtxt">{view.db.endpoint}</span>
              {(['db.micro', 'db.small', 'db.medium'] as const).filter((p) => p !== view.db.plan).map((p) => (
                <button key={p} onClick={async () => { await api.cloudDb(game, p); say(`database resized to ${p}`); }}>resize → {p}</button>
              ))}
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              {(['db.micro', 'db.small', 'db.medium'] as const).map((p) => (
                <button key={p} className={p === 'db.small' ? 'primary' : ''} onClick={async () => { await api.cloudDb(game, p); say(`${p} provisioned`); }}>
                  Provision {p}
                </button>
              ))}
              <span className="dimtxt">$45 / $120 / $260 per month</span>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Observability agent</h2>
          {view.agentInstalled ? (
            <span className="pill ok">installed — metrics flowing</span>
          ) : (
            <button className="primary" onClick={async () => { await api.cloudAgent(game); say('agent installed on web-01'); }}>INSTALL AGENT ($25/mo)</button>
          )}
        </div>

        <div className="panel">
          <h2>web-01 boot volume</h2>
          <div className="dimtxt">Current: {Math.round(view.diskPct)}% used</div>
          <div className="row" style={{ marginTop: 8 }}>
            {[60, 80, 100].map((gb) => (
              <button key={gb} onClick={async () => { await api.cloudDisk(game, gb); say(`disk expanded to ${gb} GB`); }}>resize → {gb} GB</button>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>nginx sites (web-01)</h2>
          {view.nginx.length === 0 ? <div className="dimtxt">nginx not installed yet.</div> : null}
          {view.nginx.map((s) => (
            <div key={s.file} className="dimtxt" style={{ padding: '2px 0' }}>
              {s.file}: listen {s.listen} {s.proxyPass ? `→ ${s.proxyPass}` : '(static)'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// COSTS
// =====================================================================
export function Costs({ view }: { view: GameView }) {
  const total = view.costs.monthlyTotal;
  return (
    <div>
      <div className="panel">
        <h2>Monthly infrastructure cost</h2>
        <table className="list">
          <thead><tr><th>category</th><th>item</th><th style={{ textAlign: 'right' }}>$ / month</th></tr></thead>
          <tbody>
            {view.costs.lineItems.map((li, i) => (
              <tr key={i}><td>{li.category}</td><td>{li.label}</td><td style={{ textAlign: 'right' }}>${li.monthlyCost.toLocaleString()}</td></tr>
            ))}
            <tr><td /><td><b>TOTAL</b></td><td style={{ textAlign: 'right' }}><b>${total.toLocaleString()}</b></td></tr>
          </tbody>
        </table>
        <div className="dimtxt" style={{ marginTop: 8 }}>
          Payroll ${view.costs.payroll.toLocaleString()}/mo · Revenue currently ${Math.round(view.company.users * 2 / 30 * 30).toLocaleString()}/mo (users × $2/mo) —
          {view.company.cash > 0 ? ` runway: healthy (cash $${Math.round(view.company.cash).toLocaleString()})` : ' ⚠ NEGATIVE CASH'}
        </div>
      </div>
      <div className="panel">
        <h2>Optimization ideas (Phase 2 deepens this)</h2>
        <div className="dimtxt" style={{ lineHeight: 1.7 }}>
          → Right-size the database plan when CPU sits low.<br />
          → The boot volume grows bills linearly: rotate logs instead of expanding forever.<br />
          → Managed services cost more than self-hosted — but self-hosted costs engineering time.<br />
          → Caching and CDN (Phase 2) cut compute per request.
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// POSTMORTEMS / INCIDENTS
// =====================================================================
export function Postmortems({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [checked, setChecked] = useState<Record<string, string[]>>({});

  const toggle = (incId: string, actId: string) => {
    const cur = checked[incId] ?? [];
    setChecked({ ...checked, [incId]: cur.includes(actId) ? cur.filter((x) => x !== actId) : [...cur, actId] });
  };

  const file = async (incId: string) => {
    const r = await api.postmortem(game, incId, checked[incId] ?? []);
    alert(r.ok ? 'Postmortem filed. Corrective actions recorded.' : r.message);
    refresh();
  };

  return (
    <div>
      {view.incidents.length === 0 ? (
        <div className="panel"><h2>No incidents</h2><div className="dimtxt">Either you are very good or very blind. Install monitoring to know which.</div></div>
      ) : null}
      {view.incidents.map((inc) => (
        <div key={inc.id} className="postmortem">
          <div className="row">
            <span className={`pill ${inc.status === 'open' ? 'err' : 'ok'}`}>{inc.severity} · {inc.status}</span>
            <h4 style={{ margin: 0 }}>{inc.title}</h4>
          </div>
          <div className="dimtxt" style={{ marginTop: 6 }}>Symptom report: {inc.symptom}</div>
          <div className="dimtxt">Detected by: {inc.detectedBy} · opened day {Math.floor(inc.openedAtMin / 1440) + 1}</div>
          <div className="tl">
            {inc.timeline.map((ev, i) => (
              <div key={i} className="ev"><span className="t">d{Math.floor(ev.t / 1440) + 1} {String(Math.floor((ev.t % 1440) / 60)).padStart(2, '0')}:{String(ev.t % 60).padStart(2, '0')}</span><b>{ev.actor}</b> — {ev.text}</div>
            ))}
            <div className="ev"><span className="t">—</span><b>root cause</b> — {inc.rootCause}</div>
            <div className="ev"><span className="t">—</span><b>customer impact</b> — {inc.customerImpact}</div>
          </div>
          <b style={{ fontSize: 13 }}>Corrective actions:</b>
          {inc.corrective.map((c) => (
            <label key={c.id} className="checkline" style={{ cursor: inc.postmortemFiled ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={c.done || (checked[inc.id] ?? []).includes(c.id)}
                disabled={c.done || inc.postmortemFiled}
                onChange={() => toggle(inc.id, c.id)}
              />
              <span style={c.done ? { color: 'var(--green)' } : {}}>{c.label}</span>
            </label>
          ))}
          {!inc.postmortemFiled && inc.status === 'resolved' && (
            <div style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => file(inc.id)}>FILE POSTMORTEM</button>
            </div>
          )}
          {inc.postmortemFiled && <div style={{ marginTop: 8 }}><span className="pill ok">postmortem filed</span></div>}
        </div>
      ))}
    </div>
  );
}
