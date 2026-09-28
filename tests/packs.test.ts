// P4 — mission packs: JSON loading, the declarative condition DSL, the
// parallel bonus track, the postmortem tournament, and the m29–m32 chain.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { createWorld, tick, provisionDb, enableBackups, restoreBackup, filePostmortem, ensureCloud, claimSlcCredit, ensureTournament, finishTournament } from '../server/src/world';
import { rollback, deployImage } from '../server/src/sim/ci';
import { evaluateMissions, currentMission, currentPackMission } from '../server/src/engine';
import { validatePack, registerPack, availablePacks, getPack, packMissionsOf, activatePack, checkCondition, currentPackMissionOf, startFlagKey } from '../server/src/missions/packs';

function makeState(opts: { m28?: boolean } = {}): GameState {
  const world = createWorld('Pack Co', 'you');
  world.flags.sandbox = true;
  const state: GameState = { id: 't', createdAt: 0, updatedAt: 0, world, missions: { completed: [], current: '', hintsUsed: {}, attempts: {}, ratings: {} }, skills: {}, xp: 0 };
  if (opts.m28) state.missions.completed.push('m28-finops');
  return state;
}

const evalM = (s: GameState) => evaluateMissions(s);

describe('pack registry', () => {
  it('ships the built-in tournament pack as a real JSON bundle', () => {
    const packs = availablePacks();
    const t = packs.find((p) => p.id === 'postmortem-tournament');
    expect(t).toBeDefined();
    expect(t!.missionCount).toBe(5);
    expect(t!.tournament).toBe(true);
    expect(getPack('postmortem-tournament')!.missions[0].id).toBe('pmr-01');
  });

  it('validates and rejects malformed bundles', () => {
    expect(validatePack({}).ok).toBe(false);
    expect(validatePack({ id: 'X', name: 'bad id' }).ok).toBe(false);
    expect(validatePack({ id: 'ok-pack', name: 'Ok' }).ok).toBe(false); // no missions
    const good = validatePack({
      id: 'mini-pack', name: 'Mini', version: 1, description: 'd',
      missions: [{ id: 'mp-1', title: 'T', story: 's', objective: 'o', coaching: 'c', skills: ['linux'], requirements: [{ id: 'r', label: 'L', check: { type: 'flag', flag: 'x' } }], hints: [], rewards: { cash: 1, xp: {} } }]
    });
    expect(good.ok).toBe(true);
    expect(registerPack(good.pack).ok).toBe(true);
    expect(registerPack(good.pack).ok).toBe(false); // duplicate id
    expect(availablePacks().some((p) => p.id === 'mini-pack')).toBe(true);
  });

  it('activates with a gate on the required mission (or sandbox)', () => {
    const gated = makeState({ m28: false });
    gated.world.flags.sandbox = false;
    gated.world.flags.ecosystemPhaseComplete = false;
    expect(activatePack(gated, 'postmortem-tournament').ok).toBe(false);
    const s = makeState({ m28: true });
    const r = activatePack(s, 'postmortem-tournament');
    expect(r.ok).toBe(true);
    expect(s.missions.packCurrent).toBe('pmr-01');
    expect(s.world.flags.packActivated).toBe(true);
    expect(s.world.tournament).toBeDefined();
    expect(s.world.tournament!.rivals.map((x) => x.name)).toEqual(['Cloud Nine', 'Null Pointers', 'Ping Payments']);
    expect(activatePack(s, 'postmortem-tournament').ok).toBe(false); // no double activation
  });
});

describe('condition DSL', () => {
  const s = makeState();
  const w = s.world;
  w.flags.dslFlag = true;
  w.company.cash = 5000;
  w.db.tables['orders'] = { name: 'orders', columns: [], rowCount: 1000000, indexes: [] };

  it('interprets the core condition types', () => {
    expect(checkCondition(w, { type: 'flag', flag: 'dslFlag' }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'flag', flag: 'nope' }, 0)).toBe(false);
    expect(checkCondition(w, { type: 'fileContains', path: '/opt/app/config.js', text: 'dbPassword' }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'fileExists', path: '/opt/app/config.js' }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'cashAtLeast', amount: 4999 }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'dbOrdersRowsAtLeast', count: 900000 }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'noOpenIncidents' }, 0)).toBe(true);
    expect(checkCondition(w, { type: 'serviceActive', service: 'api' }, 0)).toBe(false);
    expect(checkCondition(w, { type: 'made-up-type' }, 0)).toBe(false);
  });

  it('scopes incidents and postmortems to sinceStart', () => {
    const kind = 'traffic_spike';
    w.monitoring.incidents.unshift({
      id: 'old-1', kind, title: 't', symptom: 's', severity: 'SEV2', openedAtMin: 10, resolvedAtMin: 30,
      status: 'resolved', rootCause: 'r', customerImpact: 'c', detectedBy: 'd', timeline: [],
      corrective: [{ id: 'a', label: 'A', done: true }, { id: 'b', label: 'B', done: true }], postmortemFiled: true
    });
    expect(checkCondition(w, { type: 'incidentResolved', kind, sinceStart: true }, 50)).toBe(false); // opened before start
    expect(checkCondition(w, { type: 'incidentResolved', kind }, 0)).toBe(true); // not scoped
    expect(checkCondition(w, { type: 'postmortemFiled', kind, correctiveDoneAtLeast: 2, sinceStart: true }, 5)).toBe(true); // opened at 10 ≥ 5
    expect(checkCondition(w, { type: 'mttrWithin', maxMin: 19, sinceStart: true }, 5)).toBe(false); // took 20 min
    expect(checkCondition(w, { type: 'mttrWithin', maxMin: 20, sinceStart: true }, 5)).toBe(true);
    w.monitoring.incidents.shift();
  });
});

describe('postmortem tournament playthrough', () => {
  it('round 1 — surge resolved, postmortem filed, MTTR held', () => {
    const s = makeState({ m28: true });
    provisionDb(s.world, 'db.small');
    enableBackups(s.world); // for round 4 later
    ensureCloud(s.world);   // for round 3
    activatePack(s, 'postmortem-tournament');
    const pm = currentPackMissionOf(s)!;
    expect(pm.id).toBe('pmr-01');
    pm.onStart!(s.world); // the API activate endpoint fires this
    expect(typeof s.world.flags[startFlagKey('pmr-01')]).toBe('number');
    expect(s.world.scheduledEvents.some((e) => e.kind === 'ambient_incident')).toBe(true);

    tick(s.world, 12); // surge opens ~+10
    const inc = s.world.monitoring.incidents.find((i) => i.kind === 'traffic_spike' && i.status === 'open');
    expect(inc).toBeDefined();
    tick(s.world, 130); // spike ends at +120, incident auto-resolves
    expect(inc!.status).toBe('resolved');
    expect(filePostmortem(s.world, inc!.id, ['autoscale', 'trafficalert']).ok).toBe(true);
    evalM(s);
    expect(s.missions.completed).toContain('pmr-01');
    expect(s.world.tournament!.points).toBe(8);
    expect(Number(s.world.flags.packMissionsDone)).toBe(1);
    expect(s.missions.packCurrent).toBe('pmr-02');
  });

  it('rounds 2–5 — rollback, provider outage + credit, restore, trophy', () => {
    // rebuild the state through round 1 compactly (fresh world, same flow)
    const s = makeState({ m28: true });
    provisionDb(s.world, 'db.small');
    enableBackups(s.world);
    ensureCloud(s.world);
    activatePack(s, 'postmortem-tournament');
    currentPackMissionOf(s)!.onStart!(s.world);
    tick(s.world, 140);
    const surge = s.world.monitoring.incidents.find((i) => i.kind === 'traffic_spike');
    filePostmortem(s.world, surge!.id, ['autoscale', 'trafficalert']);
    evalM(s);
    expect(s.missions.packCurrent).toBe('pmr-02');

    // round 2: bad deploy injected, roll it back fast (a real game has deployment history)
    deployImage(s.world, 'registry.packco.dev/api:v1.8.0', 'api', 'manual');
    deployImage(s.world, 'registry.packco.dev/api:v1.9.0', 'api', 'ci');
    tick(s.world, 12);
    const bad = s.world.monitoring.incidents.find((i) => i.kind === 'bad_deploy' && i.status === 'open');
    expect(bad).toBeDefined();
    expect(s.world.flags.badDeployBug).toBe(true);
    expect(rollback(s.world, 'api').ok).toBe(true);
    tick(s.world, 5);
    expect(bad!.status).toBe('resolved');
    filePostmortem(s.world, bad!.id, ['rollback', 'erralert', 'staging']);
    evalM(s);
    expect(s.missions.completed).toContain('pmr-02');
    expect(s.world.tournament!.points).toBe(18);
    expect(s.missions.packCurrent).toBe('pmr-03');

    // round 3: provider outage — survive, claim the credit, postmortem
    tick(s.world, 20); // outage opens ~+15
    const outage = s.world.monitoring.incidents.find((i) => i.kind === 'provider_outage');
    expect(outage).toBeDefined();
    for (let i = 0; i < 60 && outage!.status === 'open'; i++) tick(s.world, 1);
    expect(outage!.status).toBe('resolved');
    expect(claimSlcCredit(s.world).ok).toBe(true);
    expect(outage!.timeline.some((ev) => ev.text.includes('SLA credit claimed'))).toBe(true);
    filePostmortem(s.world, outage!.id, ['credit', 'statuspage']);
    evalM(s);
    expect(s.missions.completed).toContain('pmr-03');
    expect(s.world.tournament!.points).toBe(28);
    expect(s.missions.packCurrent).toBe('pmr-04');

    // round 4: the database drop — restore fast
    tick(s.world, 12);
    const drop = s.world.monitoring.incidents.find((i) => i.kind === 'data_loss' && i.status === 'open');
    expect(drop).toBeDefined();
    expect(s.world.db.tables['orders']?.rowCount).toBe(0);
    tick(s.world, 20); // operator reacts
    expect(restoreBackup(s.world).ok).toBe(true);
    expect(s.world.db.tables['orders']?.rowCount).toBeGreaterThanOrEqual(900000);
    tick(s.world, 1); // the restored rows close the incident
    expect(drop!.status).toBe('resolved');
    filePostmortem(s.world, drop!.id, ['restore', 'backups', 'pitr']);
    evalM(s);
    expect(s.missions.completed).toContain('pmr-04');
    // a decisive run satisfies the trophy round immediately: same-pass cascade
    expect(s.world.tournament!.points).toBeGreaterThanOrEqual(40);

    // round 5: the trophy — calm board, all rounds, points on top. A decisive
    // run already satisfies it, so the engine cascades it in the same pass.
    const rivals = s.world.tournament!.rivals.map((r) => r.points);
    expect(Math.max(...rivals)).toBeLessThan(40); // decisive run beats the board
    evalM(s);
    expect(s.missions.completed).toContain('pmr-05');
    expect(s.world.tournament!.points).toBe(46);
    expect(s.world.tournament!.finished).toBe(true);
    expect(s.world.tournament!.place).toBe(1);
    expect(s.missions.packCurrent).toBeUndefined();
  });

  it('rivals score while the clock runs and freeze at the finish', () => {
    const s = makeState({ m28: true });
    ensureTournament(s.world);
    tick(s.world, 150); // ~10 rival ticks
    expect(s.world.tournament!.rivals.every((r) => r.points > 0)).toBe(true);
    finishTournament(s.world);
    const frozen = s.world.tournament!.rivals.map((r) => r.points);
    tick(s.world, 60);
    expect(s.world.tournament!.rivals.map((r) => r.points)).toEqual(frozen);
  });
});

describe('P4 chain m29 → m32', () => {
  function atMission(id: string): GameState {
    const s = makeState({ m28: true });
    s.world.flags.ecosystemPhaseComplete = true;
    s.missions.current = id;
    return s;
  }

  it('m29 completes when a pack is active and round 1 is won', () => {
    const s = atMission('m29-packs');
    activatePack(s, 'postmortem-tournament');
    s.world.flags.packMissionsDone = 1;
    evalM(s);
    expect(s.missions.completed).toContain('m29-packs');
    expect(currentMission(s)?.id).toBe('m30-tournament');
  });

  it('m30 requires the full tournament won from first place', () => {
    const s = atMission('m30-tournament');
    s.world.flags.packMissionsDone = 3;
    const t = ensureTournament(s.world);
    t.points = 30;
    evalM(s);
    expect(s.missions.completed).not.toContain('m30-tournament'); // not finished yet
    s.world.flags.packMissionsDone = 5;
    t.points = 46;
    finishTournament(s.world);
    t.place = 1;
    evalM(s);
    expect(s.missions.completed).toContain('m30-tournament');
    expect(currentMission(s)?.id).toBe('m31-challenge');
  });

  it('m31 completes on a passed challenge', () => {
    const s = atMission('m31-challenge');
    s.world.flags.challengesStarted = 1;
    evalM(s);
    expect(s.missions.completed).not.toContain('m31-challenge');
    s.world.flags.challengesPassed = 1;
    evalM(s);
    expect(s.missions.completed).toContain('m31-challenge');
    expect(currentMission(s)?.id).toBe('m32-access');
  });

  it('m32 completes on accessibility + locale, closing the P4 milestone', () => {
    const s = atMission('m32-access');
    s.world.flags.a11yUsed = true;
    evalM(s);
    expect(s.missions.completed).not.toContain('m32-access');
    s.world.flags.locale = 'de';
    evalM(s);
    expect(s.missions.completed).toContain('m32-access');
    expect(s.world.flags.scalePhaseComplete).toBe(true);
    expect(currentMission(s)?.id).toBe('m33-vault'); // P5 continues the chain
    expect(s.missions.ratings['m32-access']).toBeDefined();
  });
});
