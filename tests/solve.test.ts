// The auto-solve feature: every career mission (m01 → m40) and the tournament
// pack track must be solvable end-to-end by solveMission(), producing a
// non-empty step transcript for the player to read.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { createWorld } from '../server/src/world';
import { solveMission } from '../server/src/missions/solvers';
import { activatePack, currentPackMissionOf } from '../server/src/missions/packs';
import { MISSIONS } from '../server/src/missions/missions';

function newGame(): GameState {
  return {
    id: 'solve', createdAt: 0, updatedAt: 0,
    world: createWorld('Acme Metrics', 'you'),
    missions: { completed: [], current: 'm01-ssh', hintsUsed: {}, attempts: {}, ratings: {} },
    skills: {}, xp: 0
  };
}

let state: GameState;

/** Solve forward until the chain stalls, completes, or reaches stopBefore
 *  (the mission that should be NEXT). Returns ids that FAILED. */
function solveUntil(stopBefore = ''): string[] {
  const failed: string[] = [];
  let guard = 0;
  while (state.missions.current && state.missions.current !== stopBefore && guard++ < 60) {
    const r = solveMission(state);
    expect(r.ok, `${r.missionId}: ${r.message}`).toBe(true);
    expect(r.steps.length, `${r.missionId} produced no steps`).toBeGreaterThan(0);
    if (!r.completed) { failed.push(r.missionId); return failed; }
    expect(r.requirements.every((x) => x.pass), `${r.missionId} requirements`).toBe(true);
  }
  return failed;
}

describe('auto-solve: full career chain', () => {
  it('solves the build phase m01 → m20', () => {
    state = newGame();
    expect(solveUntil('m21-team')).toEqual([]);
    expect(state.missions.completed).toContain('m20-dr');
    expect(state.missions.current).toBe('m21-team');
  }, 120000);

  it('solves the operate phase m21 → m24', () => {
    expect(solveUntil('m25-clouds')).toEqual([]);
    expect(state.missions.completed).toContain('m24-slo');
  }, 120000);

  it('solves the ecosystem phase m25 → m28', () => {
    expect(solveUntil('m29-packs')).toEqual([]);
    expect(state.missions.completed).toContain('m28-finops');
  }, 120000);

  it('solves the bonus chain m29 → m32 (pack + tournament + challenge + a11y)', () => {
    expect(solveUntil('m33-vault')).toEqual([]);
    expect(state.missions.completed).toContain('m32-access');
    // m29/m30 played the whole tournament as a side effect
    expect(state.world.tournament?.finished).toBe(true);
    expect(state.world.tournament?.place).toBe(1);
    expect(Number(state.world.flags.challengesPassed)).toBe(1);
  }, 120000);

  it('solves the trust phase m33 → m36', () => {
    expect(solveUntil('m37-portal')).toEqual([]);
    expect(state.missions.completed).toContain('m36-audit');
  }, 120000);

  it('solves the platform endgame m37 → m40 (legend mode)', () => {
    expect(solveUntil()).toEqual([]);
    const career = state.missions.completed.filter((id) => MISSIONS.some((m) => m.id === id));
    expect(career).toHaveLength(MISSIONS.length);
    expect(state.missions.current).toBe('');
    expect(state.world.flags.legendMode).toBe(true);
  }, 120000);
});

describe('auto-solve: pack track', () => {
  it('solves the tournament pack mission by mission', () => {
    state = newGame();
    state.world.flags.sandbox = true;
    state.missions.completed.push('m28-finops');
    expect(activatePack(state, 'postmortem-tournament').ok).toBe(true);
    currentPackMissionOf(state)!.onStart!(state.world);
    let guard = 0;
    while (currentPackMissionOf(state) && guard++ < 10) {
      const r = solveMission(state, { pack: true });
      expect(r.ok, `${r.missionId}: ${r.message}`).toBe(true);
      expect(r.steps.length, `${r.missionId} produced no steps`).toBeGreaterThan(0);
      expect(r.completed, `pack mission ${r.missionId} did not complete`).toBe(true);
    }
    expect(state.world.tournament?.finished).toBe(true);
    expect(state.world.tournament?.place).toBe(1);
    expect(state.missions.packCurrent).toBeUndefined();
  }, 120000);

  it('declines gracefully with no current mission', () => {
    state = newGame();
    state.missions.current = '';
    const r = solveMission(state);
    expect(r.ok).toBe(false);
    expect(r.steps).toEqual([]);
    const p = solveMission(state, { pack: true });
    expect(p.ok).toBe(false);
  });

  it('is a no-op transcript when every requirement already passes', () => {
    state = newGame();
    state.world.flags.readHandoff = true;
    state.world.session = { ...state.world.session, hostId: 'web-01', user: 'dev', cwd: '/home/dev' };
    const r = solveMission(state);
    expect(r.completed).toBe(true);
    expect(r.steps[0].kind).toBe('note');
    expect(state.missions.completed).toContain('m01-ssh');
  });
});
