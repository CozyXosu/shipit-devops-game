// P4 — challenge mode: catalog math, gating, and the three constraint runs.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { createWorld, tick, provisionDb, resizeDb, installMonitoringAgent, enableBackups, restoreBackup, monthlyInfraCost, startChallenge as start } from '../server/src/world';
import { budgetCapOf, windowedAvailability, challengeStars, CHALLENGES, challengeOf } from '../server/src/sim/challenges';

function makeState(): GameState {
  const world = createWorld('Challenge Co', 'you');
  world.flags.sandbox = true; // challenges open in sandbox without finishing m28
  return { id: 't', createdAt: 0, updatedAt: 0, world, missions: { completed: [], current: '', hintsUsed: {}, attempts: {}, ratings: {} }, skills: {}, xp: 0 };
}

describe('challenge catalog & math', () => {
  it('ships three constraints: budget, availability, RTO', () => {
    expect(CHALLENGES.map((c) => c.rule)).toEqual(['budget', 'availability', 'rto']);
    expect(challengeOf('four-nines')?.availabilityFloorPct).toBe(99.5);
    expect(challengeOf('nope')).toBeNull();
  });

  it('computes the budget cap from the starting bill', () => {
    const def = challengeOf('budget-blitz')!;
    expect(budgetCapOf(def, 1000)).toBe(820); // 18% mandated cut
  });

  it('computes windowed availability from bad minutes only inside the window', () => {
    expect(windowedAvailability(0, 2880)).toBe(100);
    expect(windowedAvailability(14.4, 2880)).toBeCloseTo(99.5, 5);
    expect(windowedAvailability(120, 1440)).toBeCloseTo(91.67, 2);
    expect(windowedAvailability(-5, 1440)).toBe(100); // decay below snapshot clamps
  });

  it('grades stars by margin (budget score = cut achieved %)', () => {
    const b = challengeOf('budget-blitz')!;
    expect(challengeStars('budget', 30, b)).toBe(3); // 18 mandated, 30 achieved
    expect(challengeStars('budget', 23, b)).toBe(2);
    expect(challengeStars('budget', 18.5, b)).toBe(1);
    const a = challengeOf('four-nines')!;
    expect(challengeStars('availability', 99.95, a)).toBe(3);
    expect(challengeStars('availability', 99.65, a)).toBe(2);
    expect(challengeStars('availability', 99.52, a)).toBe(1);
    expect(challengeStars('rto', 60, challengeOf('back-from-dead')!)).toBe(3);
    expect(challengeStars('rto', 119, challengeOf('back-from-dead')!)).toBe(1);
  });
});

describe('challenge gating', () => {
  it('refuses to start before mission 28 outside sandbox', () => {
    const world = createWorld('Gated', 'you'); // career world, no ecosystem flag
    const r = start(world, 'budget-blitz');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('mission 28');
    world.flags.ecosystemPhaseComplete = true;
    expect(start(world, 'budget-blitz').ok).toBe(true);
  });

  it('rejects unknown challenges and overlaps', () => {
    const s = makeState();
    expect(start(s.world, 'nonsense').ok).toBe(false);
    expect(start(s.world, 'budget-blitz').ok).toBe(true);
    expect(start(s.world, 'four-nines').ok).toBe(false); // one at a time
  });
});

describe('budget challenge', () => {
  it('passes when the bill holds under the cap, with score and prize', () => {
    const s = makeState();
    installMonitoringAgent(s.world);
    provisionDb(s.world, 'db.small');
    enableBackups(s.world);
    const billAtStart = monthlyInfraCost(s.world);
    expect(start(s.world, 'budget-blitz').ok).toBe(true);
    const cap = s.world.challenge!.capMonthly!;
    expect(cap).toBe(Math.round(billAtStart * 0.82));
    // rightsizing: db.small → db.micro drops the bill under the cap
    resizeDb(s.world, 'db.micro');
    expect(monthlyInfraCost(s.world)).toBeLessThanOrEqual(cap);
    const cashBefore = s.world.company.cash;
    tick(s.world, 2900); // two full sim days of daily verdicts + final
    const run = s.world.challenge!;
    expect(run.status).toBe('passed');
    expect(run.days.every((d) => d.ok)).toBe(true);
    expect(run.score).toBeGreaterThan(0);
    expect(s.world.flags.challengesPassed).toBe(1);
    expect(s.world.company.cash).toBeGreaterThan(cashBefore + 4000); // prize + revenue margin
  });

  it('fails the day the bill crosses the cap', () => {
    const s = makeState();
    provisionDb(s.world, 'db.small');
    expect(start(s.world, 'budget-blitz').ok).toBe(true);
    const cap = s.world.challenge!.capMonthly!;
    expect(monthlyInfraCost(s.world)).toBeGreaterThan(cap); // no cuts made
    tick(s.world, 1450); // first daily verdict
    const run = s.world.challenge!;
    expect(run.status).toBe('failed');
    expect(run.days[0].ok).toBe(false);
    expect(Number(s.world.flags.challengesPassed ?? 0)).toBe(0);
  });
});

describe('availability challenge', () => {
  it('arms pop quizzes (failover drill + traffic spike) on accept', () => {
    const s = makeState();
    expect(start(s.world, 'four-nines').ok).toBe(true);
    const kinds = s.world.scheduledEvents.map((e) => e.kind);
    expect(kinds).toContain('ha_drill');
    expect(kinds).toContain('traffic_spike');
  });

  it('passes a calm two days at 100% windowed availability', () => {
    const s = makeState();
    expect(start(s.world, 'four-nines').ok).toBe(true);
    s.world.scheduledEvents = []; // deterministic: no pop quizzes in this run
    tick(s.world, 2900);
    const run = s.world.challenge!;
    expect(run.status).toBe('passed');
    expect(run.score).toBeGreaterThanOrEqual(99.9);
  });

  it('fails when bad minutes blow the floor', () => {
    const s = makeState();
    expect(start(s.world, 'four-nines').ok).toBe(true);
    s.world.scheduledEvents = [];
    tick(s.world, 100);
    s.world.flags.uptimeBadMin = 30; // a real outage during the audited window
    tick(s.world, 1400);
    const run = s.world.challenge!;
    expect(run.status).toBe('failed');
    expect(run.verdict).toContain('99.5% floor');
  });
});

describe('RTO challenge', () => {
  function armDisasterWorld() {
    const s = makeState();
    provisionDb(s.world, 'db.small');
    enableBackups(s.world); // snapshot exists before the disaster
    expect(start(s.world, 'back-from-dead').ok).toBe(true);
    const run = s.world.challenge!;
    expect(run.disasterAtMin).toBeGreaterThan(s.world.nowMin + 170);
    return s;
  }

  it('drops the orders table at the armed minute', () => {
    const s = armDisasterWorld();
    const at = s.world.challenge!.disasterAtMin!;
    tick(s.world, at - s.world.nowMin - 1);
    expect((s.world.db.tables['orders']?.rowCount ?? 0)).toBeGreaterThan(0);
    tick(s.world, 2); // the event fires the minute the clock reaches it
    expect(s.world.db.tables['orders']?.rowCount).toBe(0);
    expect(s.world.monitoring.incidents.some((i) => i.kind === 'data_loss' && i.status === 'open')).toBe(true);
  });

  it('passes early on a fast verified restore (score = restore minutes)', () => {
    const s = armDisasterWorld();
    const at = s.world.challenge!.disasterAtMin!;
    tick(s.world, at - s.world.nowMin + 1); // disaster lands
    tick(s.world, 25); // ...operator reads the pager, then:
    const r = restoreBackup(s.world);
    expect(r.ok).toBe(true);
    tick(s.world, 2);
    const run = s.world.challenge!;
    expect(run.status).toBe('passed');
    expect(run.score).toBeLessThanOrEqual(120);
    expect(s.world.flags.challengesPassed).toBe(1);
  });

  it('fails via provider emergency recovery when no restore happens', () => {
    const s = armDisasterWorld();
    const at = s.world.challenge!.disasterAtMin!;
    tick(s.world, at - s.world.nowMin + 1);
    tick(s.world, 260); // challenge_recover_fail fires at disaster+240
    const run = s.world.challenge!;
    expect(run.status).toBe('failed');
    expect(run.verdict).toContain('RTO blown');
    expect(s.world.db.tables['orders']?.rowCount).toBeGreaterThan(900000); // provider restored, expensively
  });
});
