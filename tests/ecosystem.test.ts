// Ecosystem-phase unit tests (P3): providers, outages & SLA credits,
// migrations, products, FinOps recommendations and budgets.
import { describe, it, expect } from 'vitest';
import {
  createWorld, tick, latest, ensureCloud, runCloudComparison, openProviderOutage, claimSlcCredit,
  startMigration, monthlyInfraCost, monthlyInfraCostAt, costLineItems, ensureProducts, startProduct,
  productMrrOf, baseMrrOf, productBlockers, ensureFinops, setFinopsBudget, setFinopsBaseline,
  reserveCompute, finopsRecommendations, decommissionVm, provisionVm, provisionLb, enableBackups,
  provisionDb, configureSlos, hireEngineer
} from '../server/src/world';
import { PROVIDERS, providerOf, regionOf, costMultiplierOf, plannedDowntimeMin, slaCreditFor, migrationCostOf } from '../server/src/sim/cloud';
import { provisionCluster, resizeNodePool } from '../server/src/sim/k8s';
import { World } from '../server/src/types';

function ecoWorld(): World {
  const w = createWorld('Acme Metrics', 'you');
  w.company.launched = true;
  w.company.users = 20000;
  w.app.mode = 'service'; // "running" so metrics flow
  w.flags.buildPhaseComplete = true;
  ensureCloud(w);
  return w;
}

describe('provider catalog & pricing', () => {
  it('three providers with the designed tradeoffs', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['orbit', 'stratus', 'volt']);
    expect(PROVIDERS.volt.priceMult).toBeLessThan(PROVIDERS.stratus.priceMult);
    expect(PROVIDERS.orbit.priceMult).toBeGreaterThan(PROVIDERS.stratus.priceMult);
    expect(PROVIDERS.volt.reliabilityPct).toBeLessThan(PROVIDERS.orbit.reliabilityPct);
    expect(PROVIDERS.volt.outageChancePerDay).toBeGreaterThan(PROVIDERS.orbit.outageChancePerDay);
    for (const p of Object.values(PROVIDERS)) expect(p.regions.length).toBeGreaterThanOrEqual(2);
  });

  it('prices the same stack cheapest on Volt, priciest on Orbit', () => {
    const w = ecoWorld();
    provisionDb(w, 'db.small');
    const volt = monthlyInfraCostAt(w, 'volt', 'us-central-1');
    const stratus = monthlyInfraCostAt(w, 'stratus', 'us-east-1');
    const orbit = monthlyInfraCostAt(w, 'orbit', 'us-east-2');
    expect(volt).toBeLessThan(stratus);
    expect(orbit).toBeGreaterThan(stratus);
    expect(Math.round(stratus * 0.72)).toBe(volt); // 0.72 × region 1.0
  });

  it('line items carry the provider/region tag and apply multipliers', () => {
    const w = ecoWorld();
    expect(costLineItems(w).every((i) => i.provider === 'stratus/us-east-1' || i.provider === undefined)).toBe(true);
    w.cloud!.provider = 'volt';
    w.cloud!.region = 'us-central-1';
    const vm = costLineItems(w).find((i) => i.label.includes('web-01'))!;
    expect(vm.monthlyCost).toBe(Math.round(73 * costMultiplierOf('volt', 'us-central-1')));
    expect(vm.provider).toBe('volt/us-central-1');
  });
});

describe('comparison & migration', () => {
  it('comparison prices every provider region and gates migration', () => {
    const w = ecoWorld();
    expect(startMigration(w, 'volt', 'us-central-1').ok).toBe(false); // never migrate blind
    const r = runCloudComparison(w);
    expect(r.ok).toBe(true);
    expect(w.cloud!.compared).toBe(true);
    const expected = Object.values(PROVIDERS).reduce((a, p) => a + p.regions.length, 0);
    expect(w.cloud!.lastComparison!.length).toBe(expected);
    expect(w.cloud!.lastComparison!.some((row) => row.note === 'current footprint')).toBe(true);
    expect(startMigration(w, 'volt', 'nowhere-1').ok).toBe(false); // unknown region
    expect(startMigration(w, 'stratus', 'us-east-1').ok).toBe(false); // already there
  });

  it('preparations shrink the cutover downtime', () => {
    expect(plannedDowntimeMin(false, false, false, false)).toBe(45);
    expect(plannedDowntimeMin(true, true, true, false)).toBe(15);
    expect(plannedDowntimeMin(true, true, true, true)).toBe(10);
  });

  it('a full migration switches footprint, records history, and drops the bill', () => {
    const w = ecoWorld();
    provisionDb(w, 'db.small');
    enableBackups(w);
    w.ci.staging = { image: 'registry.acme.dev/acme/api:v9', deployedAtMin: w.nowMin, e2ePassed: true, e2eLog: [] };
    provisionLb(w);
    runCloudComparison(w);
    const before = monthlyInfraCost(w);
    const cost = migrationCostOf(before);
    const cashBefore = w.company.cash;
    expect(startMigration(w, 'volt', 'us-central-1').ok).toBe(true);
    expect(w.company.cash).toBeCloseTo(cashBefore - cost, 5);
    expect(w.cloud!.migration!.downtimeMin).toBe(15); // backups + staging + lb, no k8s
    // prep (360 min) then a 15-minute cutover
    for (let i = 0; i < 60 && w.cloud!.migration?.status !== 'cutover'; i++) tick(w, 10);
    expect(w.cloud!.migration!.status).toBe('cutover');
    tick(w, 1); // the switch happens after that minute's metrics — sample the next one
    expect(latest(w, 'error_pct')).toBe(80); // cutover = full downtime
    for (let i = 0; i < 6 && w.cloud!.migration; i++) tick(w, 5);
    expect(w.cloud!.migration).toBeUndefined();
    expect(w.cloud!.provider).toBe('volt');
    expect(w.db.endpoint).toContain('volt');
    const rec = w.cloud!.migrations[0];
    expect(rec.downtimeMin).toBe(15);
    expect(rec.costAfter).toBeLessThan(rec.costBefore);
    expect(monthlyInfraCost(w)).toBeLessThan(before);
    expect(startMigration(w, 'stratus', 'us-east-1').ok).toBe(true); // can migrate back
    expect(startMigration(w, 'orbit', 'us-east-2').ok).toBe(false); // one at a time
  });
});

describe('provider outages & SLA credits', () => {
  it('an outage pins errors, resolves itself, and pays a credit', () => {
    const w = ecoWorld();
    openProviderOutage(w);
    const o = w.cloud!.outage!;
    expect(o).toBeTruthy();
    expect(w.cloud!.outagesSeen).toBe(1);
    const inc = w.monitoring.incidents.find((i) => i.kind === 'provider_outage')!;
    expect(inc.status).toBe('open');
    tick(w, 1);
    expect(latest(w, 'error_pct')).toBe(80);
    // rides out on its own
    for (let i = 0; i < 20 && w.cloud!.outage?.endedAtMin === undefined; i++) tick(w, 5);
    expect(inc.status).toBe('resolved');
    const expected = slaCreditFor(monthlyInfraCost(w), o.durationMin, 'stratus');
    const cashBefore = w.company.cash;
    expect(claimSlcCredit(w).ok).toBe(true);
    expect(w.company.cash).toBeCloseTo(cashBefore + expected, 5);
    expect(w.cloud!.creditsTotal).toBe(expected);
    expect(w.cloud!.outage).toBeUndefined();
    expect(claimSlcCredit(w).ok).toBe(false); // nothing left to claim
  });

  it('unclaimed credits expire after a sim day', () => {
    const w = ecoWorld();
    openProviderOutage(w);
    for (let i = 0; i < 20 && w.cloud!.outage?.endedAtMin === undefined; i++) tick(w, 5);
    expect(w.cloud!.outage).toBeTruthy();
    tick(w, 1441);
    expect(w.cloud!.outage).toBeUndefined();
    expect(w.cloud!.creditsTotal).toBe(0);
  });

  it('premium providers pay richer credits per outage minute', () => {
    expect(slaCreditFor(1000, 30, 'orbit')).toBeGreaterThan(slaCreditFor(1000, 30, 'stratus'));
    expect(slaCreditFor(1000, 30, 'stratus')).toBeGreaterThan(slaCreditFor(1000, 30, 'volt'));
  });
});

describe('products', () => {
  it('enterprise products are gated until the company can support them', () => {
    const w = ecoWorld();
    const grid = ensureProducts(w).products.find((p) => p.id === 'ent-grid')!;
    expect(productBlockers(w, grid).length).toBeGreaterThan(0);
    expect(startProduct(w, 'ent-grid').ok).toBe(false);
    configureSlos(w, 99.5, 1000); // written promises
    hireEngineer(w, 'sre');
    hireEngineer(w, 'mid'); // a real team
    w.company.satisfaction = 4.5; // happy users
    expect(productBlockers(w, grid)).toEqual([]);
    expect(startProduct(w, 'ent-grid').ok).toBe(true);
    expect(startProduct(w, 'ent-grid').ok).toBe(false); // no double-start
  });

  it('products build over time, then bill their share of users', () => {
    const w = ecoWorld();
    startProduct(w, 'insights');
    for (let i = 0; i < 40 && ensureProducts(w).products[0].launchedAtMin === undefined; i++) tick(w, 10);
    expect(ensureProducts(w).products[0].launchedAtMin).toBeDefined();
    // users × 25% adoption × $0.40 — recomputed against the live user count
    expect(Math.round(productMrrOf(w))).toBe(Math.round(w.company.users * 0.25 * 0.4));
    expect(baseMrrOf(w)).toBe(w.company.users * 2); // $2/user/mo, at the live count
    // revenue actually accrues: ~$2,000/mo → ~$1.39/min... per sim minute = 2000/30/1440
    const cashBefore = w.company.cash;
    tick(w, 1);
    expect(w.company.cash - cashBefore).toBeGreaterThan(2000 / 30 / 1440 * 0.9);
    // launched products add tagged infra line items
    expect(costLineItems(w).some((i) => i.label.includes('Insights'))).toBe(true);
  });
});

describe('FinOps', () => {
  it('recommends rightsizing from live utilization and records resolutions', () => {
    const w = ecoWorld();
    provisionDb(w, 'db.small');
    provisionVm(w); // idle second box
    provisionCluster(w); // empty cluster, 3 nodes
    ensureFinops(w);
    tick(w, 2); // first scan populates "seen"
    // simulate a calm database hour so the downsize rec applies
    w.monitoring.series.db_cpu_pct = Array.from({ length: 60 }, (_, i) => ({ t: w.nowMin - i, v: 8 }));
    let ids = finopsRecommendations(w).map((r) => r.id);
    expect(ids).toContain('db-micro'); // db.small with ~0 CPU
    expect(ids).toContain('decomm-vm'); // not serving anything
    expect(ids).toContain('k8s-pool'); // no deployment needs 3 nodes
    expect(ids).toContain('reserve-compute');
    expect(ids).toContain('migrate-volt'); // still on stratus us-east-1
    decommissionVm(w, 'vm-02');
    tick(w, 2); // the seen-diff notices
    expect(w.finops!.resolved).toContain('decomm-vm');
    ids = finopsRecommendations(w).map((r) => r.id);
    expect(ids).not.toContain('decomm-vm');
  });

  it('decommissioning refuses web-01 and cleans up containers', () => {
    const w = ecoWorld();
    expect(decommissionVm(w, 'web-01').ok).toBe(false);
    provisionVm(w);
    w.docker.containers.push({
      id: 'x', name: 'api-vm-02', image: 'registry.acme.dev/acme/api:v1', env: {}, hostPort: 8080, containerPort: 8080,
      status: 'running', healthy: true, startedAtMin: w.nowMin, serviceRef: 'api', hostId: 'vm-02', logs: []
    });
    expect(decommissionVm(w, 'vm-02').ok).toBe(true);
    expect(w.hosts['vm-02']).toBeUndefined();
    expect(w.docker.containers.length).toBe(0);
  });

  it('the node pool resizes within bounds and changes the bill', () => {
    const w = ecoWorld();
    provisionCluster(w);
    const before = monthlyInfraCost(w);
    expect(resizeNodePool(w, 2).ok).toBe(true);
    expect(w.k8s!.nodes.length).toBe(2);
    expect(monthlyInfraCost(w)).toBeLessThan(before);
    expect(resizeNodePool(w, 1).ok).toBe(false); // clamped to 2 = no change
    expect(w.k8s!.nodes.length).toBe(2);
    expect(resizeNodePool(w, 9).ok).toBe(true); // clamped to 4
    expect(w.k8s!.nodes.length).toBe(4);
  });

  it('reserved compute discounts compute only, and goes dormant when you migrate away', () => {
    const w = ecoWorld();
    ensureFinops(w);
    const totalBefore = monthlyInfraCost(w);
    const computeBefore = costLineItems(w).filter((i) => i.category === 'Compute').reduce((a, i) => a + i.monthlyCost, 0);
    expect(reserveCompute(w).ok).toBe(true);
    expect(reserveCompute(w).ok).toBe(false); // one commitment at a time
    const drop = totalBefore - monthlyInfraCost(w);
    expect(drop).toBeGreaterThan(computeBefore * 0.15); // ≈20% of compute, rounded per item
    expect(drop).toBeLessThanOrEqual(computeBefore * 0.25);
    // migrate away → the reservation no longer applies, the bill is list price
    w.cloud!.provider = 'volt';
    w.cloud!.region = 'us-central-1';
    expect(monthlyInfraCost(w)).toBe(monthlyInfraCostAt(w, 'volt', 'us-central-1'));
  });

  it('budgets validate and the daily scoreboard counts under/over', () => {
    const w = ecoWorld();
    provisionDb(w, 'db.medium'); // a real bill above the $100 budget minimum
    expect(setFinopsBudget(w, 10).ok).toBe(false); // out of range
    const bill = monthlyInfraCost(w);
    expect(setFinopsBudget(w, bill + 50).ok).toBe(true);
    tick(w, 1440);
    expect(w.finops!.daysUnderBudget).toBe(1);
    setFinopsBudget(w, bill - 100); // tightened below the bill
    tick(w, 1440);
    expect(w.finops!.daysOverBudget).toBe(1);
  });

  it('the FinOps baseline makes a 15% cut measurable', () => {
    const w = ecoWorld();
    provisionVm(w);
    provisionCluster(w);
    setFinopsBaseline(w);
    const baseline = w.finops!.baselineMonthly!;
    decommissionVm(w, 'vm-02');
    resizeNodePool(w, 2);
    expect(monthlyInfraCost(w)).toBeLessThanOrEqual(0.85 * baseline);
  });
});

describe('persistence', () => {
  it('ecosystem state survives a JSON round trip', () => {
    const w = ecoWorld();
    runCloudComparison(w);
    startProduct(w, 'insights');
    ensureFinops(w);
    setFinopsBudget(w, 5000);
    reserveCompute(w);
    const clone = JSON.parse(JSON.stringify(w)) as World;
    expect(clone.cloud!.provider).toBe('stratus');
    expect(clone.cloud!.lastComparison!.length).toBeGreaterThan(0);
    expect(clone.products!.products.length).toBe(3);
    expect(clone.finops!.budgetMonthly).toBe(5000);
    expect(clone.finops!.reservedProvider).toBe('stratus');
    expect(providerOf(clone.cloud!.provider).id).toBe('stratus');
    expect(regionOf('volt', 'eu-north-1').id).toBe('eu-north-1');
  });
});
