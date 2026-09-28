// Operate-phase unit tests: team/on-call, technical debt, canary, SLOs.
import { describe, it, expect } from 'vitest';
import { createWorld, tick, hireEngineer, fireEngineer, setOnCall, ensureTeam, ensureDebt, startRefactorProject, addDebt, payrollOf, ambientIncidentChance, runMarketingCampaign, configureSlos, sloReport, promoteCanary, abortCanary, openAmbientIncident, ROLE_INFO } from '../server/src/world';
import { startCanary } from '../server/src/sim/ci';

function operateWorld() {
  const w = createWorld('Acme Metrics', 'you');
  w.company.launched = true;
  w.company.users = 20000;
  w.flags.buildPhaseComplete = true;
  return w;
}

describe('team & on-call', () => {
  it('hires unique engineers, computes payroll, fires them', () => {
    const w = operateWorld();
    expect(hireEngineer(w, 'senior').ok).toBe(true);
    expect(hireEngineer(w, 'sre').ok).toBe(true);
    expect(hireEngineer(w, 'mid').ok).toBe(true);
    const team = ensureTeam(w);
    expect(team.engineers.length).toBe(3);
    expect(new Set(team.engineers.map((e) => e.name)).size).toBe(3);
    expect(payrollOf(w)).toBe(12000 + 9500 + 11000 + 6000);
    const sre = team.engineers.find((e) => e.role === 'sre')!;
    expect(setOnCall(w, sre.id).ok).toBe(true);
    expect(team.onCallId).toBe(sre.id);
    expect(fireEngineer(w, sre.id).ok).toBe(true);
    expect(team.onCallId).toBeNull(); // rotation cleared with the departure
  });

  it('the on-call engineer gets paged when an incident opens', () => {
    const w = operateWorld();
    hireEngineer(w, 'sre');
    setOnCall(w, ensureTeam(w).engineers[0].id);
    openAmbientIncident(w);
    const inc = w.monitoring.incidents[0];
    expect(w.flags.onCallPaged).toBe(true);
    expect(inc.timeline.some((ev) => ev.text.includes('paged'))).toBe(true);
    expect(inc.customerImpact).toContain('SRE on call');
  });

  it('without on-call the pager goes to the founder', () => {
    const w = operateWorld();
    openAmbientIncident(w);
    expect(w.monitoring.incidents[0].timeline.some((ev) => ev.text.includes('NOBODY IS ON CALL'))).toBe(true);
  });

  it('seniors dampen ambient incident probability; debt raises it', () => {
    const w = operateWorld();
    const base = ambientIncidentChance(w);
    addDebt(w, 60, 'test');
    const withDebt = ambientIncidentChance(w);
    expect(withDebt).toBeGreaterThan(base);
    hireEngineer(w, 'senior');
    hireEngineer(w, 'senior');
    hireEngineer(w, 'senior');
    expect(ambientIncidentChance(w)).toBeLessThan(withDebt);
  });
});

describe('technical debt', () => {
  it('seeds from history and refactor projects pay it down', () => {
    const w = operateWorld();
    w.monitoring.incidents.push({
      id: 'x', kind: 'bad_deploy', title: 't', symptom: 's', severity: 'SEV2',
      openedAtMin: w.nowMin, status: 'resolved', rootCause: '', customerImpact: '', detectedBy: '',
      timeline: [], corrective: [], postmortemFiled: true
    });
    const debt = ensureDebt(w);
    expect(debt.points).toBeGreaterThan(4); // incident history counted
    expect(startRefactorProject(w, 'rm-legacy').ok).toBe(true);
    expect(startRefactorProject(w, 'rm-legacy').ok).toBe(false); // no double-start
    w.company.cash = 0;
    expect(startRefactorProject(w, 'runbooks').ok).toBe(false); // needs cash
    for (let i = 0; i < 20 && !debt.projects[0].done; i++) tick(w, 10);
    expect(debt.projects[0].done).toBe(true);
    expect(debt.points).toBeLessThan(ensureDebt(w).points + 8); // reduced
  });

  it('engineers pay down debt passively over sim days', () => {
    const w = createWorld('Acme Metrics', 'you'); // no ambient events in this world
    const debt = ensureDebt(w);
    const before = debt.points;
    hireEngineer(w, 'senior'); // 0.6/day
    tick(w, 1440 * 2);
    expect(debt.points).toBeCloseTo(before - 1.2, 5);
  });
});

describe('marketing', () => {
  it('costs cash and boosts growth for a bounded window', () => {
    const a = operateWorld();
    a.company.cash = 5000;
    expect(runMarketingCampaign(a).ok).toBe(true);
    expect(a.company.cash).toBe(3000);
    const b = operateWorld(); // identical world, no campaign
    const au = a.company.users, bu = b.company.users;
    tick(a, 120);
    tick(b, 120);
    expect(a.company.users - au).toBeGreaterThan((b.company.users - bu) * 2); // 2.5× growth
    tick(a, 150); // campaign ends at +240
    expect(Number(a.flags.marketingUntilMin)).toBeLessThanOrEqual(a.nowMin);
  });
});

describe('canary', () => {
  it('aborts on a live bug before production is touched', () => {
    const w = operateWorld();
    w.flags.canaryRuntimeBug = true;
    startCanary(w, 'registry.acme.dev/acme/api:v4');
    tick(w, 9);
    expect(w.ci.canary!.status).toBe('aborted');
    expect(w.flags.canaryAutoAbort).toBe(true);
    expect(w.flags.badDeployBug).toBeFalsy();
  });

  it('promotes a clean canary after the observation window', () => {
    const w = operateWorld();
    startCanary(w, 'registry.acme.dev/acme/api:v5');
    tick(w, 31);
    expect(w.ci.canary!.status).toBe('promoted');
    expect(w.flags.canaryPromoted).toBe(true);
    expect(w.app.image).toBe('registry.acme.dev/acme/api:v5');
  });

  it('manual promote and abort endpoints behave', () => {
    const w = operateWorld();
    startCanary(w, 'registry.acme.dev/acme/api:v6');
    expect(promoteCanary(w, 'manual').ok).toBe(true);
    startCanary(w, 'registry.acme.dev/acme/api:v7');
    expect(abortCanary(w, 'operator judgment').ok).toBe(true);
    expect(promoteCanary(w).ok).toBe(false); // nothing running
  });
});

describe('SLOs & error budgets', () => {
  it('validates targets and reports budget math consistently', () => {
    const w = operateWorld();
    expect(configureSlos(w, 50, 600).ok).toBe(false);  // availability out of range
    expect(configureSlos(w, 99.9, 100).ok).toBe(false); // p95 out of range
    expect(configureSlos(w, 99.5, 1000).ok).toBe(true);
    const report = sloReport(w);
    // 99.5% of a 30d window allows 216 bad minutes
    expect(report.budgetAllowedMin).toBeCloseTo(216, 0);
    expect(report.budgetRemainingPct).toBeGreaterThanOrEqual(0);
    expect(report.budgetRemainingPct).toBeLessThanOrEqual(100);
  });

  it('burning bad minutes shrinks the remaining budget', () => {
    const w = operateWorld();
    configureSlos(w, 99.5, 1000);
    w.flags.uptimeBadMin = 108; // half the 216-minute budget
    const report = sloReport(w);
    expect(report.budgetRemainingPct).toBeCloseTo(50, 0);
  });

  it('ROLE_INFO covers every engineer role with a salary', () => {
    for (const role of ['junior', 'mid', 'senior', 'sre'] as const) {
      expect(ROLE_INFO[role].salary).toBeGreaterThan(0);
      expect(ROLE_INFO[role].debtPerDay).toBeGreaterThan(0);
    }
  });
});
