// Fog of war: telemetry, alerting and incident detection are gated on the
// observability agent. The world simulates everything regardless — the
// player just cannot see it until instrumentation exists. Manual channels
// (the terminal) stay open: automation buys continuous sight, not truth.
import { describe, it, expect } from 'vitest';
import { createWorld, tick, installMonitoringAgent, addAlertRule, metricsView, BLIND_DETECT_MIN } from '../server/src/world';
import { runTerminalInput } from '../server/src/sim/host';
import { World } from '../server/src/types';

function freshWorld(): World {
  const w = createWorld('Acme Metrics', 'you');
  w.company.launched = true; // there is traffic to degrade
  w.app.mode = 'service'; // the api is up, so errors surface in error_pct
  return w;
}

const sh = (w: World, cmd: string) => runTerminalInput(w, cmd).lines.map((l) => l.text).join('\n');

describe('fog of war: telemetry is invisible before the observability agent', () => {
  it('before the agent: view-model exposes nothing, truth still accumulates, terminal still works', () => {
    const w = freshWorld();
    tick(w, 30);
    const mv = metricsView(w);
    expect(mv.fog).toBe(true);
    expect(Object.keys(mv.latest)).toHaveLength(0);
    expect(Object.keys(mv.series)).toHaveLength(0);
    // the world kept simulating — the fog is in the view, not the truth
    expect((w.monitoring.series.cpu_pct ?? []).length).toBeGreaterThan(0);
    // the manual channel is open: ssh in and look directly
    expect(sh(w, 'ssh dev@203.0.113.10')).toContain('password');
    sh(w, 'dev');
    expect(sh(w, 'df -h')).toContain('Use%');
  });

  it('installing the agent starts the flow from install time — no backfill', () => {
    const w = freshWorld();
    tick(w, 20);
    const installedAt = w.nowMin;
    installMonitoringAgent(w);
    expect(w.monitoring.agentInstalledAtMin).toBe(installedAt);
    tick(w, 5);
    const mv = metricsView(w);
    expect(mv.fog).toBe(false);
    expect(mv.series.cpu_pct).toHaveLength(6); // point at the install minute + the 5 since
    expect(mv.latest.error_pct).toBeDefined();
  });

  it('alert rules require a data source: you cannot alert on data you do not collect', () => {
    const w = freshWorld();
    expect(addAlertRule(w, 'error_pct', '>', 2)).toBeNull();
    expect(w.monitoring.alertRules).toHaveLength(0);
    installMonitoringAgent(w);
    expect(addAlertRule(w, 'error_pct', '>', 2)).not.toBeNull();
    expect(w.monitoring.alertRules).toHaveLength(1);
  });
});

describe('fog of war: blind incidents are detected by customers, slowly', () => {
  it('disk-full incident smolders undetected, then arrives as a customer report', () => {
    const w = freshWorld();
    w.hosts['web-01'].diskUsedBaseMB = w.hosts['web-01'].diskTotalMB * 0.999;
    tick(w, 10);
    expect(w.monitoring.incidents).toHaveLength(0);
    tick(w, 13); // crosses a %12 signal tick
    expect(w.audit.some((a) => a.kind === 'signal')).toBe(true); // customer noise is the only breadcrumb
    tick(w, BLIND_DETECT_MIN);
    const inc = w.monitoring.incidents.find((i) => i.kind === 'disk_full');
    expect(inc).toBeDefined();
    expect(inc!.detectedBy).toContain('customer report');
    expect(inc!.timeline.some((t) => t.text.includes('no alerting'))).toBe(true);
  });

  it('with the agent, the same failure is detected immediately by monitoring', () => {
    const w = freshWorld();
    installMonitoringAgent(w);
    w.hosts['web-01'].diskUsedBaseMB = w.hosts['web-01'].diskTotalMB * 0.999;
    tick(w, 3);
    const inc = w.monitoring.incidents.find((i) => i.kind === 'disk_full');
    expect(inc).toBeDefined();
    expect(inc!.detectedBy).not.toContain('customer report');
    expect(w.audit.some((a) => a.kind === 'signal')).toBe(false);
  });

  it('bad deploy while blind: the regression runs ~BLIND_DETECT_MIN before anyone notices', () => {
    const w = freshWorld();
    w.flags.badDeployBug = true;
    tick(w, 10);
    expect(w.monitoring.incidents.find((i) => i.kind === 'bad_deploy')).toBeUndefined();
    tick(w, BLIND_DETECT_MIN);
    const inc = w.monitoring.incidents.find((i) => i.kind === 'bad_deploy');
    expect(inc).toBeDefined();
    expect(inc!.detectedBy).toContain('customer report');
  });

  it('bad deploy with the agent: alert fires within minutes', () => {
    const w = freshWorld();
    installMonitoringAgent(w);
    w.flags.badDeployBug = true;
    tick(w, 5);
    expect(w.monitoring.incidents.find((i) => i.kind === 'bad_deploy')).toBeDefined();
  });

  it('the blind window resets if the condition clears before anyone notices', () => {
    const w = freshWorld();
    w.hosts['web-01'].diskUsedBaseMB = w.hosts['web-01'].diskTotalMB * 0.999;
    tick(w, 20); // ~19 min into the blind window
    expect(w.monitoring.incidents).toHaveLength(0);
    w.hosts['web-01'].diskUsedBaseMB = 1000; // freed before detection
    tick(w, 2);
    expect(w.monitoring.incidents).toHaveLength(0);
    w.hosts['web-01'].diskUsedBaseMB = w.hosts['web-01'].diskTotalMB * 0.999; // fills again
    tick(w, 10); // less than the window from the NEW onset
    expect(w.monitoring.incidents).toHaveLength(0);
  });
});

describe('fog of war: save compatibility', () => {
  it('old save with agentInstalled but no agentInstalledAtMin sees everything', () => {
    const w = freshWorld();
    w.monitoring.agentInstalled = true; // legacy shape: install time unknown
    tick(w, 5);
    const mv = metricsView(w);
    expect(mv.fog).toBe(false);
    expect(mv.series.cpu_pct).toHaveLength(5); // since defaults to 0 — full history stays visible
    expect(w.monitoring.agentInstalledAtMin).toBeUndefined(); // installMonitoringAgent early-returns on legacy saves
  });
});
