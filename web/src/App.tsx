import React, { useCallback, useEffect, useState } from 'react';
import { api, GameSummary, GameView } from './lib/api';
import { Terminal, Editor, Dashboard, CiView, DbView, Monitoring, Cloud, Costs, Postmortems } from './views';

const TABS = [
  { id: 'missions', label: 'MISSIONS' },
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'editor', label: 'EDITOR' },
  { id: 'dashboard', label: 'DASHBOARD' },
  { id: 'ci', label: 'CI / CD' },
  { id: 'database', label: 'DATABASE' },
  { id: 'monitoring', label: 'MONITORING' },
  { id: 'cloud', label: 'CLOUD' },
  { id: 'costs', label: 'COSTS' },
  { id: 'incidents', label: 'INCIDENTS' }
] as const;

export default function App() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [view, setView] = useState<GameView | null>(null);

  useEffect(() => {
    api.listGames().then(setGames).catch(() => setGames([]));
  }, []);

  if (!gameId) {
    return (
      <Landing
        games={games ?? []}
        onEnter={async (id) => { setGameId(id); }}
        onCreate={async (company, founder, mode) => {
          const r = await api.createGame(company, founder, mode);
          setGameId(r.id);
        }}
        onDelete={async (id) => { await api.deleteGame(id); setGames((await api.listGames())); }}
      />
    );
  }

  return <GameShell gameId={gameId} view={view} setView={setView} onExit={() => { setGameId(null); setView(null); api.listGames().then(setGames); }} />;
}

function Landing({ games, onEnter, onCreate, onDelete }: {
  games: GameSummary[];
  onEnter: (id: string) => void;
  onCreate: (company: string, founder: string, mode: string) => void;
  onDelete: (id: string) => void;
}) {
  const [company, setCompany] = useState('');
  const [founder, setFounder] = useState('');
  const [mode, setMode] = useState('career');

  return (
    <div className="landing">
      <div className="landing-card">
        <h1>SHIP<span>IT</span></h1>
        <div className="sub">A DevOps company simulator. One broken server. One demo at 10:30. Build the platform, run the company.</div>

        {games.length > 0 && (
          <>
            <label>Continue</label>
            {games.map((g) => (
              <div key={g.id} className="resume-item" onClick={() => onEnter(g.id)}>
                <span><b>{g.name}</b> <span style={{ color: 'var(--dim)' }}>— day {g.day}</span></span>
                <span
                  className="del"
                  onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete ${g.name}? The company will be lost.`)) onDelete(g.id); }}
                >delete</span>
              </div>
            ))}
            <div style={{ height: 18 }} />
          </>
        )}

        <label>New company</label>
        <input placeholder="Company name (e.g. BigMeter)" value={company} onChange={(e) => setCompany(e.target.value)} />
        <label>Founder (you report to)</label>
        <input placeholder="Jordan" value={founder} onChange={(e) => setFounder(e.target.value)} />
        <div className="modes">
          <div className={`mode ${mode === 'tutorial' ? 'sel' : ''}`} onClick={() => setMode('tutorial')}>
            <b>Tutorial</b><small>Same 16-mission build path, gentler pacing.</small>
          </div>
          <div className={`mode ${mode === 'career' ? 'sel' : ''}`} onClick={() => setMode('career')}>
            <b>Career</b><small>Start from zero. Grow into production. Recommended.</small>
          </div>
          <div className={`mode ${mode === 'sandbox' ? 'sel' : ''}`} onClick={() => setMode('sandbox')}>
            <b>Sandbox</b><small>$250k budget, free building, no missions pressure.</small>
          </div>
        </div>
        <button className="go primary" disabled={!company.trim()} onClick={() => onCreate(company.trim(), founder.trim() || 'Jordan', mode)}>
          FOUND THE COMPANY →
        </button>
      </div>
    </div>
  );
}

function GameShell({ gameId, view, setView, onExit }: { gameId: string; view: GameView | null; setView: (v: GameView | null) => void; onExit: () => void }) {
  const [tab, setTab] = useState<string>('missions');

  const refresh = useCallback(() => {
    api.view(gameId).then(setView).catch(() => {});
  }, [gameId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh]);

  if (!view) return <div style={{ padding: 40, color: 'var(--dim)' }}>Loading company…</div>;

  const setTime = async (paused: boolean, speed: number) => {
    await api.setTime(gameId, paused, speed);
    refresh();
  };

  const openIncident = view.incidents.find((i) => i.status === 'open');

  return (
    <div className="shell">
      <div className="topbar">
        <span className="logo">SHIP<span style={{ color: 'var(--text)' }}>IT</span></span>
        <span className="stat">{view.company.name} <b>{view.company.domain}</b></span>
        <span className="stat">Day <b>{view.day}</b> <b>{view.time}</b></span>
        <span className="stat">Cash <b style={{ color: view.company.cash < 0 ? 'var(--red)' : undefined }}>${Math.round(view.company.cash).toLocaleString()}</b></span>
        <span className="stat">Users <b>{view.company.launched ? Math.round(view.company.users).toLocaleString() : '—'}</b></span>
        <span className="stat">Uptime <b className={view.company.uptime < 99.9 ? 'warn' : ''}>{view.company.uptime.toFixed(2)}%</b></span>
        <span className="stat">Infra <b>${view.company.monthlyInfra}/mo</b></span>
        <span className="spacer" />
        <button onClick={() => setTime(true, view.speed)} disabled={view.paused}>⏸</button>
        <button onClick={() => setTime(false, 1)} disabled={!view.paused && view.speed === 1}>▶ 1×</button>
        <button onClick={() => setTime(false, 4)} disabled={!view.paused && view.speed === 4}>▶ 4×</button>
        <button onClick={() => setTime(false, 16)} disabled={!view.paused && view.speed === 16}>▶ 16×</button>
        <button onClick={onExit}>exit</button>
      </div>

      {openIncident && (
        <div className="incident-banner" onClick={() => setTab('incidents')}>
          🚨 PRODUCTION INCIDENT — {openIncident.title} ({openIncident.severity}) — click to investigate
        </div>
      )}

      <div className="main">
        <div className="sidebar">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'incidents' && openIncident ? <span className="badge">●</span> : null}
            </button>
          ))}
        </div>

        <div className="content">
          {tab === 'missions' && <MissionsTab view={view} />}
          {tab === 'terminal' && <Terminal game={gameId} view={view} refresh={refresh} />}
          {tab === 'editor' && <Editor game={gameId} refresh={refresh} />}
          {tab === 'dashboard' && <Dashboard view={view} />}
          {tab === 'ci' && <CiView game={gameId} view={view} refresh={refresh} />}
          {tab === 'database' && <DbView game={gameId} view={view} refresh={refresh} />}
          {tab === 'monitoring' && <Monitoring game={gameId} view={view} refresh={refresh} />}
          {tab === 'cloud' && <Cloud game={gameId} view={view} refresh={refresh} />}
          {tab === 'costs' && <Costs view={view} />}
          {tab === 'incidents' && <Postmortems game={gameId} view={view} refresh={refresh} />}
        </div>

        <MissionDock view={view} onOpen={() => setTab('missions')} />
      </div>
    </div>
  );
}

function MissionsTab({ view }: { view: GameView }) {
  const completed = view.missions.summaries.filter((s) => s.status === 'completed');
  const hints: Record<string, number> = {};
  void hints;
  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="panel">
        <h2>Company status</h2>
        <div className="dimtxt" style={{ lineHeight: 1.8 }}>
          {view.company.name} — {view.company.launched ? `public since launch, ${Math.round(view.company.users).toLocaleString()} users` : 'pre-launch'} · domain {view.company.domain}<br />
          Platform: {view.hosts.length} host(s) · {view.docker.containers.filter((c) => c.status === 'running').length} running container(s) ·{' '}
          {view.db.provisioned ? `managed Postgres (${view.db.plan})` : 'local sqlite'} · {view.agentInstalled ? 'monitoring live' : 'no monitoring yet'}<br />
          Cash ${Math.round(view.company.cash).toLocaleString()} · infra ${view.company.monthlyInfra}/mo · uptime {view.company.uptime.toFixed(2)}%
        </div>
      </div>

      {completed.length > 0 && (
        <div className="panel">
          <h2>Mission review <span className="hintInline">what each mission demonstrated</span></h2>
          {completed.map((s) => (
            <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid #202938' }}>
              <div className="row">
                <span className="pill ok">✓ {s.index}. {s.title}</span>
                {s.rating ? <span className="pill warn">rating {s.rating}</span> : null}
                <span className="dimtxt" style={{ marginLeft: 'auto' }}>{s.skills.join(' · ')}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Learning progress</h2>
        <table className="list">
          <thead><tr><th>skill</th><th>xp</th><th></th></tr></thead>
          <tbody>
            {Object.entries(view.skills).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
                <td style={{ width: '50%' }}>
                  <div style={{ background: '#0a0e14', borderRadius: 4, height: 8 }}>
                    <div style={{ width: `${Math.min(100, (v / 150) * 100)}%`, background: 'var(--green)', borderRadius: 4, height: 8 }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {Object.keys(view.skills).length === 0 ? <div className="dimtxt">Complete missions to earn skill XP.</div> : null}
      </div>

      <div className="panel">
        <h2>Coming in Phase 2</h2>
        <div className="dimtxt" style={{ lineHeight: 1.8 }}>
          Kubernetes (Deployments, Services, Ingress, probes, HPA) · Terraform (plan/apply, drift) ·
          load balancers &amp; multi-region · backups &amp; restore drills · canary/blue-green deploys ·
          FinOps &amp; multiple fictional cloud providers · the open-ended OPERATE economy.
        </div>
      </div>
    </div>
  );
}

function MissionDock({ view, onOpen }: { view: GameView; onOpen: () => void }) {
  return (
    <div className="missiondock">
      <MissionBody view={view} onOpen={onOpen} />
    </div>
  );
}

function MissionBody({ view, full, onOpen }: { view: GameView; full?: boolean; onOpen?: () => void }) {
  const m = view.missions.current;
  const [hint, setHint] = useState<string | null>(null);
  const [hintMeta, setHintMeta] = useState<{ index: number; remaining: number } | null>(null);

  useEffect(() => { setHint(null); setHintMeta(null); }, [m?.id]);

  const askHint = async () => {
    const r = await api.hint(view.id);
    setHint(r.hint ?? 'No more hints — you are on your own, engineer.');
    setHintMeta({ index: r.index, remaining: r.remaining });
  };

  if (!m) {
    return (
      <div>
        <h3>🏁 Build phase complete</h3>
        <div className="story">
          The company has a platform because you built it: Linux, nginx, DNS, git, Docker, CI/CD,
          managed Postgres, monitoring — and you survived a disk-full and a bad deploy.
          <br /><br />
          OPERATE phase: the world keeps happening. Keep it running, keep the users, watch the bill.
          Phase 2 (Kubernetes, Terraform, multi-region) is on the roadmap.
        </div>
        {view.missions.summaries.length > 0 && (
          <div className="mlist">
            {view.missions.summaries.map((s) => (
              <div key={s.id} className="m done"><span>✓</span><span>{s.index}. {s.title}</span>{s.rating ? <span className="rating">{s.rating}</span> : null}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="dimtxt" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Mission {m.id.slice(1, 3)} · {m.skills.join(', ')}</div>
      <h3>{m.title}</h3>
      <div className="story">{m.story}</div>
      <div className="objective">▸ {m.objective}</div>
      <div className="coaching">Where to start: {m.coaching}</div>

      <div style={{ marginTop: 10 }}>
        {m.requirements.map((r) => (
          <div key={r.id} className={`req ${r.pass ? 'pass' : 'fail'}`}>
            <span className="mark">{r.pass ? '✓' : '○'}</span>
            <span>{r.label}</span>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={askHint}>💡 Hint ({m.hintsUsed}/{m.hintsTotal})</button>
        {onOpen && <button onClick={onOpen}>open missions</button>}
      </div>
      {hint && <div className="hintbox">HINT {hintMeta?.index}: {hint}</div>}
      {hintMeta?.remaining === 0 && <div className="dimtxt" style={{ marginTop: 4 }}>That was the last hint level.</div>}

      {view.missions.summaries.length > 0 && (
        <div className="mlist">
          {view.missions.summaries.map((s) => (
            <div key={s.id} className={`m ${s.status}`}>
              <span>{s.status === 'completed' ? '✓' : s.status === 'active' ? '▸' : '·'}</span>
              <span>{s.index}. {s.title}</span>
              {s.rating ? <span className="rating">{s.rating}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
