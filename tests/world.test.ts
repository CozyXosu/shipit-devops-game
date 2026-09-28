import { describe, it, expect } from 'vitest';
import { createWorld, tick, costLineItems, monthlyInfraCost, uptimePct, provisionDb, diskUsagePct } from '../server/src/world';
import { evaluateMissions, allMissionSummaries, takeHint } from '../server/src/engine';
import { GameState } from '../server/src/types';
import { JsonStorage } from '../server/src/state';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function stateOf(world = createWorld('EcoCo', 'you')): GameState {
  return { id: 'eco', createdAt: 0, updatedAt: 0, world, missions: { completed: [], current: '', hintsUsed: {}, attempts: {}, ratings: {} }, skills: {}, xp: 0 };
}

describe('economy & metrics engine', () => {
  it('launched company gains users and revenue; costs accrue', () => {
    const s = stateOf();
    const cash0 = s.world.company.cash;
    s.world.company.launched = true;
    s.world.company.users = 10000;
    tick(s.world, 1440); // one day
    expect(s.world.company.users).toBeGreaterThan(10000);
    expect(s.world.company.cash).toBeGreaterThan(cash0 + 100);
    expect(s.world.monitoring.series.req_rate.length).toBeGreaterThan(100);
  });

  it('infra costs include provisioned services', () => {
    const s = stateOf();
    const base = monthlyInfraCost(s.world);
    provisionDb(s.world, 'db.medium');
    expect(monthlyInfraCost(s.world)).toBeGreaterThan(base);
    expect(costLineItems(s.world).some((i) => i.category === 'Database')).toBe(true);
  });

  it('high error rate drives uptime down', () => {
    const s = stateOf();
    s.world.company.launched = true;
    s.world.flags.badDeployBug = true;
    s.world.app.mode = 'container';
    tick(s.world, 60);
    expect(uptimePct(s.world)).toBeLessThan(100);
    expect(s.world.monitoring.series.error_pct.at(-1)!.v).toBeGreaterThan(5);
  });
});

describe('persistence', () => {
  it('save → new storage instance → load roundtrip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-'));
    const store = new JsonStorage(dir);
    const s = stateOf();
    s.world.company.users = 4321;
    await store.save(s);
    const store2 = new JsonStorage(dir);
    const loaded = await store2.load('eco');
    expect(loaded?.world.company.users).toBe(4321);
    expect(loaded?.world.company.name).toBe('EcoCo');
    expect((await store2.list()).length).toBe(1);
    expect(await store2.delete('eco')).toBe(true);
    expect(await store2.load('eco')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('mission engine', () => {
  it('hints are progressive and deplete', () => {
    const s = stateOf(createWorld('Acme Metrics', 'you'));
    s.missions.current = 'm01-ssh';
    const h1 = takeHint(s);
    expect(h1?.hint).toContain('ls');
    expect(h1?.remaining).toBe(2);
    takeHint(s);
    const h3 = takeHint(s);
    expect(h3?.remaining).toBe(0);
    expect(takeHint(s)).toBeNull();
    expect(s.missions.hintsUsed['m01-ssh']).toBe(3);
  });

  it('mission summaries report statuses; 40 missions across build + operate + ecosystem + bonus + trust + platform', () => {
    const s = stateOf(createWorld('Acme Metrics', 'you'));
    s.missions.current = 'm01-ssh';
    const sums = allMissionSummaries(s);
    expect(sums.find((m) => m.id === 'm01-ssh')?.status).toBe('active');
    expect(sums.find((m) => m.id === 'm02-dead-api')?.status).toBe('locked');
    expect(sums.length).toBe(40);
  });

  it('evaluateMissions is a no-op with no current mission', () => {
    const s = stateOf();
    expect(evaluateMissions(s).completed.length).toBe(0);
  });

  it('disk usage grows with logs before rotation', () => {
    const s = stateOf();
    const before = diskUsagePct(s.world);
    s.world.company.launched = true;
    tick(s.world, 100);
    expect(diskUsagePct(s.world)).toBeGreaterThan(before);
  });
});
