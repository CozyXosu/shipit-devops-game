// Mission packs (P4): JSON bundles of extra missions loaded at runtime.
// Core missions are code (their requirements close over world functions);
// pack missions are DATA — a small declarative condition DSL interpreted
// here, plus declarative onStart hooks (scheduled events, flags, audit).
import { GameState, World, Incident } from '../types';
import { MissionDef, Requirement } from './missions';
import * as fs from '../sim/fs';
import { uptimePct, ensureTournament } from '../world';
import builtinTournament from '../../../packs/postmortem-tournament.json';

// ---------- pack JSON schema ----------
export interface PackCondition {
  type: string;
  flag?: string;
  value?: boolean | number | string;
  service?: string;
  path?: string;
  text?: string;
  amount?: number;
  pct?: number;
  kind?: string;
  correctiveDoneAtLeast?: number;
  maxMin?: number;
  count?: number;
  points?: number;
  sinceStart?: boolean;
}

export interface PackMissionJson {
  id: string;
  title: string;
  story: string;
  objective: string;
  coaching: string;
  skills: string[];
  requirements: { id: string; label: string; check: PackCondition }[];
  hints: string[];
  rewards: { cash: number; xp: Record<string, number>; tournamentPoints?: number };
  onStart?: {
    schedule?: { kind: string; inMin: number; payload?: Record<string, unknown> }[];
    setFlags?: Record<string, boolean | number | string>;
    audit?: string;
  };
}

export interface PackJson {
  id: string;
  name: string;
  version: number;
  author?: string;
  description: string;
  /** tournament packs seed the rival scoreboard when activated */
  tournament?: boolean;
  /** activation gate: this mission must be completed (or the game is sandbox) */
  requiresCompleted?: string;
  missions: PackMissionJson[];
}

export interface PackMeta {
  id: string;
  name: string;
  version: number;
  author: string | null;
  description: string;
  tournament: boolean;
  missionCount: number;
  requiresCompleted: string | null;
}

// ---------- registry ----------
const REGISTRY = new Map<string, PackJson>();
const MISSION_CACHE = new Map<string, MissionDef[]>();

export function validatePack(json: unknown): { ok: boolean; message: string; pack?: PackJson } {
  const p = json as PackJson;
  if (!p || typeof p !== 'object') return { ok: false, message: 'pack must be a JSON object' };
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(p.id)) return { ok: false, message: 'pack.id must be a lowercase slug' };
  if (typeof p.name !== 'string' || !p.name) return { ok: false, message: 'pack.name required' };
  if (!Array.isArray(p.missions) || p.missions.length === 0) return { ok: false, message: 'pack.missions must be a non-empty array' };
  for (const m of p.missions) {
    if (typeof m.id !== 'string' || !m.id) return { ok: false, message: 'every mission needs an id' };
    if (!Array.isArray(m.requirements) || m.requirements.length === 0) return { ok: false, message: `mission ${m.id}: requirements required` };
    for (const r of m.requirements) {
      if (!r?.check || typeof r.check.type !== 'string') return { ok: false, message: `mission ${m.id}: every requirement needs a check.type` };
    }
    if (!Array.isArray(m.hints)) return { ok: false, message: `mission ${m.id}: hints array required (can be empty)` };
    if (!m.rewards || typeof m.rewards.cash !== 'number') return { ok: false, message: `mission ${m.id}: rewards.cash required` };
  }
  return { ok: true, message: 'ok', pack: p };
}

export function registerPack(json: unknown): { ok: boolean; message: string } {
  const v = validatePack(json);
  if (!v.ok) return v;
  const p = v.pack!;
  if (REGISTRY.has(p.id)) return { ok: false, message: `pack "${p.id}" already registered` };
  REGISTRY.set(p.id, p);
  return { ok: true, message: `pack "${p.id}" registered (${p.missions.length} missions)` };
}

// the built-in tournament pack ships as a real JSON bundle
void registerPack(builtinTournament);

export function getPack(id: string): PackJson | null {
  return REGISTRY.get(id) ?? null;
}

export function availablePacks(): PackMeta[] {
  return [...REGISTRY.values()].map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    author: p.author ?? null,
    description: p.description,
    tournament: Boolean(p.tournament),
    missionCount: p.missions.length,
    requiresCompleted: p.requiresCompleted ?? null
  }));
}

// ---------- condition DSL interpreter ----------
export function startFlagKey(missionId: string): string {
  return `pack_${missionId}_start`;
}

function numFlag(w: World, key: string): number {
  const v = w.flags[key];
  return typeof v === 'number' ? v : 0;
}

function incidentsSince(w: World, startedAtMin: number, kind?: string): Incident[] {
  return w.monitoring.incidents.filter(
    (i) => i.openedAtMin >= startedAtMin && (kind === undefined || i.kind === kind)
  );
}

/** Evaluate one declarative condition against the world. */
export function checkCondition(w: World, c: PackCondition, startedAtMin: number): boolean {
  const start = c.sinceStart ? startedAtMin : 0;
  switch (c.type) {
    case 'flag': {
      const have = w.flags[c.flag ?? ''];
      return c.value === undefined ? Boolean(have) : have === c.value;
    }
    case 'serviceActive':
      return w.hosts['web-01'].services[c.service ?? '']?.state === 'active';
    case 'fileExists':
      return Boolean(fs.getFile(w.hosts['web-01'].fs, c.path ?? '/'));
    case 'fileContains':
      return (fs.readFile(w.hosts['web-01'].fs, c.path ?? '/') ?? '').includes(c.text ?? '\u0000');
    case 'cashAtLeast':
      return w.company.cash >= (c.amount ?? 0);
    case 'uptimeAtLeast':
      return uptimePct(w) >= (c.pct ?? 0);
    case 'incidentOpened':
      return incidentsSince(w, start, c.kind).length > 0;
    case 'incidentResolved':
      return incidentsSince(w, start, c.kind).some((i) => i.status === 'resolved');
    case 'postmortemFiled':
      return incidentsSince(w, start, c.kind).some(
        (i) => i.postmortemFiled && i.corrective.filter((a) => a.done).length >= (c.correctiveDoneAtLeast ?? 1)
      );
    case 'incidentTimelineContains':
      return incidentsSince(w, start, c.kind).some((i) => i.timeline.some((ev) => ev.text.includes(c.text ?? '\u0000')));
    case 'mttrWithin': {
      const incs = incidentsSince(w, start);
      return incs.length > 0 && incs.every(
        (i) => i.status === 'resolved' && i.resolvedAtMin !== undefined && i.resolvedAtMin - i.openedAtMin <= (c.maxMin ?? 60)
      );
    }
    case 'missionsCompletedAtLeast':
      // core chain completions are mirrored into a flag by the engine
      return numFlag(w, 'missionsDoneAll') >= (c.count ?? 1) || numFlag(w, 'packMissionsDone') >= (c.count ?? 1);
    case 'packMissionsDoneAtLeast':
      return numFlag(w, 'packMissionsDone') >= (c.count ?? 1);
    case 'tournamentPointsAtLeast':
      return (w.tournament?.points ?? 0) >= (c.points ?? 1);
    case 'noOpenIncidents':
      return !w.monitoring.incidents.some((i) => i.status === 'open');
    case 'satisfactionAtLeast':
      return w.company.satisfaction >= (c.pct ?? 0);
    case 'dbOrdersRowsAtLeast':
      return (w.db.tables['orders']?.rowCount ?? 0) >= (c.count ?? 0);
    default:
      return false;
  }
}

// ---------- pack → MissionDef conversion ----------
export function packMissionsOf(pack: PackJson): MissionDef[] {
  const cached = MISSION_CACHE.get(pack.id);
  if (cached) return cached;
  const defs: MissionDef[] = pack.missions.map((pm, i) => {
    const startKey = startFlagKey(pm.id);
    const requirements: Requirement[] = pm.requirements.map((r) => ({
      id: r.id,
      label: r.label,
      check: (w: World) => checkCondition(w, r.check, numFlag(w, startKey))
    }));
    const def: MissionDef = {
      id: pm.id,
      index: 200 + i,
      title: pm.title,
      phase: 'bonus',
      story: pm.story,
      objective: pm.objective,
      coaching: pm.coaching,
      skills: pm.skills,
      requirements,
      hints: pm.hints,
      rewards: { cash: pm.rewards.cash, xp: pm.rewards.xp, tournamentPoints: pm.rewards.tournamentPoints },
      onStart: (w: World) => {
        w.flags[startKey] = w.nowMin;
        for (const s of pm.onStart?.schedule ?? []) {
          w.scheduledEvents.push({ atMin: w.nowMin + s.inMin, kind: s.kind, payload: s.payload });
        }
        for (const [k, v] of Object.entries(pm.onStart?.setFlags ?? {})) {
          w.flags[k] = v;
        }
        if (pm.onStart?.audit) {
          w.audit.push({ t: w.nowMin, actor: 'system', kind: 'game', text: pm.onStart.audit });
        }
      }
    };
    return def;
  });
  MISSION_CACHE.set(pack.id, defs);
  return defs;
}

/** The pack-mission track runs parallel to the core chain. */
export function currentPackMissionOf(state: GameState): MissionDef | null {
  if (!state.missions.packCurrent) return null;
  for (const packId of state.packs ?? []) {
    const pack = getPack(packId);
    if (!pack) continue;
    const m = packMissionsOf(pack).find((x) => x.id === state.missions.packCurrent);
    if (m) return m;
  }
  return null;
}

/** Activate a pack: append it to the bonus track and start its first mission. */
export function activatePack(state: GameState, packId: string): { ok: boolean; message: string } {
  const pack = getPack(packId);
  if (!pack) return { ok: false, message: `unknown mission pack "${packId}"` };
  if ((state.packs ?? []).includes(packId)) return { ok: false, message: 'pack already active' };
  const gate = pack.requiresCompleted;
  const gated = gate && !state.missions.completed.includes(gate) && !state.world.flags.sandbox;
  if (gated) return { ok: false, message: `this pack opens after mission "${gate}" (or in sandbox)` };
  state.packs = [...(state.packs ?? []), packId];
  state.missions.packCurrent = pack.missions[0].id;
  state.world.flags.packActivated = true;
  if (pack.tournament) ensureTournament(state.world);
  return { ok: true, message: `${pack.name} active — ${pack.missions.length} bonus missions on the board` };
}
