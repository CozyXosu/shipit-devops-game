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
      <div className="term-out" ref={outRef} aria-live="polite" aria-label="terminal output">
        {lines.map((l, i) => <div key={i} className={l.cls ?? ''}>{l.text}</div>)}
      </div>
      <div className="term-in">
        <span className="prompt">{view.session.pending ? 'password:' : `${view.session.prompt}`}</span>
        <input
          ref={inRef}
          aria-label="terminal input"
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
  const approve = async (runId: string, ok: boolean) => {
    const r = await api.ciApprove(game, runId, ok);
    alert(r.message);
    refresh();
  };
  const waiting = view.ci.runs.find((r) => r.status === 'waiting_approval');
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

      {waiting && (
        <div className="panel" style={{ borderColor: 'var(--yellow, #d9a300)' }}>
          <h2>⏸ Production approval required</h2>
          <div className="row" style={{ gap: 14 }}>
            <span>Run <b>{waiting.id}</b> wants to ship <b>{waiting.image ?? 'an image'}</b> to production.</span>
            <button className="primary" onClick={() => approve(waiting.id, true)}>✓ APPROVE</button>
            <button onClick={() => approve(waiting.id, false)}>✗ REJECT</button>
          </div>
        </div>
      )}

      {view.ci.staging && (
        <div className="panel">
          <h2>Staging environment <span className="hintInline">the dress rehearsal — e2e runs here before anything touches production</span></h2>
          <div className="row" style={{ gap: 16 }}>
            <span className={`pill ${view.ci.staging.image ? 'ok' : 'warn'}`}>{view.ci.staging.image ?? 'nothing deployed'}</span>
            <span className={`pill ${view.ci.staging.e2ePassed ? 'ok' : 'err'}`}>e2e {view.ci.staging.e2ePassed ? 'PASSING' : 'not passed'}</span>
          </div>
          {view.ci.staging.e2eLog.length > 0 && <div className="logview" style={{ marginTop: 8 }}>{view.ci.staging.e2eLog.join('\n')}</div>}
        </div>
      )}

      {view.canary && (
        <div className="panel">
          <h2>Canary <span className="hintInline">10% of traffic sees the future first</span></h2>
          <div className="row" style={{ gap: 14 }}>
            <span className={`pill ${view.canary.status === 'running' ? 'warn' : view.canary.status === 'promoted' ? 'ok' : 'err'}`}>{view.canary.status}</span>
            <span>{view.canary.image}</span>
            {view.canary.status === 'running' && (
              <>
                <span className="dimtxt">{view.canary.trafficPct}% traffic · minute {view.canary.minutesObserved}/30 · error {view.canary.errorPct.toFixed(1)}%</span>
                <button className="primary" onClick={async () => { const r = await api.canaryPromote(game); alert(r.message); refresh(); }}>PROMOTE NOW</button>
                <button onClick={async () => { const r = await api.canaryAbort(game); alert(r.message); refresh(); }}>ABORT</button>
              </>
            )}
            {view.canary.status !== 'running' && view.canary.reason && <span className="dimtxt">{view.canary.reason}</span>}
          </div>
          <div className="dimtxt" style={{ marginTop: 6 }}>
            {view.canary.status === 'running'
              ? 'auto-promote at minute 30 · auto-abort if the canary error rate spikes'
              : view.canary.status === 'aborted'
                ? 'production was never exposed to this release'
                : 'promoted to 100% of traffic'}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Runs</h2>
        {view.ci.runs.length === 0 ? <div className="dimtxt">No runs yet.</div> : null}
        {view.ci.runs.map((r) => (
          <div key={r.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
              <span className={`pill ${r.status === 'success' ? 'ok' : r.status === 'failed' || r.status === 'rejected' ? 'err' : 'warn'}`}>{r.status}</span>
              <b>{r.id}</b>
              <span className="dimtxt">{r.pipelinePath} · day {Math.floor(r.startedAtMin / 1440) + 1} · {r.commitSha.slice(0, 7)}</span>
              {r.status === 'waiting_approval' && (
                <span className="row">
                  <button className="primary" onClick={(e) => { e.stopPropagation(); approve(r.id, true); }}>✓ approve</button>
                  <button onClick={(e) => { e.stopPropagation(); approve(r.id, false); }}>✗ reject</button>
                </span>
              )}
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
  const [sloAvail, setSloAvail] = useState(String(view.slos.availabilityTarget));
  const [sloP95, setSloP95] = useState(String(view.slos.p95TargetMs));
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
  const commitSlos = async () => {
    const r = await api.setSlos(game, Number(sloAvail), Number(sloP95));
    alert(r.message);
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

      <div className="panel">
        <h2>SLOs &amp; error budget <span className="hintInline">what you promise — and how much bad time that allows</span></h2>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <span>
            availability
            <input value={sloAvail} onChange={(e) => setSloAvail(e.target.value)} style={{ width: 70, marginLeft: 6 }} />
            % (30d)
          </span>
          <span>
            p95 &lt;
            <input value={sloP95} onChange={(e) => setSloP95(e.target.value)} style={{ width: 70, marginLeft: 6 }} />
            ms
          </span>
          <button className={view.slos.configured ? '' : 'primary'} onClick={commitSlos}>{view.slos.configured ? 'UPDATE COMMITMENT' : 'COMMIT SLOs'}</button>
          {view.slos.configured && <span className="dimtxt">committed day {Math.floor((view.slos.setAtMin ?? 0) / 1440) + 1}</span>}
        </div>
        {view.slos.configured && (
          <div className="grid2" style={{ marginTop: 12 }}>
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>availability</span>
                <span className={`pill ${view.slos.report.availabilityMet ? 'ok' : 'err'}`}>{view.slos.report.availability.toFixed(2)}% / {view.slos.availabilityTarget}%</span>
              </div>
              <div style={{ background: '#0a0e14', borderRadius: 4, height: 10, marginTop: 6 }}>
                <div style={{ width: `${Math.min(100, view.slos.report.budgetRemainingPct)}%`, height: 10, borderRadius: 4, background: view.slos.report.budgetRemainingPct > 30 ? 'var(--green)' : view.slos.report.budgetRemainingPct > 0 ? '#e3b341' : 'var(--red)' }} />
              </div>
              <div className="dimtxt" style={{ marginTop: 4 }}>
                error budget: {view.slos.report.budgetRemainingPct}% left · {view.slos.report.budgetBurnedMin} / {view.slos.report.budgetAllowedMin} bad minutes burned · {view.slos.report.burnPerDay}/day
              </div>
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>p95 latency</span>
                <span className={`pill ${view.slos.report.p95Met ? 'ok' : 'err'}`}>{view.slos.report.p95Avg}ms / &lt;{view.slos.p95TargetMs}ms</span>
              </div>
              <div className="dimtxt" style={{ marginTop: 10 }}>
                {view.slos.report.budgetRemainingPct <= 0
                  ? '⚠ BUDGET EXHAUSTED — freeze risky deploys until it recovers.'
                  : 'budget healthy — you have room to ship'}
              </div>
            </div>
          </div>
        )}
      </div>

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
  const c = view.cloud;

  return (
    <div>
      {msg && <div className="panel" style={{ borderColor: 'var(--green)' }}><span style={{ color: 'var(--green)' }}>✓ {msg}</span></div>}

      {c ? (
        <div className="panel">
          <h2>Providers — multi-cloud <span className="hintInline">price × reliability × latency, priced for YOUR stack</span></h2>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <span className="pill ok">{c.providerName}</span>
            <span className="dimtxt">{c.regionName} · {c.latencyMs} ms to users · {c.reliabilityPct}% SLA · list price ×{c.priceMult}</span>
            {c.outagesSeen > 0 && <span className="dimtxt">outages survived: {c.outagesSeen} · SLA credits claimed: ${c.creditsTotal.toLocaleString()}</span>}
          </div>

          {c.outage && (c.outage.ended
            ? (c.outage.creditClaimed
              ? null
              : <div className="row" style={{ gap: 10, marginTop: 10, borderTop: '1px solid #202938', paddingTop: 10 }}>
                  <span className="pill warn">outage settled — unclaimed SLA credit worth ~${c.outage.creditValue?.toLocaleString()}</span>
                  <button className="primary" onClick={async () => { const r = await api.providerCredit(game); say(r.message); }}>REQUEST SLA CREDIT</button>
                  <span className="dimtxt">unclaimed credits expire after one sim day</span>
                </div>)
            : <div className="row" style={{ gap: 10, marginTop: 10, borderTop: '1px solid #202938', paddingTop: 10 }}>
                <span className="pill err">{c.outage.providerName} {c.outage.region} IS DOWN — provider-side, ~{c.outage.minutesLeft} min left</span>
                <span className="dimtxt">nothing you own is broken: check the status page, wait it out, then claim the credit</span>
              </div>)}

          {c.migration && (
            <div className="row" style={{ gap: 12, marginTop: 10, borderTop: '1px solid #202938', paddingTop: 10 }}>
              <span className="pill warn">MIGRATION {c.migration.status === 'cutover' ? 'CUTOVER LIVE' : 'RUNNING'}</span>
              <span className="dimtxt">
                → {c.migration.providerName} {c.migration.regionName} ·{' '}
                {c.migration.status === 'cutover'
                  ? `~${c.migration.minutesLeft} min of cutover left (errors expected)`
                  : `${c.migration.progressPct}% prepped, ~${c.migration.minutesLeft} min to cutover`}{' '}
                · planned downtime {c.migration.downtimeMin} min
              </span>
            </div>
          )}

          {!c.compared ? (
            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <button className="primary" onClick={async () => { const r = await api.cloudCompare(game); say(r.message); }}>RUN COMPARISON</button>
              <span className="dimtxt">prices your current stack on every provider region — never migrate blind</span>
            </div>
          ) : (
            <div>
              <table className="list" style={{ marginTop: 12 }}>
                <thead><tr><th>provider</th><th>region</th><th style={{ textAlign: 'right' }}>your stack $/mo</th><th>Δ vs now</th><th>latency</th><th>SLA</th><th></th></tr></thead>
                <tbody>
                  {c.comparison.map((row) => {
                    const current = row.provider === c.provider && row.region === c.region;
                    return (
                      <tr key={`${row.provider}/${row.region}`} style={current ? { background: 'rgba(70,170,110,0.08)' } : undefined}>
                        <td><b>{row.providerName}</b>{row.note ? <span className="dimtxt"> · {row.note}</span> : null}</td>
                        <td className="dimtxt">{row.regionName}</td>
                        <td style={{ textAlign: 'right' }}>${row.monthlyCost.toLocaleString()}</td>
                        <td className={row.deltaPct > 0 ? 'warn' : ''}>{row.deltaPct >= 0 ? '+' : ''}{row.deltaPct}%</td>
                        <td className="dimtxt">{row.latencyMs} ms</td>
                        <td className="dimtxt">{row.reliabilityPct}%</td>
                        <td>
                          {!current && !c.migration && !c.outage && (
                            <button onClick={async () => { const r = await api.cloudMigrate(game, row.provider, row.region); say(r.message); }}>START MIGRATION</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="dimtxt" style={{ marginTop: 6 }}>
                Cutover downtime shrinks with preparation: backups −10 min · staging −10 · load balancer −10 · Kubernetes −5.
                {c.migrations.length > 0 && ` Past migrations: ${c.migrations.map((m) => `${m.providerName} ${m.toRegion} (${m.downtimeMin} min downtime, ${m.costAfter < m.costBefore ? '-' : '+'}${Math.abs(Math.round((1 - m.costAfter / m.costBefore) * 100))}%)`).join('; ')}.`}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="panel">
          <h2>Providers — multi-cloud</h2>
          <div className="dimtxt">Three providers are circling — Stratus, Volt and Orbit. They land with the ecosystem missions (mission 25).</div>
        </div>
      )}

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

          <div style={{ marginTop: 14, borderTop: '1px solid #202938', paddingTop: 12 }}>
            <h3>Backups <span className="hintInline">daily snapshots — they only help if they exist BEFORE disaster</span></h3>
            {view.db.backups.enabled ? (
              <div>
                <div className="row" style={{ gap: 14 }}>
                  <span className="pill ok">enabled · {view.db.backups.retentionDays}-day retention</span>
                  {view.db.backups.lastRestore && (
                    <span className="pill warn">last restore: RPO {(view.db.backups.lastRestore.rpoMin / 60).toFixed(1)}h · RTO {(view.db.backups.lastRestore.rtoMin / 60).toFixed(1)}h</span>
                  )}
                  <button onClick={async () => { const r = await api.dbRestore(game); say(r.message); }}>↩ RESTORE FROM BACKUP</button>
                </div>
                {view.db.backups.snapshots.length > 0 && (
                  <table className="list" style={{ marginTop: 8 }}>
                    <thead><tr><th>snapshot</th><th>day</th><th>order rows captured</th></tr></thead>
                    <tbody>
                      {view.db.backups.snapshots.map((s) => (
                        <tr key={s.label}><td>{s.label}</td><td>{Math.floor(s.atMin / 1440) + 1}</td><td>{s.ordersRows.toLocaleString()}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <button className="primary" disabled={!view.db.provisioned} onClick={async () => { const r = await api.cloudBackups(game, 7); say(r.message); }}>ENABLE DAILY BACKUPS ($18/mo)</button>
                <span className="dimtxt">7-day retention · first snapshot runs immediately</span>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>Kubernetes</h2>
          {view.k8s ? (
            <div className="row" style={{ gap: 14 }}>
              <span className="pill ok">{view.k8s.name}</span>
              <span className="dimtxt">{view.k8s.version} · 3 nodes · api {view.k8s.ip}</span>
              <span className={`pill ${view.k8s.serving ? 'ok' : 'warn'}`}>{view.k8s.serving ? 'serving the API' : 'cluster ready — deploy with kubectl'}</span>
              <span className="dimtxt">kubectl is configured on web-01 · KUBERNETES tab for details</span>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" onClick={async () => { const r = await api.cloudK8s(game); say(r.message); }}>PROVISION CLUSTER ($220/mo)</button>
              <span className="dimtxt">managed control plane, 3 worker nodes — Deployments, rollouts, HPA</span>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Terraform <span className="hintInline">infrastructure-as-code · /opt/infra on web-01</span></h2>
          {view.tf && view.tf.initialized ? (
            <div className="row" style={{ gap: 14 }}>
              <span className="pill ok">initialized</span>
              <span className="dimtxt">{view.tf.managed} resource(s) managed: {view.tf.addresses.join(', ') || 'none'}</span>
              {view.tf.driftResolved
                ? <span className="pill ok">drift reconciled ✓</span>
                : view.tf.driftDetected
                  ? <span className="pill err">DRIFT DETECTED — run terraform plan</span>
                  : <span className={`pill ${view.tf.lastPlanClean ? 'ok' : 'warn'}`}>{view.tf.lastPlanClean ? 'plan clean' : 'plan shows changes'}</span>}
            </div>
          ) : (
            <div className="dimtxt">
              Not set up. Install terraform (apt-get install -y terraform), describe the infra in{' '}
              <b>/opt/infra/main.tf</b>, then <b>terraform init &amp;&amp; terraform plan</b>.
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
// COSTS + FINOPS
// =====================================================================
export function Costs({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [budget, setBudget] = useState('');
  const [msg, setMsg] = useState('');
  const say = (m: string) => { setMsg(m); refresh(); };
  const total = view.costs.monthlyTotal;
  const finops = view.finops;
  const hasProviderCol = view.costs.lineItems.some((li) => li.provider);

  const doRec = async (kind: string) => {
    if (kind === 'db-small') { await api.cloudDb(game, 'db.small'); say('database resized to db.small'); }
    else if (kind === 'db-micro') { await api.cloudDb(game, 'db.micro'); say('database resized to db.micro'); }
    else if (kind === 'decomm-vm') { const r = await api.vmDecommission(game, 'vm-02'); say(r.message); }
    else if (kind === 'k8s-pool') { const r = await api.k8sNodes(game, 2); say(r.message); }
    else if (kind === 'reserve') { const r = await api.finopsReserve(game); say(r.message); }
  };

  return (
    <div>
      {msg && <div className="panel" style={{ borderColor: 'var(--green)' }}><span style={{ color: 'var(--green)' }}>✓ {msg}</span></div>}
      <div className="panel">
        <h2>Monthly infrastructure cost</h2>
        <table className="list">
          <thead>
            <tr>
              <th>category</th><th>item</th>{hasProviderCol && <th>provider</th>}<th style={{ textAlign: 'right' }}>$ / month</th>
            </tr>
          </thead>
          <tbody>
            {view.costs.lineItems.map((li, i) => (
              <tr key={i}>
                <td>{li.category}</td><td>{li.label}</td>
                {hasProviderCol && <td className="dimtxt">{li.provider ?? '—'}</td>}
                <td style={{ textAlign: 'right' }}>${li.monthlyCost.toLocaleString()}</td>
              </tr>
            ))}
            <tr><td /><td><b>TOTAL</b></td>{hasProviderCol && <td />}<td style={{ textAlign: 'right' }}><b>${total.toLocaleString()}</b></td></tr>
          </tbody>
        </table>
        <div className="dimtxt" style={{ marginTop: 8 }}>
          Payroll ${view.costs.payroll.toLocaleString()}/mo · Revenue currently ${Math.round(view.company.users * 2 / 30 * 30).toLocaleString()}/mo (users × $2/mo) —
          {view.company.cash > 0 ? ` runway: healthy (cash $${Math.round(view.company.cash).toLocaleString()})` : ' ⚠ NEGATIVE CASH'}
        </div>
      </div>

      {finops ? (
        <div className="panel">
          <h2>FinOps <span className="hintInline">every dollar should have a job — find the ones sleeping</span></h2>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {finops.budgetMonthly !== null
              ? <span className={`pill ${finops.currentMonthly <= finops.budgetMonthly ? 'ok' : 'err'}`}>
                  budget ${finops.budgetMonthly.toLocaleString()}/mo · bill ${finops.currentMonthly.toLocaleString()}
                </span>
              : <span className="pill warn">no budget set</span>}
            <span className="dimtxt">scoreboard: {finops.daysUnderBudget} day(s) under · {finops.daysOverBudget} over</span>
            {finops.baselineMonthly !== null && finops.vsBaselinePct !== null && (
              <span className={`pill ${finops.vsBaselinePct <= -15 ? 'ok' : 'warn'}`}>
                {finops.vsBaselinePct >= 0 ? '+' : ''}{finops.vsBaselinePct}% vs baseline ${finops.baselineMonthly.toLocaleString()}
              </span>
            )}
            {finops.reserved && (
              <span className={`pill ${finops.reserved.active ? 'ok' : 'warn'}`}>
                reserved compute: {finops.reserved.providerName}{finops.reserved.active ? ' (−20% active)' : ' (dormant — you migrated away)'}
              </span>
            )}
          </div>
          <div className="row" style={{ marginTop: 10, gap: 10 }}>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 130 }} placeholder="monthly $" />
            <button className="primary" onClick={async () => { const r = await api.finopsBudget(game, Number(budget)); say(r.message); }}>SET BUDGET</button>
            <span className="dimtxt">
              unit economics: ${finops.unitEconomics.costPerUser}/user cost · ${finops.unitEconomics.revenuePerUser}/user revenue · margin {finops.unitEconomics.grossMarginPct}%
            </span>
          </div>

          <h3 style={{ marginTop: 14 }}>Recommendations <span className="hintInline">{finops.resolvedCount} resolved · computed from live utilization</span></h3>
          {finops.recommendations.length === 0 ? <div className="dimtxt">Nothing oversized right now. Suspicious.</div> : null}
          {finops.recommendations.map((r) => (
            <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid #202938' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ maxWidth: 520 }}><b>{r.label}</b> <span className="dimtxt">— {r.detail}</span></span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="pill ok">−${r.savingsMonthly.toLocaleString()}/mo</span>
                  {r.action && (r.action.kind === 'migrate'
                    ? <span className="dimtxt">→ plan it in the CLOUD tab</span>
                    : <button className="primary" onClick={() => doRec(r.action!.kind)}>{r.action.label}</button>)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <h2>FinOps — unlocks with the ecosystem missions</h2>
          <div className="dimtxt" style={{ lineHeight: 1.7 }}>
            Budgets, unit economics and rightsizing recommendations land with mission 28. Until then:<br />
            → Right-size the database plan when CPU sits low.<br />
            → The boot volume grows bills linearly: rotate logs instead of expanding forever.<br />
            → Managed services cost more than self-hosted — but self-hosted costs engineering time.
          </div>
        </div>
      )}
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

// =====================================================================
// KUBERNETES
// =====================================================================
export function K8sView({ view }: { view: GameView }) {
  if (!view.k8s) {
    return (
      <div className="panel">
        <h2>Kubernetes</h2>
        <div className="dimtxt">
          No cluster yet. Provision one in the CLOUD tab ($220/mo), write manifests in{' '}
          <b>/opt/app/k8s/*.yaml</b> with the EDITOR, then <b>kubectl apply -f k8s/</b> from the terminal on web-01.
        </div>
      </div>
    );
  }
  const k = view.k8s;
  return (
    <div>
      <div className="panel">
        <h2>{k.name} <span className="hintInline">{k.version} · 3 nodes · api endpoint {k.ip}</span></h2>
        <div className="row" style={{ gap: 14 }}>
          <span className={`pill ${k.serving ? 'ok' : 'warn'}`}>{k.serving ? 'serving the API' : 'not serving'}</span>
          <span className={`pill ${k.zeroDowntimeProven ? 'ok' : 'warn'}`}>{k.zeroDowntimeProven ? 'zero-downtime rollout ✓' : 'no rollout proven yet'}</span>
          <span className="dimtxt">drive it from the TERMINAL: kubectl apply / get / describe / set image / autoscale / rollout</span>
        </div>
      </div>

      <div className="panel">
        <h2>Deployments</h2>
        {k.deployments.length === 0 ? <div className="dimtxt">None applied yet.</div> : null}
        <table className="list">
          <thead><tr><th>name</th><th>image</th><th>ready</th><th>revision</th><th>strategy</th><th>probes</th></tr></thead>
          <tbody>
            {k.deployments.map((d) => (
              <tr key={d.name}>
                <td><b>{d.name}</b></td>
                <td className="dimtxt">{d.image}</td>
                <td className={d.ready >= d.replicas ? '' : 'warn'}>{d.ready}/{d.replicas}</td>
                <td>{d.revision}</td>
                <td>{d.strategy}</td>
                <td className="dimtxt">{d.readinessProbe ? 'readiness ✓' : 'readiness ✗'} · {d.livenessProbe ? 'liveness ✓' : 'liveness ✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Pods</h2>
          {k.pods.length === 0 ? <div className="dimtxt">No pods.</div> : null}
          <table className="list">
            <thead><tr><th>pod</th><th>phase</th><th>restarts</th><th>node</th></tr></thead>
            <tbody>
              {k.pods.map((p) => (
                <tr key={p.name}>
                  <td className="dimtxt">{p.name}</td>
                  <td><span className={`pill ${p.phase === 'Ready' ? 'ok' : p.phase === 'CrashLoopBackOff' ? 'err' : 'warn'}`}>{p.phase}</span></td>
                  <td>{p.restarts}</td>
                  <td className="dimtxt">{p.node}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Services · Ingress · HPA</h2>
          {k.services.map((s) => (
            <div key={s.name} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>svc/<b>{s.name}</b> <span className="dimtxt">{s.type} :{s.port}→{s.targetPort} app={s.selector}</span></span>
              <span className="dimtxt">{s.ingressIp ?? ''}</span>
            </div>
          ))}
          {k.ingresses.map((i) => (
            <div key={i.name} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>ingress/<b>{i.name}</b></span>
              <span className="dimtxt">{i.host || '*'} → {i.service}</span>
            </div>
          ))}
          {k.hpas.map((h) => (
            <div key={h.name} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>hpa/<b>{h.name}</b> <span className="dimtxt">{h.deployment} {h.min}–{h.max} pods</span></span>
              <span className={`pill ${h.peaked ? 'ok' : 'warn'}`}>{h.current} replica(s){h.peaked ? ' · scaled out ✓' : ''}</span>
            </div>
          ))}
          {k.services.length + k.ingresses.length + k.hpas.length === 0 ? <div className="dimtxt">Nothing exposed yet.</div> : null}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// COMPANY (operate phase: team, debt, marketing)
// =====================================================================
export function Company({ game, view, refresh }: { game: string; view: GameView; refresh: Refresh }) {
  const [msg, setMsg] = useState('');
  const say = (m: string) => { setMsg(m); refresh(); };
  const debtHeat = view.debt.points > 25 ? 'err' : view.debt.points > 12 ? 'warn' : 'ok';

  return (
    <div>
      {msg && <div className="panel" style={{ borderColor: 'var(--green)' }}><span style={{ color: 'var(--green)' }}>✓ {msg}</span></div>}

      <div className="grid2">
        <div className="panel">
          <h2>Team <span className="hintInline">salaries hit the monthly payroll — every role changes how the world behaves</span></h2>
          {view.team.engineers.length === 0 ? <div className="dimtxt">You are a team of one. The pager goes to the founder.</div> : null}
          <table className="list">
            <thead><tr><th>name</th><th>role</th><th>salary</th><th>on call</th><th></th></tr></thead>
            <tbody>
              {view.team.engineers.map((e) => (
                <tr key={e.id}>
                  <td><b>{e.name}</b></td>
                  <td className="dimtxt">{e.roleLabel}</td>
                  <td>${e.salary.toLocaleString()}/mo</td>
                  <td>
                    {view.team.onCallId === e.id
                      ? <span className="pill ok">📱 on call</span>
                      : <button onClick={async () => { const r = await api.setOnCall(game, e.id); say(r.message); }}>give pager</button>}
                  </td>
                  <td><button onClick={async () => { const r = await api.fire(game, e.id); say(r.message); }}>let go</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, borderTop: '1px solid #202938', paddingTop: 10 }}>
            <b style={{ fontSize: 13 }}>Open roles</b>
            {view.team.roles.map((r) => (
              <div key={r.id} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #202938' }}>
                <span>
                  <b>{r.label}</b> <span className="dimtxt">— {r.blurb} · -{r.debtPerDay} debt/day</span>
                </span>
                <button className="primary" onClick={async () => { const res = await api.hire(game, r.id); say(res.message); }}>HIRE (${r.salary.toLocaleString()}/mo)</button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>Technical debt <span className="hintInline">debt raises the odds of the next incident</span></h2>
            <div className="row" style={{ gap: 14 }}>
              <span className={`pill ${debtHeat}`}>{view.debt.points} points</span>
              <span className="dimtxt">ambient incident risk scales with this number</span>
            </div>
            <div style={{ marginTop: 8 }}>
              {view.debt.log.slice(0, 6).map((l, i) => (
                <div key={i} className="dimtxt" style={{ padding: '2px 0' }}>d{Math.floor(l.atMin / 1440) + 1} — {l.text}</div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Refactoring projects <span className="hintInline">pay the mortgage down on purpose</span></h2>
            {view.debt.projects.map((p) => (
              <div key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid #202938' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <b>{p.label}</b> <span className="dimtxt">— {p.detail}</span>
                  </span>
                  {p.done ? <span className="pill ok">done (-{p.debtRemoved})</span>
                    : p.startedAtMin !== null ? <span className="pill warn">running… {p.progress}%</span>
                    : <button onClick={async () => { const r = await api.debtProject(game, p.id); say(r.message); }}>START (-{p.debtRemoved} · ${p.costCash.toLocaleString()} · {Math.round(p.durationMin / 60)}h)</button>}
                </div>
              </div>
            ))}
          </div>

          <div className="panel">
            <h2>Marketing</h2>
            <div className="row" style={{ gap: 12 }}>
              {view.marketingActive
                ? <span className="pill ok">campaign live — growth ×2.5</span>
                : <button className="primary" onClick={async () => { const r = await api.marketing(game); say(r.message); }}>RUN CAMPAIGN ($2,000)</button>}
              <span className="dimtxt">~4 sim hours of elevated signups</span>
            </div>
          </div>

          <div className="panel">
            <h2>Products <span className="hintInline">the second product is where margins live</span></h2>
            <div className="row" style={{ gap: 12, marginBottom: 6 }}>
              <span className="pill ok">product MRR ${view.products.productMrr.toLocaleString()}/mo</span>
              <span className="dimtxt">
                subscription MRR ${view.products.baseMrr.toLocaleString()}/mo — products are{' '}
                {view.products.baseMrr > 0 ? Math.round((view.products.productMrr / view.products.baseMrr) * 100) : 0}% of it
              </span>
            </div>
            {view.products.products.map((p) => (
              <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid #202938' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <b>{p.name}</b> <span className={`pill ${p.tier === 'enterprise' ? 'warn' : 'ok'}`}>{p.tier}</span>{' '}
                    <span className="dimtxt">{p.tagline}</span>
                  </span>
                  {p.launchedAtMin !== null
                    ? <span className="pill ok">live · ${p.mrr?.toLocaleString()}/mo</span>
                    : p.startedAtMin !== null
                      ? <span className="pill warn">building… {p.progress}%</span>
                      : (
                        <button
                          className="primary"
                          disabled={p.blockers.length > 0}
                          title={p.blockers.join(' · ')}
                          onClick={async () => { const r = await api.productStart(game, p.id); say(r.message); }}
                        >
                          BUILD (${p.buildCost.toLocaleString()} · {p.buildHours}h)
                        </button>
                      )}
                </div>
                <div className="dimtxt" style={{ marginTop: 4 }}>
                  ${p.pricePerUserMonthly}/user/mo × {p.adoptionPct}% of users · +${p.infraMonthly}/mo infra
                  {p.blockers.length > 0 && p.startedAtMin === null && p.launchedAtMin === null ? <span> — 🔒 {p.blockers.join(' · ')}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// MODES (P4): mission packs, tournament, challenges, access & language
// =====================================================================
export function Modes({ game, view, refresh, t, locale, onLocale, a11y, onA11y }: {
  game: string;
  view: GameView;
  refresh: Refresh;
  t: (key: string) => string;
  locale: string;
  onLocale: (l: 'en' | 'es' | 'de') => void;
  a11y: { highContrast: boolean; largeText: boolean; reducedMotion: boolean };
  onA11y: (a: { highContrast: boolean; largeText: boolean; reducedMotion: boolean }) => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const note = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 6000);
  };

  const activate = async (packId: string) => {
    const r = await api.activatePack(game, packId);
    note(r.message);
    refresh();
  };
  const startChallenge = async (challengeId: string) => {
    const r = await api.challengeStart(game, challengeId);
    note(r.message);
    refresh();
  };
  const abandon = async () => {
    const r = await api.challengeAbandon(game);
    note(r.message);
    refresh();
  };

  const ch = view.challenge;
  const tour = view.tournament;
  const m28Done = view.missions.completed.includes('m28-finops');
  const unlocked = m28Done || view.packs.activated.length > 0 || tour !== null || ch !== null;

  return (
    <div style={{ maxWidth: 1000 }}>
      {msg && <div className="hintbox" role="status">{msg}</div>}
      <div className="panel">
        <h2>{t('modes.headline')}</h2>
        <div className="dimtxt">{t('modes.sub')}</div>
      </div>

      <div className="panel">
        <h2>{t('modes.packs')} <span className="hintInline">{t('modes.packs.format')}: JSON bundles → packs/</span></h2>
        {view.packs.available.map((p) => {
          const active = view.packs.activated.includes(p.id);
          return (
            <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid #202938' }}>
              <div className="row">
                <span><b>{p.name}</b> <span className="dimtxt">v{p.version} · {p.missionCount} {t('modes.packs.missions')}{p.tournament ? ' · 🏆' : ''}{p.author ? ` · ${p.author}` : ''}</span></span>
                <span style={{ marginLeft: 'auto' }}>
                  {active
                    ? <span className="pill ok">✓ {t('modes.packs.active')}</span>
                    : <button className="primary" disabled={!unlocked} onClick={() => activate(p.id)}>{t('modes.packs.activate')}</button>}
                </span>
              </div>
              <div className="dimtxt" style={{ marginTop: 4 }}>{p.description}</div>
            </div>
          );
        })}
        <div className="dimtxt" style={{ marginTop: 8, fontSize: 12 }}>{view.packs.formatNote}</div>
      </div>

      {tour && (
        <div className="panel">
          <h2>🏆 {t('modes.tournament')}</h2>
          <div className="dimtxt" style={{ marginBottom: 8 }}>
            {tour.roundsWon} {t('modes.tournament.rounds')} · {tour.points} {t('modes.tournament.points')}
            {tour.finished && tour.place ? ` · ${t('modes.tournament.place')}: #${tour.place}` : ''}
          </div>
          <table className="list">
            <thead><tr><th></th><th>{t('modes.tournament.points')}</th></tr></thead>
            <tbody>
              {[{ name: t('modes.tournament.you'), points: tour.points, you: true }, ...tour.rivals.map((r) => ({ name: r.name, points: r.points, you: false }))]
                .sort((a, b) => b.points - a.points)
                .map((r, i) => (
                  <tr key={r.name}>
                    <td>{i + 1}. {r.you ? <b>{r.name}</b> : r.name}</td>
                    <td>{Math.round(r.points * 10) / 10}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h2>{t('modes.challenges')} {ch?.challengesPassed ? <span className="hintInline">{t('modes.challenges.record')}: {ch.challengesPassed} × {t('modes.challenges.passed')}</span> : null}</h2>

        {ch && ch.status === 'active' && (
          <div style={{ border: '1px solid #d9a03f', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div className="row">
              <span><b>{ch.name}</b> <span className="dimtxt">{ch.ruleLabel}</span></span>
              <button style={{ marginLeft: 'auto' }} onClick={abandon}>{t('modes.challenges.abandon')}</button>
            </div>
            <div className="dimtxt" style={{ margin: '6px 0' }}>{ch.minutesLeft} {t('modes.challenges.minutesLeft')}</div>
            {ch.rule === 'budget' && ch.live && (
              <div>{t('modes.challenges.bill')}: <b>${ch.live.billNow}/mo</b> · {t('modes.challenges.cap')}: <b>${ch.live.capMonthly}/mo</b></div>
            )}
            {ch.rule === 'availability' && ch.live && (
              <div>{t('modes.challenges.windowed')}: <b className={(ch.live.windowedAvailabilityPct ?? 100) < (ch.availabilityFloorPct ?? 99.5) ? 'warn' : ''}>{ch.live.windowedAvailabilityPct}%</b> · {t('modes.challenges.badmin')}: <b>{ch.live.badMinutes}</b></div>
            )}
            {ch.rule === 'rto' && (
              <div className="dimtxt">RTO ≤ {ch.rtoTargetMin} min — {t('modes.challenges.score')}: {ch.scoreLabel}</div>
            )}
            {ch.days.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="dimtxt" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{t('modes.challenges.days')}</div>
                {ch.days.map((d) => (
                  <div key={d.day} className={`req ${d.ok ? 'pass' : 'fail'}`}>
                    <span className="mark">{d.ok ? '✓' : '✗'}</span><span>{d.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ch && ch.status !== 'active' && (
          <div style={{ border: `1px solid ${ch.status === 'passed' ? 'var(--green)' : 'var(--red)'}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div className="row">
              <span><b>{ch.name}</b> — <span className={ch.status === 'passed' ? 'ok' : 'err'}>{t(`modes.challenges.${ch.status}`)}</span>
                {ch.score !== null ? ` · ${t('modes.challenges.score')}: ${ch.score} (${ch.scoreLabel})` : ''}
                {ch.stars ? ` · ${'★'.repeat(ch.stars)}${'☆'.repeat(3 - ch.stars)}` : ''}
              </span>
            </div>
            {ch.verdict && <div className="dimtxt" style={{ marginTop: 4 }}>{ch.verdict}</div>}
          </div>
        )}

        {view.challengesCatalog.map((c) => {
          const isActive = ch?.id === c.id && ch?.status === 'active';
          const done = ch?.id === c.id && ch?.status !== 'active';
          return (
            <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid #202938', opacity: isActive ? 0.55 : 1 }}>
              <div className="row">
                <span><b>{c.name}</b> <span className="dimtxt">· {c.durationDays}d</span></span>
                <span style={{ marginLeft: 'auto' }}>
                  {done ? <span className="dimtxt">{t(`modes.challenges.${ch?.status}`)}</span>
                    : <button disabled={!unlocked || Boolean(ch && ch.status === 'active')} onClick={() => startChallenge(c.id)}>{t('modes.challenges.start')}</button>}
                </span>
              </div>
              <div className="dimtxt" style={{ marginTop: 4 }}>{c.tagline}</div>
              <div className="dimtxt" style={{ marginTop: 2, fontSize: 12 }}>{c.ruleLabel}</div>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <h2>{t('modes.access')}</h2>
        <div style={{ marginBottom: 10 }}>
          <span className="dimtxt">{t('modes.access.language')}: </span>
          {(['en', 'es', 'de'] as const).map((l) => (
            <button key={l} style={{ marginLeft: 6 }} aria-pressed={locale === l} className={locale === l ? 'primary' : ''}
              onClick={() => onLocale(l)}>{l === 'en' ? 'English' : l === 'es' ? 'Español' : 'Deutsch'}</button>
          ))}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button aria-pressed={a11y.highContrast} className={a11y.highContrast ? 'primary' : ''}
            onClick={() => onA11y({ ...a11y, highContrast: !a11y.highContrast })}>
            {t('modes.access.highContrast')}: {a11y.highContrast ? t('modes.access.on') : t('modes.access.off')}
          </button>
          <button aria-pressed={a11y.largeText} className={a11y.largeText ? 'primary' : ''}
            onClick={() => onA11y({ ...a11y, largeText: !a11y.largeText })}>
            {t('modes.access.largeText')}: {a11y.largeText ? t('modes.access.on') : t('modes.access.off')}
          </button>
          <button aria-pressed={a11y.reducedMotion} className={a11y.reducedMotion ? 'primary' : ''}
            onClick={() => onA11y({ ...a11y, reducedMotion: !a11y.reducedMotion })}>
            {t('modes.access.reducedMotion')}: {a11y.reducedMotion ? t('modes.access.on') : t('modes.access.off')}
          </button>
        </div>
        <div className="dimtxt" style={{ marginTop: 8, fontSize: 12 }}>{t('modes.access.note')}</div>
        {!unlocked && <div className="dimtxt" style={{ marginTop: 6, fontSize: 12 }}>{t('modes.gated')}</div>}
      </div>
    </div>
  );
}
