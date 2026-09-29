// Scale Era (P6a): the honest economy. After the m40 term sheet the world
// bills by usage — requests, egress, log ingestion, backup storage and a
// managed-DB utilization surcharge — and compute capacity becomes real:
// utilization bends latency past 70% and overload past 100% becomes 5xx.
// Everything keys off `world.era`, so the mid-campaign economy is untouched.
import { describe, it, expect } from 'vitest';
import { createWorld, tick, costLineItems, monthlyInfraCost, eraBurnView, computeCapacityOf, provisionK8sCluster, eraStageOf, logGrowthPerMin, dbQpsOf, ensureCloud, setCdn, setQueueWorkers, setReplica, setSecondaryRegion, startStampede } from '../server/src/world';
import { resizeNodePool } from '../server/src/sim/k8s';
import { World } from '../server/src/types';

function eraWorld(users: number, opts: { k8sNodes?: number } = {}): World {
  const w = createWorld('Acme Metrics', 'you');
  w.company.launched = true;
  w.app.mode = 'service';
  w.company.users = users;
  w.era = { startedAtMin: w.nowMin, stageReached: 0 };
  if (opts.k8sNodes) {
    provisionK8sCluster(w);
    resizeNodePool(w, opts.k8sNodes);
  }
  return w;
}

describe('scale era: the honest economy is era-gated', () => {
  it('pre-era: no load-coupled items; era: they appear and the fixed items are untouched', () => {
    const w = createWorld('Acme', 'you');
    w.company.launched = true;
    const before = costLineItems(w);
    const beforeKeys = before.map((i) => `${i.label}:${i.monthlyCost}`);
    w.era = { startedAtMin: w.nowMin, stageReached: 0 };
    const after = costLineItems(w);
    // every pre-era item survives verbatim, in order, at the same price
    expect(after.slice(0, beforeKeys.length).map((i) => `${i.label}:${i.monthlyCost}`)).toEqual(beforeKeys);
    // the era adds usage billing for an app with users: log ingestion at least
    const eraOnly = after.slice(beforeKeys.length);
    expect(eraOnly.length).toBeGreaterThan(0);
    expect(eraOnly.some((i) => i.category === 'Logging')).toBe(true);
    expect(monthlyInfraCost(w)).toBe(before.reduce((a, i) => a + i.monthlyCost, 0) + eraOnly.reduce((a, i) => a + i.monthlyCost, 0));
  });

  it('a legacy save JSON without `era` loads and costs exactly as before the patch', () => {
    const w = createWorld('Acme', 'you');
    w.company.launched = true;
    const legacy = JSON.parse(JSON.stringify(w)) as World; // no era field, like a pre-P6 save
    expect(legacy.era).toBeUndefined();
    expect(costLineItems(legacy)).toEqual(costLineItems(w));
  });

  it('zero-volume resources do not bill: no users, no request/egress lines', () => {
    const w = createWorld('Acme', 'you'); // not launched → 0 requests
    w.era = { startedAtMin: w.nowMin, stageReached: 0 };
    const cats = costLineItems(w).map((i) => i.category);
    expect(cats).not.toContain('Requests');
    expect(cats).not.toContain('Egress');
  });
});

describe('scale era: tuning gate — infra/revenue by scale', () => {
  // naive: fixed campaign footprint, db.medium, no levers. S3 (1M) logs at 100×,
  // S4 (10M) at 1000× push the naive cost curve past revenue's flat $2/user.
  const naive = (users: number) => {
    const w = eraWorld(users);
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    return w;
  };
  const cases: [number, number, number][] = [
    [100e3, 0.06, 0.18],
    [1e6, 0.35, 0.5],
    [10e6, 0.38, 0.55]
  ];
  it.each(cases)('%p users → naive infra/revenue in band', (users, lo, hi) => {
    const w = naive(users);
    const ratio = monthlyInfraCost(w) / (w.company.users * 2);
    expect(ratio).toBeGreaterThanOrEqual(lo);
    expect(ratio).toBeLessThanOrEqual(hi);
  });
  it('the naive cost ratio is superlinear in users', () => {
    const ratio = (users: number) => monthlyInfraCost(naive(users)) / (users * 2);
    expect(ratio(10e6)).toBeGreaterThan(ratio(100e3));
  });

  // engineered: every P6b lever pulled — CDN offload, read replica, queue-sized
  // workers, fleet sized to peak, standby region. Holds ≤25% at any scale: that
  // gap from the naive curve IS the endgame skill.
  const engineered = (users: number) => {
    const w = naive(users);
    ensureCloud(w);
    setCdn(w, 'pro');
    w.db.replica = { plan: 'db.medium', addedAtMin: w.nowMin };
    const peakOrigin = users * 0.02 * (1 - 0.85);
    const share = eraStageOf(w) >= 3 ? 0.35 : 0.2;
    setQueueWorkers(w, Math.ceil((peakOrigin * share) / 40) + 5);
    provisionK8sCluster(w);
    resizeNodePool(w, Math.max(2, Math.ceil(peakOrigin / 200) - 2));
    setSecondaryRegion(w, 'volt', 'us-central-1');
    return w;
  };
  it.each([[1e6], [10e6]] as const)('%p users → engineered infra/revenue ≤ 25%', (users) => {
    const w = engineered(users);
    const ratio = monthlyInfraCost(w) / (users * 2);
    expect(ratio).toBeLessThanOrEqual(0.25);
    expect(ratio).toBeGreaterThan(0.05); // not free either — scale still costs
  });
  it('engineered beats naive at the same scale by a wide margin', () => {
    const naiveRatio = monthlyInfraCost(naive(1e6)) / 2e6;
    const engRatio = monthlyInfraCost(engineered(1e6)) / 2e6;
    expect(naiveRatio - engRatio).toBeGreaterThan(0.1);
  });
});

describe('scale era: compute utilization', () => {
  it('capacity counts every billed compute unit', () => {
    const w = eraWorld(50e3);
    expect(computeCapacityOf(w)).toBe(400); // web-01 + vm-02
    provisionK8sCluster(w);
    resizeNodePool(w, 4);
    expect(computeCapacityOf(w)).toBe(1200); // + 4 nodes
  });

  it('over 100% utilization the origin serves 5xx; sized fleets do not', () => {
    // 50k users at solar noon: req = 1000/s against 200 capacity → util 5
    const hot = eraWorld(50e3);
    hot.nowMin = 719;
    tick(hot, 1); // nowMin 720 → diurnal peak 1.0
    const hotErr = hot.monitoring.series.error_pct?.at(-1)?.v ?? 0;
    expect(hotErr).toBeGreaterThanOrEqual(20);
    // same world with a 5-unit fleet: peak util exactly 1.0 → latency bends, no 5xx term
    const cool = eraWorld(50e3, { k8sNodes: 4 });
    cool.nowMin = 719;
    tick(cool, 1);
    const coolErr = cool.monitoring.series.error_pct?.at(-1)?.v ?? 0;
    expect(coolErr).toBeLessThan(5);
  });

  it('the era lifts the node-pool cap; the campaign keeps 2–4', () => {
    const era = eraWorld(1e6);
    provisionK8sCluster(era);
    resizeNodePool(era, 120);
    expect(era.k8s!.nodes.length).toBe(120);
    const plain = createWorld('Acme', 'you');
    provisionK8sCluster(plain);
    resizeNodePool(plain, 120);
    expect(plain.k8s!.nodes.length).toBe(4); // clamped at the campaign ceiling
  });

  it('the era bends latency; the same moment pre-era keeps campaign numbers', () => {
    const era = eraWorld(50e3, { k8sNodes: 4 }); // peak util = 100%
    era.nowMin = 719;
    tick(era, 1);
    const plain = eraWorld(50e3, { k8sNodes: 4 });
    plain.era = undefined;
    plain.nowMin = 719;
    tick(plain, 1);
    const p95Era = era.monitoring.series.p95_ms?.at(-1)?.v ?? 0;
    const p95Plain = plain.monitoring.series.p95_ms?.at(-1)?.v ?? 0;
    expect(p95Era).toBeGreaterThan(p95Plain);
  });
});

describe('scale era: burn view', () => {
  it('burn math is internally consistent', () => {
    const w = eraWorld(1e6, { k8sNodes: 100 });
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    const b = eraBurnView(w);
    expect(b.monthlyInfra).toBe(monthlyInfraCost(w));
    expect(b.hourlyBurn).toBe(Math.round(((b.monthlyInfra + b.payroll) / 720) * 100) / 100);
    expect(b.costPerUser).toBeCloseTo(b.monthlyInfra / 1e6, 3);
    expect(b.marginPct).toBe(Math.round(((b.mrr - b.monthlyInfra - b.payroll) / b.mrr) * 100));
    expect(b.reqsMonthly).toBeGreaterThan(2e9);
    expect(b.billedReqsMonthly).toBe(b.reqsMonthly - 2e9);
    expect(b.egressGB).toBe(Math.round((b.reqsMonthly * 8) / 1e6));
    // growth compounds: the month-end projection exceeds today's rate
    expect(b.projectedMonthEnd).toBeGreaterThan(b.monthlyInfra);
    // utilization view: avg below peak
    expect(b.utilAvgPct).toBeGreaterThan(0);
    expect(b.utilAvgPct).toBeLessThan(b.utilPeakPct);
  });
});

// =====================================================================
// P6b — capacity levers & scale stages
// =====================================================================

describe('scale era P6b: the stage engine', () => {
  it('stages derive from users, not scripts', () => {
    const w = eraWorld(9_999);
    expect(eraStageOf(w)).toBe(0);
    for (const [users, stage] of [[10e3, 1], [100e3, 2], [1e6, 3], [10e6, 4], [100e6, 5]] as const) {
      w.company.users = users;
      expect(eraStageOf(w)).toBe(stage);
    }
  });

  it('crossing a threshold announces the stage exactly once', () => {
    const w = eraWorld(5_000);
    tick(w, 3);
    expect(w.era?.stageReached).toBe(0);
    w.company.users = 120_000;
    tick(w, 3);
    expect(w.era?.stageReached).toBe(2);
    const s2 = () => w.audit.filter((a) => a.kind === 'era' && a.text.includes('S2')).length;
    expect(s2()).toBe(1);
    tick(w, 5);
    expect(s2()).toBe(1);
  });

  it('stages re-open the logrotate problem at 100×/1000× intensity', () => {
    expect(logGrowthPerMin(eraWorld(50e3))).toBe(60);
    expect(logGrowthPerMin(eraWorld(1e6))).toBe(6_000);   // S3: 100×
    expect(logGrowthPerMin(eraWorld(10e6))).toBe(60_000); // S4: 1000×
    const pre = eraWorld(1e6);
    pre.era = undefined;
    expect(logGrowthPerMin(pre)).toBe(60); // campaign untouched
  });
});

describe('scale era P6b: CDN offload', () => {
  const sized = (users: number) => {
    const w = eraWorld(users);
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    w.flags.indexFixApplied = true;
    return w;
  };

  it('edge hits never touch the origin bill', () => {
    const w = sized(1e6);
    const beforeTotal = monthlyInfraCost(w);
    const beforeReq = costLineItems(w).find((i) => i.category === 'Requests')!;
    setCdn(w, 'pro');
    const after = costLineItems(w);
    const req = after.find((i) => i.category === 'Requests')!;
    const cdn = after.find((i) => i.category === 'Networking')!;
    expect(req.monthlyCost).toBeLessThan(beforeReq.monthlyCost);
    expect(req.label).toContain('offloaded');
    expect(cdn.label).toContain('CDN pro');
    expect(monthlyInfraCost(w)).toBeLessThan(beforeTotal); // offload savings outrun the CDN bill
  });

  it('offload keeps an undersized fleet from melting at peak', () => {
    const hot = sized(50e3); // peak 1000 req/s vs 400 capacity
    hot.nowMin = 719;
    tick(hot, 1);
    expect(hot.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBeGreaterThanOrEqual(20);
    const cool = sized(50e3);
    setCdn(cool, 'pro'); // origin peak drops to 150 req/s
    cool.nowMin = 719;
    tick(cool, 1);
    expect(cool.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBeLessThan(5);
  });

  it('stampedes collapse the hit ratio, then expire', () => {
    const w = sized(100e3);
    setCdn(w, 'pro');
    expect(eraBurnView(w).cdnHitPct).toBe(85);
    startStampede(w);
    expect(eraBurnView(w).cdnHitPct).toBe(21); // 85% × 0.25 while revalidating
    w.cdn!.stampedeUntilMin = w.nowMin - 1;
    expect(eraBurnView(w).cdnHitPct).toBe(85);
  });
});

describe('scale era P6b: read replica', () => {
  const sized = (users: number) => {
    const w = eraWorld(users);
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    w.flags.indexFixApplied = true;
    return w;
  };

  it('splits reads off the primary', () => {
    const w = sized(100e3);
    w.nowMin = 719;
    tick(w, 1);
    const solo = dbQpsOf(w);
    setReplica(w, 'db.medium');
    expect(dbQpsOf(w)).toBeLessThan(solo);
    const items = costLineItems(w);
    expect(items.find((i) => i.label.includes('Read replica'))!.monthlyCost).toBe(260);
  });

  it('lags when underprovisioned — stale reads become errors; sized, it keeps up', () => {
    const big = sized(1e6);
    setReplica(big, 'db.micro');
    big.nowMin = 719;
    tick(big, 1);
    expect(eraBurnView(big).replicaLagMs).toBeGreaterThan(250);
    expect(big.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBeGreaterThanOrEqual(6);
    const ok = sized(50e3); // noon reads fit a db.medium replica comfortably
    setReplica(ok, 'db.medium');
    ok.nowMin = 719;
    tick(ok, 1);
    expect(eraBurnView(ok).replicaLagMs).toBeLessThanOrEqual(250);
  });
});

describe('scale era P6b: queue + async workers', () => {
  it('undersized workers park writes in the backlog instead of the DB', () => {
    const w = eraWorld(1e6);
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    w.flags.indexFixApplied = true;
    const unqueued = dbQpsOf(w);
    setQueueWorkers(w, 5); // drains 200/s against ~2200 write jobs/s at noon
    expect(dbQpsOf(w)).toBeLessThan(unqueued);
    w.nowMin = 720;
    tick(w, 5);
    expect(w.queue!.backlog).toBeGreaterThan(0);
  });

  it('sized workers drain the backlog to zero', () => {
    const w = eraWorld(100e3);
    setQueueWorkers(w, 30); // drains 1200/s against ≤400 write jobs/s
    w.queue!.backlog = 50_000;
    tick(w, 60);
    expect(w.queue!.backlog).toBe(0);
  });

  it('a big backlog becomes user-visible errors', () => {
    const w = eraWorld(50e3, { k8sNodes: 4 });
    setQueueWorkers(w, 1);
    w.queue!.backlog = 30_000;
    w.nowMin = 719;
    tick(w, 1);
    expect(w.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe('scale era P6b: secondary region + failover', () => {
  it('the standby bills half of compute & database', () => {
    const w = eraWorld(50e3);
    ensureCloud(w);
    provisionK8sCluster(w);
    resizeNodePool(w, 4);
    setSecondaryRegion(w, 'volt', 'us-central-1');
    const items = costLineItems(w);
    const dup = items.find((i) => i.category === 'Multi-region')!;
    const cd = items.filter((i) => i.category === 'Compute' || i.category === 'Database').reduce((a, i) => a + i.monthlyCost, 0);
    expect(dup.monthlyCost).toBe(Math.round(cd * 0.5));
    expect(setSecondaryRegion(w, 'stratus', 'us-east-1').ok).toBe(false); // same as primary
    expect(setSecondaryRegion(w, 'volt', 'nowhere-1').ok).toBe(false);
  });

  it('a regional outage fails over instead of ending the world', () => {
    const arm = (w: World) => {
      w.cloud!.outage = { provider: 'stratus', region: 'us-east-1', startedAtMin: w.nowMin, durationMin: 60, creditClaimed: false };
    };
    const alone = eraWorld(20e3);
    ensureCloud(alone);
    provisionK8sCluster(alone);
    resizeNodePool(alone, 4);
    alone.nowMin = 719;
    arm(alone);
    tick(alone, 1);
    expect(alone.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBe(80); // full outage
    const paired = eraWorld(20e3);
    ensureCloud(paired);
    provisionK8sCluster(paired);
    resizeNodePool(paired, 4);
    setSecondaryRegion(paired, 'volt', 'us-central-1');
    paired.nowMin = 719;
    arm(paired);
    tick(paired, 1); // DNS glitch window
    expect(paired.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBe(15);
    expect(computeCapacityOf(paired)).toBe(600); // half the fleet is the primary's home
    tick(paired, 5); // glitch over, serving from the standby
    expect(paired.monitoring.series.error_pct?.at(-1)?.v ?? 0).toBeLessThan(5);
  });
});

// =====================================================================
// P6c — consequences of being big
// =====================================================================

import { resolveIncident, oncallLoadOf, coordinationTaxRoll, complianceFindings, productMrrOf, ensureProducts, enablePortal, publishTemplate, hireEngineer, tickCloud, configureSlos, collectEvidence } from '../server/src/world';
import { Incident } from '../server/src/types';

function openInc(w: World, severity: 'SEV1' | 'SEV2', openedAtMin: number): Incident {
  const inc: Incident = { id: 'inc-test', kind: 'disk_full', title: 'test incident', symptom: 's', severity, openedAtMin, status: 'open', rootCause: 'r', customerImpact: 'c', detectedBy: 't', timeline: [], corrective: [], postmortemFiled: false };
  w.monitoring.incidents.unshift(inc);
  return inc;
}

describe('scale era P6c: the incident ledger', () => {
  it('resolving a Sev-1 at scale costs real money', () => {
    const w = eraWorld(1e6);
    const before = w.company.cash;
    const inc = openInc(w, 'SEV1', w.nowMin - 60);
    resolveIncident(w, inc, 'fixed');
    const cost = before - w.company.cash;
    expect(cost).toBe(30_000); // 1M users × $0.03/user-hour × 1h
    expect(w.era!.incidentCashPaid).toBe(30_000);
    expect(w.audit.some((a) => a.text.includes('INCIDENT LEDGER'))).toBe(true);
  });
  it('pre-era resolution stays free; Sev-2 costs a third of Sev-1', () => {
    const pre = eraWorld(1e6);
    pre.era = undefined;
    const inc = openInc(pre, 'SEV1', pre.nowMin - 60);
    const before = pre.company.cash;
    resolveIncident(pre, inc, 'fixed');
    expect(pre.company.cash).toBe(before);
    const sev2 = eraWorld(1e6);
    const before2 = sev2.company.cash;
    resolveIncident(sev2, openInc(sev2, 'SEV2', sev2.nowMin - 60), 'fixed');
    expect(before2 - sev2.company.cash).toBe(10_000);
  });
});

describe('scale era P6c: the on-call economy', () => {
  function fleetWorld(): World {
    const w = eraWorld(1e6);
    provisionK8sCluster(w);
    resizeNodePool(w, 20); // 22 fleet units → 330 eng-min/day of pages & toil
    hireEngineer(w, 'junior'); // 240 min of capacity
    return w;
  }

  it('pages outpace an understaffed team and burnout accrues', () => {
    const w = fleetWorld();
    const load = oncallLoadOf(w);
    expect(load.overloaded).toBe(true);
    expect(load.demandMin).toBeGreaterThan(load.supplyMin);
    const e = w.team!.engineers[0];
    tick(w, 1441); // one sim day overloaded
    expect(e.burnout ?? 0).toBeGreaterThan(0);
    expect(w.era!.overloadSinceMin).toBeDefined();
    expect(w.audit.some((a) => a.text.includes('ON-CALL OVERLOAD'))).toBe(true);
  });

  it('the pager is heavier: the on-call burns out faster than off-call peers', () => {
    const w = fleetWorld();
    hireEngineer(w, 'junior');
    w.team!.onCallId = w.team!.engineers[0].id;
    tick(w, 1441);
    const onCall = w.team!.engineers[0].burnout ?? 0;
    const offCall = w.team!.engineers[1].burnout ?? 0;
    expect(onCall).toBeGreaterThan(offCall);
  });

  it('at 100% burnout an engineer quits — and recovers when load drops', () => {
    const w = fleetWorld();
    const e = w.team!.engineers[0];
    w.team!.onCallId = e.id;
    e.burnout = 99.99; // one overloaded tick tips them over 100
    tick(w, 2);
    expect(w.team!.engineers.find((x) => x.id === e.id)).toBeUndefined();
    expect(w.audit.some((a) => a.text.includes('BURNOUT'))).toBe(true);
    // recovery: shrink the fleet, load clears, burnout decays
    const w2 = fleetWorld();
    w2.team!.engineers[0].burnout = 20;
    w2.company.users = 5_000;
    w2.k8s!.nodes = [];
    tick(w2, 1441);
    expect(w2.team!.engineers[0].burnout ?? 0).toBeLessThan(20);
  });

  it('automation buys the minutes back: portal, golden paths, SLOs', () => {
    const w = fleetWorld();
    const before = oncallLoadOf(w);
    enablePortal(w);
    publishTemplate(w, 'web-service');
    configureSlos(w, 99.9, 500);
    const after = oncallLoadOf(w);
    expect(before.discountPct).toBe(100);
    expect(after.discountPct).toBe(65); // 0.75 × 0.97 × 0.90 = 0.655
    expect(after.demandMin).toBeLessThan(before.demandMin);
  });
});

describe('scale era P6c: the coordination tax', () => {
  it('big teams without a portal arm deploy regressions; small or automated teams do not', () => {
    const random = Math.random;
    try {
      Math.random = () => 0.01; // always under the tax odds
      const big = eraWorld(50e3);
      for (let i = 0; i < 8; i++) hireEngineer(big, 'junior');
      expect(big.team!.engineers.length).toBe(8);
      expect(coordinationTaxRoll(big)).toBe(true);
      expect(big.flags.nextDeployHasBug).toBe(true);
      expect(big.era!.coordinationWarned).toBe(true);
      expect(big.audit.some((a) => a.text.includes('COORDINATION TAX'))).toBe(true);
      // once warned, the watermark sticks; the roll keeps arming while headcount stands
      big.flags.nextDeployHasBug = false; // the planted regression ships eventually
      expect(coordinationTaxRoll(big)).toBe(true);

      const small = eraWorld(50e3);
      hireEngineer(small, 'junior');
      expect(coordinationTaxRoll(small)).toBe(false);

      const automated = eraWorld(50e3);
      for (let i = 0; i < 8; i++) hireEngineer(automated, 'junior');
      enablePortal(automated);
      expect(coordinationTaxRoll(automated)).toBe(false);
    } finally {
      Math.random = random;
    }
  });
});

describe('scale era P6c: concentration risk', () => {
  it('single-region S3+ fleets draw provider outages at double odds', () => {
    const random = Math.random;
    try {
      Math.random = () => 0.00005; // above base stratus odds (3.5e-5), below doubled (6.9e-5)
      const alone = eraWorld(1e6);
      ensureCloud(alone);
      alone.cloud!.sinceMin = 0; // past the new-footprint throttle
      tickCloud(alone);
      expect(alone.cloud!.outage).toBeDefined();
      expect(alone.audit.some((a) => a.text.includes('No secondary region'))).toBe(true);

      const paired = eraWorld(1e6);
      ensureCloud(paired);
      paired.cloud!.sinceMin = 0;
      setSecondaryRegion(paired, 'volt', 'us-central-1');
      tickCloud(paired);
      expect(paired.cloud!.outage).toBeUndefined();
    } finally {
      Math.random = random;
    }
  });
});

describe('scale era P6c: posture gates revenue', () => {
  it('single-region at S3+ is a compliance finding; enterprise revenue drops while findings are open', () => {
    const w = eraWorld(1e6);
    expect(complianceFindings(w).some((f) => f.id === 'single-region')).toBe(true);
    const products = ensureProducts(w);
    const ent = products.products.find((p) => p.tier === 'enterprise')!;
    ent.launchedAtMin = 1;
    const penalized = productMrrOf(w);
    expect(penalized).toBeGreaterThan(0);
    setSecondaryRegion(w, 'volt', 'us-central-1');
    expect(complianceFindings(w).some((f) => f.id === 'single-region')).toBe(false);
    // clear the rest of the posture so the enterprise gate releases
    w.vault = { enabled: true, enabledAtMin: 0, secrets: {}, credsLive: true };
    w.compliance = { auditImmutable: true, bundles: [collectEvidence(w)] };
    expect(complianceFindings(w)).toHaveLength(0);
    const clean = productMrrOf(w);
    expect(clean).toBeCloseTo(penalized / 0.7, 0);
  });
});

// =====================================================================
// P6d — era mode: pacing, crank, R&D, product pipeline
// =====================================================================

import { eraGrowthMultOf, nextStageUsersOf, crankDay, investRd, refreshProduct, refreshCostOf } from '../server/src/world';

describe('scale era P6d: pacing & the clock', () => {
  it('era growth is stage-scaled; the campaign keeps its own pace', () => {
    const pre = eraWorld(50e3);
    pre.era = undefined;
    expect(eraGrowthMultOf(pre)).toBe(1);
    const w = eraWorld(100e3);
    expect(eraGrowthMultOf(w)).toBe(12); // 6 + stage 2 × 3
    w.company.users = 1e6;
    expect(eraGrowthMultOf(w)).toBe(15);
  });

  it('R&D is the money sink: costs scale, growth compounds, level 5 caps', () => {
    const w = eraWorld(100e3);
    w.company.cash = 1_500_000;
    expect(investRd(w).ok).toBe(true);
    expect(investRd(w).ok).toBe(true);
    expect(w.era!.rdLevel).toBe(2);
    expect(eraGrowthMultOf(w)).toBeCloseTo(12 * 1.16, 5);
    expect(w.company.cash).toBe(1_350_000);
    w.era!.rdLevel = 5;
    expect(investRd(w).ok).toBe(false);
    const broke = eraWorld(100e3);
    broke.company.cash = 10;
    expect(investRd(broke).ok).toBe(false);
  });

  it('cranking advances exactly one sim day, and only in the era', () => {
    const w = eraWorld(20e3);
    const before = w.nowMin;
    const r = crankDay(w);
    expect(r.ok).toBe(true);
    expect(w.nowMin - before).toBe(1440);
    const pre = eraWorld(20e3);
    pre.era = undefined;
    expect(crankDay(pre).ok).toBe(false);
  });

  it('next-stage milestones; S5 is the summit', () => {
    const w = eraWorld(50e3);
    expect(nextStageUsersOf(w)).toBe(100e3);
    w.company.users = 100e6;
    expect(nextStageUsersOf(w)).toBeNull();
  });
});

describe('scale era P6d: the product pipeline', () => {
  function productWorld(): World {
    const w = eraWorld(500e3);
    const p = ensureProducts(w).products[0]; // Insights
    p.launchedAtMin = w.nowMin;
    p.lifecycle = { peakAdoptionPct: 40, matureAtMin: w.nowMin + 30 * 1440, generation: 1 };
    return w;
  }

  it('adoption ramps toward the peak, then decays after maturity', () => {
    const w = productWorld();
    const p = w.products!.products[0];
    const start = p.adoptionPct;
    tick(w, 30 * 1440 - 1); // still one minute shy of maturity
    expect(p.adoptionPct).toBeGreaterThan(start);
    expect(p.adoptionPct).toBeLessThanOrEqual(40);
    const atMature = p.adoptionPct;
    tick(w, 60 * 1440);
    expect(p.adoptionPct).toBeLessThan(atMature);
    expect(p.adoptionPct).toBeGreaterThanOrEqual(0.5);
  });

  it('a refresh release resets the decay clock and raises the ceiling', () => {
    const w = productWorld();
    const p = w.products!.products[0];
    p.adoptionPct = 10;
    p.lifecycle!.matureAtMin = w.nowMin - 1;
    w.company.cash = 100_000;
    expect(refreshCostOf(p)).toBe(8_000);
    expect(refreshProduct(w, p.id).ok).toBe(true);
    expect(p.lifecycle!.generation).toBe(2);
    expect(p.lifecycle!.matureAtMin).toBe(w.nowMin + 30 * 1440);
    const after = p.adoptionPct;
    tick(w, 30 * 1440);
    expect(p.adoptionPct).toBeGreaterThan(after);
    expect(refreshCostOf(p)).toBe(12_000); // v3 costs more than v2
  });

  it('era ideas accrue into the backlog on their own clock', () => {
    const w = eraWorld(100e3);
    const before = ensureProducts(w).products.length;
    expect(before).toBe(3);
    tick(w, 11 * 1440);
    expect(w.products!.products.length).toBeGreaterThan(before);
    expect(w.audit.some((a) => a.text.includes('NEW IDEA'))).toBe(true);
  });
});

// =====================================================================
// P6e — the race: rivals, boards, milestones, share codes
// =====================================================================

import { robustnessOf, valuationOf, raceBoardOf, shareCodeOf, parseShareCode, provisionVm, provisionLb, deployToVm, enableBackups, provisionDb } from '../server/src/world';

describe('scale era P6e: rivals', () => {
  it('three archetypes seed lazily and deterministically, then grow on the same tick', () => {
    const w = eraWorld(100e3);
    expect(w.era!.rivals).toBeUndefined(); // lazy: older era saves seed on first tick
    const before = raceBoardOf(w).rows.find((r) => r.you)!.users;
    tick(w, 1440);
    const rivals = w.era!.rivals!;
    expect(rivals.map((r) => r.name)).toEqual(['Goliath Cloud', 'Leanframe', 'Steady Systems']);
    expect(rivals.map((r) => r.archetype)).toEqual(['goliath', 'lean', 'steady']);
    expect(rivals[0].users).toBeGreaterThan(before * 1.2); // goliath seeded at 1.25× and grew
    expect(rivals.every((r) => r.users > 0)).toBe(true);
  });

  it('lean draws the big outages; postmortems get published when they end', () => {
    const random = Math.random;
    try {
      Math.random = () => 0.00005; // below lean's daily odds (8.3e-5), above goliath (1.4e-5) and steady (5.6e-6)
      const w = eraWorld(100e3);
      tick(w, 2);
      const lean = w.era!.rivals!.find((r) => r.archetype === 'lean')!;
      const goliath = w.era!.rivals!.find((r) => r.archetype === 'goliath')!;
      expect(lean.outagedUntilMin).toBeDefined();
      expect(goliath.outagedUntilMin).toBeUndefined();
      const badBefore = lean.badMin;
      const end = lean.outagedUntilMin!;
      tick(w, end - w.nowMin); // ride it out — assertions land on the minute the lights come back
      expect(lean.outagedUntilMin).toBeUndefined();
      expect(lean.badMin).toBeGreaterThan(badBefore);
      expect(lean.postmortems).toBe(1);
      expect(w.audit.some((a) => a.text.includes('published a postmortem'))).toBe(true);
    } finally {
      Math.random = random;
    }
  });

  it('rivals poach users while your error rate burns', () => {
    const w = eraWorld(100e3);
    provisionK8sCluster(w);
    resizeNodePool(w, 4);
    w.flags.badDeployBug = true; // sustained error source
    tick(w, 1);
    const goliathBefore = w.era!.rivals![0].users;
    const baselineGrowth = goliathBefore * (0.09 / 1440);
    tick(w, 1440);
    const gained = w.era!.rivals![0].users - goliathBefore;
    expect(gained).toBeGreaterThan(baselineGrowth * 0.5); // poaching adds to base growth
    expect(w.audit.some((a) => a.text.includes('SHOPPING AROUND'))).toBe(true);
  });
});

describe('scale era P6e: robustness, valuation, the board', () => {
  it('robustness rewards real posture and punishes real damage', () => {
    const clean = eraWorld(100e3);
    provisionDb(clean, 'db.medium');
    enableBackups(clean);
    provisionVm(clean);
    provisionLb(clean);
    deployToVm(clean, 'vm-02');
    clean.k8s = { ...(clean.k8s as NonNullable<World['k8s']>), zeroDowntimeProven: true };
    const high = robustnessOf(clean);
    expect(high).toBeGreaterThan(70);
    const battered = eraWorld(100e3);
    battered.flags.uptimeBadMin = 4320; // 3 days of bad minutes in the window
    battered.monitoring.incidents.push({ id: 'x', kind: 'disk_full', title: 't', symptom: 's', severity: 'SEV1', openedAtMin: battered.nowMin - 60, status: 'resolved', resolvedAtMin: battered.nowMin - 50, rootCause: 'r', customerImpact: 'c', detectedBy: 'd', timeline: [], corrective: [], postmortemFiled: false });
    expect(robustnessOf(battered)).toBeLessThan(high);
    expect(robustnessOf(battered)).toBeGreaterThanOrEqual(0);
  });

  it('valuation applies a robustness-and-growth multiple to annual MRR', () => {
    const w = eraWorld(1e6);
    const v = valuationOf(w);
    expect(v.mrr).toBe(2_000_000);
    expect(v.multiple).toBeGreaterThanOrEqual(3);
    expect(v.multiple).toBeLessThanOrEqual(9.5);
    expect(v.valuation).toBe(Math.round(v.mrr * 12 * v.multiple));
    expect(v.netWorth).toBe(Math.round(w.company.cash + v.valuation));
  });

  it('the board ranks by Ship It Index with gap-to-next', () => {
    const w = eraWorld(100e3);
    const board = raceBoardOf(w);
    expect(board.rows).toHaveLength(4);
    const indexes = board.rows.map((r) => r.index);
    expect([...indexes].sort((a, b) => b - a)).toEqual(indexes);
    const you = board.rows.find((r) => r.you)!;
    if (board.playerRank === 1) expect(board.gapToNext).toBeNull();
    else expect(board.gapToNext).toBe(board.rows[board.playerRank - 2].index - you.index);
    // robust systems rank richer: same worth, more robustness → higher index
    expect(you.index).toBe(Math.round(you.valuation * (you.robustness / 100)));
  });
});

describe('scale era P6e: milestones', () => {
  it('daily checks grant MRR, uptime and summit badges', () => {
    const w = eraWorld(1e6, { k8sNodes: 100 }); // sized fleet → uptime genuinely held
    w.flags.logrotateConfigured = true; // m11 lessons hold in the era: unrotated logs sink uptime via ENOSPC
    tick(w, 2 * 1440);
    expect(w.era!.badges).toContain('mrr-1m');
    expect(w.era!.badges).toContain('uptime-1m');
    expect(w.audit.some((a) => a.text.includes('MILESTONE'))).toBe(true);
    // the summit: at 100M users no realistic fleet holds 99.99% — but the milestone still lands
    const top = eraWorld(100e6);
    tick(top, 2 * 1440);
    expect(top.era!.badges).toContain('summit');
  });

  it('margin-10m requires engineered play at scale', () => {
    const w = eraWorld(10e6); // naive: ratio ~46% → no badge
    tick(w, 2 * 1440);
    expect(w.era!.badges).not.toContain('margin-10m');
    setCdn(w, 'pro');
    w.db.provisioned = true;
    w.db.plan = 'db.medium';
    w.db.replica = { plan: 'db.medium', addedAtMin: w.nowMin };
    const peakOrigin = 10e6 * 0.02 * 0.15;
    setQueueWorkers(w, Math.ceil((peakOrigin * 0.35) / 40) + 5);
    provisionK8sCluster(w);
    resizeNodePool(w, Math.max(2, Math.ceil(peakOrigin / 200) - 2));
    setSecondaryRegion(w, 'volt', 'us-central-1');
    tick(w, 2 * 1440);
    expect(w.era!.badges).toContain('margin-10m');
  });

  it('outage-zero: surviving a provider outage on the standby earns the badge', () => {
    const w = eraWorld(100e3, { k8sNodes: 19 }); // half-fleet failover still covers the peak
    ensureCloud(w);
    setSecondaryRegion(w, 'volt', 'us-central-1');
    w.cloud!.outage = { provider: 'stratus', region: 'us-east-1', startedAtMin: w.nowMin, durationMin: 10, creditClaimed: false };
    w.nowMin += 11;
    tick(w, 1); // the outage ends this minute
    expect(w.cloud!.outage!.endedAtMin).toBeDefined();
    expect(w.era!.badges).toContain('outage-zero');
  });
});

describe('scale era P6e: share codes', () => {
  it('round-trips a run summary offline, and rejects corruption', () => {
    const w = eraWorld(1e6);
    w.era!.badges = ['mrr-1m'];
    w.era!.rdLevel = 2;
    const { code, summary } = shareCodeOf(w);
    expect(code.startsWith('SI-')).toBe(true);
    const parsed = parseShareCode(code);
    expect(parsed.ok).toBe(true);
    expect(parsed.summary!.users).toBe(summary.users);
    expect(parsed.summary!.mrr).toBe(summary.mrr);
    expect(parsed.summary!.robustness).toBe(summary.robustness);
    expect(parsed.summary!.badges).toBe(1);
    expect(parsed.summary!.rd).toBe(2);
    expect(parseShareCode(code.slice(0, -1) + '0').ok).toBe(false); // corrupted checksum
    expect(parseShareCode('NOPE-1-2-3-ABCD').ok).toBe(false);
  });
});
