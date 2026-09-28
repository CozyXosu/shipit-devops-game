// Mission engine: evaluates requirements against the live world, handles
// progression, hints, ratings, rewards, and mission lifecycle hooks.
import { GameState, World } from './types';
import { MISSIONS, MissionDef } from './missions/missions';
import { currentPackMissionOf, packMissionsOf, getPack } from './missions/packs';
import { audit, ensureTournament, finishTournament } from './world';
import { domainOf } from './world';

export function currentMission(state: GameState): MissionDef | null {
  return MISSIONS.find((m) => m.id === state.missions.current) ?? null;
}

/** The bonus track: the mission-pack mission currently on the board. */
export function currentPackMission(state: GameState): MissionDef | null {
  return currentPackMissionOf(state);
}

export function missionById(id: string): MissionDef | null {
  return MISSIONS.find((m) => m.id === id) ?? null;
}

export interface ReqResult { id: string; label: string; pass: boolean }

export function evalRequirements(m: MissionDef, world: World): ReqResult[] {
  return m.requirements.map((r) => {
    let pass = false;
    try { pass = r.check(world); } catch { pass = false; }
    return { id: r.id, label: r.label, pass };
  });
}

function ratingFor(hintsUsed: number, commandsRun: number): 'S' | 'A' | 'B' | 'C' {
  if (hintsUsed === 0 && commandsRun < 60) return 'S';
  if (hintsUsed === 0) return 'A';
  if (hintsUsed <= 1) return 'A';
  if (hintsUsed <= 2) return 'B';
  return 'C';
}

/**
 * Re-evaluate mission state; completes the current mission when all
 * requirements pass (then fires onComplete and advances). The chain runs
 * across the build → operate phase boundary; saves with no current mission
 * pick up the first unfinished one.
 */
export function evaluateMissions(state: GameState): { completed: MissionDef[] } {
  const completed: MissionDef[] = [];
  if (!state.missions.current && !state.world.flags.sandbox) {
    const nextUp = MISSIONS.find((m) => !state.missions.completed.includes(m.id));
    if (nextUp) {
      state.missions.current = nextUp.id;
      try { nextUp.onStart?.(state.world); } catch (e) { void e; }
    }
  }
  let guard = 0;
  while (guard++ < 25) {
    const m = currentMission(state);
    if (!m) break;
    const results = evalRequirements(m, state.world);
    if (!results.every((r) => r.pass)) break;
    // complete it
    const hints = state.missions.hintsUsed[m.id] ?? 0;
    const cmds = state.missions.attempts[m.id] ?? 0;
    const rating = ratingFor(hints, cmds);
    state.missions.ratings[m.id] = rating;
    state.missions.completed.push(m.id);
    state.world.company.cash += m.rewards.cash;
    for (const [k, v] of Object.entries(m.rewards.xp)) {
      state.skills[k] = (state.skills[k] ?? 0) + v;
      state.xp += v;
    }
    audit(state.world, 'system', 'mission', `MISSION COMPLETE: ${m.title} (rating ${rating}, +$${m.rewards.cash})`);
    m.onComplete?.(state.world);
    completed.push(m);
    const next = MISSIONS.find((x) => x.index === m.index + 1);
    state.missions.current = next ? next.id : '';
    if (next) {
      try { next.onStart?.(state.world); } catch (e) { void e; }
    }
  }
  // bonus track: mission packs run parallel to the career chain
  let packGuard = 0;
  while (packGuard++ < 10) {
    const pm = currentPackMissionOf(state);
    if (!pm) break;
    const results = evalRequirements(pm, state.world);
    if (!results.every((r) => r.pass)) break;
    const hints = state.missions.hintsUsed[pm.id] ?? 0;
    const cmds = state.missions.attempts[pm.id] ?? 0;
    state.missions.ratings[pm.id] = ratingFor(hints, cmds);
    state.missions.completed.push(pm.id);
    state.world.company.cash += pm.rewards.cash;
    for (const [k, v] of Object.entries(pm.rewards.xp)) {
      state.skills[k] = (state.skills[k] ?? 0) + v;
      state.xp += v;
    }
    state.world.flags.packMissionsDone = Number(state.world.flags.packMissionsDone ?? 0) + 1;
    if (pm.rewards.tournamentPoints) {
      const t = ensureTournament(state.world);
      t.points += pm.rewards.tournamentPoints;
      t.roundsWon += 1;
    }
    audit(state.world, 'system', 'mission', `PACK MISSION COMPLETE: ${pm.title} (rating ${state.missions.ratings[pm.id]}, +$${pm.rewards.cash}${pm.rewards.tournamentPoints ? `, +${pm.rewards.tournamentPoints} tournament points` : ''})`);
    pm.onComplete?.(state.world);
    // advance the pack track
    const packIds = state.packs ?? [];
    let nextPackId: string | null = null;
    for (const packId of packIds) {
      const pack = getPack(packId);
      if (!pack) continue;
      const missions = packMissionsOf(pack);
      const idx = missions.findIndex((x) => x.id === pm.id);
      if (idx >= 0 && idx + 1 < missions.length) nextPackId = missions[idx + 1].id;
      else if (idx === missions.length - 1 && pack.tournament) finishTournament(state.world);
    }
    state.missions.packCurrent = nextPackId ?? undefined;
    if (nextPackId) {
      const nextPm = currentPackMissionOf(state);
      try { nextPm?.onStart?.(state.world); } catch (e) { void e; }
    }
  }
  // mirror chain progress for declarative pack conditions
  state.world.flags.missionsDoneAll = state.missions.completed.length;
  return { completed };
}

/** Progressive hint; returns null when exhausted. Pass pack=true for the bonus track. */
export function takeHint(state: GameState, pack = false): { hint: string; index: number; remaining: number } | null {
  const m = pack ? currentPackMissionOf(state) : currentMission(state);
  if (!m) return null;
  const used = state.missions.hintsUsed[m.id] ?? 0;
  if (used >= m.hints.length) return null;
  state.missions.hintsUsed[m.id] = used + 1;
  return { hint: fillTemplate(m.hints[used], state.world), index: used + 1, remaining: m.hints.length - used - 1 };
}

/** Missions text uses {domain} placeholders — fill them at render time. */
export function fillTemplate(text: string, world: World): string {
  return text.replaceAll('{domain}', domainOf(world));
}

export function commandsRun(state: GameState): void {
  const m = currentMission(state);
  if (m) state.missions.attempts[m.id] = (state.missions.attempts[m.id] ?? 0) + 1;
}

export function allMissionSummaries(state: GameState) {
  return MISSIONS.map((m) => ({
    id: m.id,
    index: m.index,
    title: m.title,
    phase: m.phase,
    status: state.missions.completed.includes(m.id) ? 'completed' : state.missions.current === m.id ? 'active' : 'locked',
    rating: state.missions.ratings[m.id] ?? null,
    skills: m.skills
  }));
}
