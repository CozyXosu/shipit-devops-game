import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, GameSummary, GameView } from './lib/api';
import { isLocale, Locale, makeT } from './lib/i18n';
import { Terminal, Editor, Dashboard, CiView, DbView, Monitoring, Cloud, Costs, Postmortems, K8sView, Company, Modes, Portal } from './views';

const TABS = [
  { id: 'missions' }, { id: 'terminal' }, { id: 'editor' }, { id: 'dashboard' }, { id: 'ci' }, { id: 'k8s' },
  { id: 'database' }, { id: 'monitoring' }, { id: 'cloud' }, { id: 'company' }, { id: 'costs' }, { id: 'incidents' }, { id: 'portal' }, { id: 'modes' }
] as const;

export interface A11ySettings { highContrast: boolean; largeText: boolean; reducedMotion: boolean }

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export default function App() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [view, setView] = useState<GameView | null>(null);

  // localization + accessibility (P4): client-side chrome, persisted per browser
  const [locale, setLocale] = useState<Locale>(() => {
    const stored = readStored<string>('shipit.locale', 'en');
    return isLocale(stored) ? stored : 'en';
  });
  const [a11y, setA11y] = useState<A11ySettings>(() => readStored<A11ySettings>('shipit.a11y', { highContrast: false, largeText: false, reducedMotion: false }));
  const t = useMemo(() => makeT(locale), [locale]);

  useEffect(() => {
    localStorage.setItem('shipit.locale', JSON.stringify(locale));
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem('shipit.a11y', JSON.stringify(a11y));
    const cl = document.body.classList;
    cl.toggle('a11y-hc', a11y.highContrast);
    cl.toggle('a11y-lg', a11y.largeText);
    cl.toggle('a11y-rm', a11y.reducedMotion);
  }, [a11y]);

  useEffect(() => {
    api.listGames().then(setGames).catch(() => setGames([]));
  }, []);

  if (!gameId) {
    return (
      <Landing
        t={t}
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

  return (
    <GameShell
      gameId={gameId}
      view={view}
      setView={setView}
      onExit={() => { setGameId(null); setView(null); api.listGames().then(setGames); }}
      t={t}
      locale={locale}
      setLocale={setLocale}
      a11y={a11y}
      setA11y={setA11y}
    />
  );
}

function Landing({ t, games, onEnter, onCreate, onDelete }: {
  t: (key: string) => string;
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
        <div className="sub">{t('landing.sub')}</div>

        {games.length > 0 && (
          <>
            <label>{t('landing.continue')}</label>
            {games.map((g) => (
              <div key={g.id} className="resume-item" onClick={() => onEnter(g.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onEnter(g.id); }}>
                <span><b>{g.name}</b> <span style={{ color: 'var(--dim)' }}>— {t('top.day').toLowerCase()} {g.day}</span></span>
                <span
                  className="del"
                  onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete ${g.name}? The company will be lost.`)) onDelete(g.id); }}
                >delete</span>
              </div>
            ))}
            <div style={{ height: 18 }} />
          </>
        )}

        <label>{t('landing.new')}</label>
        <input aria-label={t('landing.new')} placeholder="BigMeter" value={company} onChange={(e) => setCompany(e.target.value)} />
        <label>{t('landing.founder')}</label>
        <input aria-label={t('landing.founder')} placeholder="Jordan" value={founder} onChange={(e) => setFounder(e.target.value)} />
        <div className="modes">
          <div className={`mode ${mode === 'tutorial' ? 'sel' : ''}`} onClick={() => setMode('tutorial')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setMode('tutorial'); }}>
            <b>{t('landing.mode.tutorial')}</b><small>{t('landing.mode.tutorial.sub')}</small>
          </div>
          <div className={`mode ${mode === 'career' ? 'sel' : ''}`} onClick={() => setMode('career')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setMode('career'); }}>
            <b>{t('landing.mode.career')}</b><small>{t('landing.mode.career.sub')}</small>
          </div>
          <div className={`mode ${mode === 'sandbox' ? 'sel' : ''}`} onClick={() => setMode('sandbox')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setMode('sandbox'); }}>
            <b>{t('landing.mode.sandbox')}</b><small>{t('landing.mode.sandbox.sub')}</small>
          </div>
        </div>
        <button className="go primary" disabled={!company.trim()} onClick={() => onCreate(company.trim(), founder.trim() || 'Jordan', mode)}>
          {t('landing.found')}
        </button>
      </div>
    </div>
  );
}

function GameShell({ gameId, view, setView, onExit, t, locale, setLocale, a11y, setA11y }: {
  gameId: string;
  view: GameView | null;
  setView: (v: GameView | null) => void;
  onExit: () => void;
  t: (key: string) => string;
  locale: Locale;
  setLocale: (l: Locale) => void;
  a11y: A11ySettings;
  setA11y: (a: A11ySettings) => void;
}) {
  const [tab, setTab] = useState<string>('missions');

  const refresh = useCallback(() => {
    api.view(gameId).then(setView).catch(() => {});
  }, [gameId]);

  useEffect(() => {
    refresh();
    const t2 = setInterval(refresh, 1500);
    return () => clearInterval(t2);
  }, [refresh]);

  // keyboard navigation: Alt+1…9 switches tabs, Alt+0 opens MODES (a11y)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = parseInt(e.key, 10);
      if (Number.isNaN(n)) return;
      e.preventDefault();
      const idx = n === 0 ? TABS.length - 1 : n - 1;
      if (idx >= 0 && idx < TABS.length) setTab(TABS[idx].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!view) return <div style={{ padding: 40, color: 'var(--dim)' }}>Loading company…</div>;

  const setTime = async (paused: boolean, speed: number) => {
    await api.setTime(gameId, paused, speed);
    refresh();
  };

  const openIncident = view.incidents.find((i) => i.status === 'open');

  const changeA11y = (next: A11ySettings) => {
    setA11y(next);
    void api.setSettings(gameId, next).then(refresh);
  };
  const changeLocale = (l: Locale) => {
    setLocale(l);
    void api.setSettings(gameId, { locale: l }).then(refresh);
  };

  return (
    <div className="shell">
      <div className="topbar">
        <span className="logo">SHIP<span style={{ color: 'var(--text)' }}>IT</span></span>
        <span className="stat">{view.company.name} <b>{view.company.domain}</b></span>
        <span className="stat">{t('top.day')} <b>{view.day}</b> <b>{view.time}</b></span>
        <span className="stat">{t('top.cash')} <b style={{ color: view.company.cash < 0 ? 'var(--red)' : undefined }}>${Math.round(view.company.cash).toLocaleString()}</b></span>
        <span className="stat">{t('top.users')} <b>{view.company.launched ? Math.round(view.company.users).toLocaleString() : '—'}</b></span>
        <span className="stat">{t('top.uptime')} <b className={view.company.uptime < 99.9 ? 'warn' : ''}>{view.company.uptime.toFixed(2)}%</b></span>
        <span className="stat">{t('top.infra')} <b>${view.company.monthlyInfra}/mo</b></span>
        <span className="spacer" />
        <button onClick={() => setTime(true, view.speed)} disabled={view.paused} aria-label={t('top.pause')}>⏸</button>
        <button onClick={() => setTime(false, 1)} disabled={!view.paused && view.speed === 1} aria-label={`${t('top.speed')} 1`}>▶ 1×</button>
        <button onClick={() => setTime(false, 4)} disabled={!view.paused && view.speed === 4} aria-label={`${t('top.speed')} 4`}>▶ 4×</button>
        <button onClick={() => setTime(false, 16)} disabled={!view.paused && view.speed === 16} aria-label={`${t('top.speed')} 16`}>▶ 16×</button>
        <button onClick={onExit}>{t('top.exit')}</button>
      </div>

      {openIncident && (
        <div className="incident-banner" onClick={() => setTab('incidents')} role="alert">
          🚨 PRODUCTION INCIDENT — {openIncident.title} ({openIncident.severity}) — click to investigate
        </div>
      )}

      <div className="main">
        <div className="sidebar" role="tablist" aria-label="sections">
          {TABS.map((tb, i) => (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              aria-label={`${t(`tab.${tb.id}`)} (Alt+${i === TABS.length - 1 ? 0 : i + 1})`}
              className={tab === tb.id ? 'active' : ''}
              onClick={() => setTab(tb.id)}
            >
              {t(`tab.${tb.id}`)}
              {tb.id === 'incidents' && openIncident ? <span className="badge">●</span> : null}
            </button>
          ))}
        </div>

        <div className="content">
          {tab === 'missions' && <MissionsTab view={view} t={t} />}
          {tab === 'terminal' && <Terminal game={gameId} view={view} refresh={refresh} />}
          {tab === 'editor' && <Editor game={gameId} refresh={refresh} />}
          {tab === 'dashboard' && <Dashboard view={view} />}
          {tab === 'ci' && <CiView game={gameId} view={view} refresh={refresh} />}
          {tab === 'k8s' && <K8sView view={view} />}
          {tab === 'database' && <DbView game={gameId} view={view} refresh={refresh} />}
          {tab === 'monitoring' && <Monitoring game={gameId} view={view} refresh={refresh} />}
          {tab === 'cloud' && <Cloud game={gameId} view={view} refresh={refresh} />}
          {tab === 'company' && <Company game={gameId} view={view} refresh={refresh} />}
          {tab === 'costs' && <Costs game={gameId} view={view} refresh={refresh} />}
          {tab === 'incidents' && <Postmortems game={gameId} view={view} refresh={refresh} />}
          {tab === 'portal' && <Portal game={gameId} view={view} refresh={refresh} />}
          {tab === 'modes' && (
            <Modes
              game={gameId}
              view={view}
              refresh={refresh}
              t={t}
              locale={locale}
              onLocale={changeLocale}
              a11y={a11y}
              onA11y={changeA11y}
            />
          )}
        </div>

        <MissionDock view={view} t={t} game={gameId} onOpen={() => setTab(tab === 'modes' ? 'missions' : 'modes')} />
      </div>
    </div>
  );
}

function MissionsTab({ view, t }: { view: GameView; t: (key: string) => string }) {
  const completed = view.missions.summaries.filter((s) => s.status === 'completed');
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
        <h2>{t('modes.headline')}</h2>
        <div className="dimtxt" style={{ lineHeight: 1.8 }}>
          {t('modes.sub')} — {t('tab.modes').toLowerCase()} (Alt+0)
        </div>
      </div>
    </div>
  );
}

function MissionDock({ view, t, game, onOpen }: { view: GameView; t: (key: string) => string; game: string; onOpen: () => void }) {
  return (
    <div className="missiondock">
      <MissionBody view={view} t={t} game={game} onOpen={onOpen} />
      <PackBody view={view} t={t} game={game} />
    </div>
  );
}

function MissionBody({ view, full, onOpen }: { view: GameView; t: (key: string) => string; full?: boolean; onOpen?: () => void; game?: string }) {
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
        <h3>🏁 Every mission complete</h3>
        <div className="story">
          The company has a platform because you built it — Linux, nginx, DNS, git, Docker, CI/CD,
          managed Postgres, monitoring, HA — and you ran it: a team with a real on-call rotation,
          a technical-debt ledger you pay down on purpose, canary releases, SLOs with error budgets.
          You survived a disk-full, a bad deploy, a dropped database, console drift and a leaky canary.
          <br /><br />
          You scaled it: providers, migrations, products, FinOps — then packs, a tournament,
          challenges under constraint, and a UI that works for everyone. The world keeps happening.
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

function PackBody({ view, t, game }: { view: GameView; t: (key: string) => string; game: string }) {
  const pm = view.missions.pack;
  const [hint, setHint] = useState<string | null>(null);
  const [hintMeta, setHintMeta] = useState<{ index: number; remaining: number } | null>(null);

  useEffect(() => { setHint(null); setHintMeta(null); }, [pm?.id]);

  if (!pm) return null;

  const askHint = async () => {
    const r = await api.hint(view.id, true);
    setHint(r.hint ?? t('dock.noHints'));
    setHintMeta({ index: r.index, remaining: r.remaining });
  };

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line, #202938)', paddingTop: 12 }}>
      <div className="dimtxt" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--warn, #d9a03f)' }}>
        {t('dock.pack')}{pm.progress ? ` · ${pm.progress.round}/${pm.progress.of} — ${pm.progress.packName}` : ''}
      </div>
      <h3>{pm.title}</h3>
      <div className="objective">▸ {pm.objective}</div>
      <div style={{ marginTop: 8 }}>
        {pm.requirements.map((r) => (
          <div key={r.id} className={`req ${r.pass ? 'pass' : 'fail'}`}>
            <span className="mark">{r.pass ? '✓' : '○'}</span>
            <span>{r.label}</span>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={askHint}>💡 {t('dock.hint')} ({pm.hintsUsed}/{pm.hintsTotal})</button>
      </div>
      {hint && <div className="hintbox">HINT {hintMeta?.index}: {hint}</div>}
    </div>
  );
}
