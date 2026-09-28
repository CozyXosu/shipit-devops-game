// Terraform sim unit tests: HCL parsing, import, plan/apply, drift detection.
import { describe, it, expect } from 'vitest';
import { createWorld, tick, provisionVm, provisionLb, provisionDb } from '../server/src/world';
import { parseHcl, terraformCmd, ensureTfState } from '../server/src/sim/terraform';
import * as fs from '../server/src/sim/fs';

const MAIN_TF = `provider "stratus" {
  region = "us-east-1"
}

resource "stratus_vm" "web-01" {
  size = "m3.medium"
}

resource "stratus_vm" "vm-02" {
  size = "m3.medium"
}

resource "stratus_lb" "lb01" {
}

resource "stratus_db" "main" {
  plan = "db.small"
}
`;

function terraformWorld() {
  const w = createWorld('Acme Metrics', 'you');
  provisionVm(w);
  provisionLb(w);
  provisionDb(w, 'db.small');
  w.hosts['web-01'].packages.push('terraform');
  fs.ensureDir(w.hosts['web-01'].fs, '/opt/infra');
  fs.writeFile(w.hosts['web-01'].fs, '/opt/infra/main.tf', MAIN_TF);
  w.session.hostId = 'web-01';
  w.session.user = 'dev';
  w.session.cwd = '/opt/infra';
  ensureTfState(w);
  return w;
}

const run = (w: ReturnType<typeof terraformWorld>, cmd: string) =>
  terraformCmd(w, ['terraform', ...cmd.split(' ')], w.session.cwd);

describe('terraform sim', () => {
  it('parses HCL blocks and attrs; rejects garbage with a line number', () => {
    const parsed = parseHcl(MAIN_TF);
    expect(parsed.error).toBeUndefined();
    expect(parsed.blocks.filter((b) => b.type === 'resource')).toHaveLength(4);
    expect(parsed.blocks.find((b) => b.name === 'main')!.attrs.plan).toBe('db.small');
    const bad = parseHcl('resource "stratus_vm" "x" {\n  this is not an assignment\n}');
    expect(bad.error).toBeTruthy();
    expect(bad.error).toContain('line 2');
  });

  it('plan shows unmanaged resources as imports; import makes it clean', () => {
    const w = terraformWorld();
    expect(run(w, 'init').code).toBe(0);
    const plan1 = run(w, 'plan').lines.map((l) => l.text).join('\n');
    expect(plan1).toContain('to import');
    expect(run(w, 'import stratus_vm.web-01 i-1').code).toBe(0);
    expect(run(w, 'import stratus_vm.vm-02 i-2').code).toBe(0);
    expect(run(w, 'import stratus_lb.lb01 lb-1').code).toBe(0);
    expect(run(w, 'import stratus_db.main db-1').code).toBe(0);
    const plan2 = run(w, 'plan').lines.map((l) => l.text).join('\n');
    expect(plan2).toContain('No changes');
    expect(w.tf!.lastPlanClean).toBe(true);
  });

  it('import refuses resources that do not exist or are not declared', () => {
    const w = terraformWorld();
    run(w, 'init');
    expect(run(w, 'import stratus_vm.vm-99 i-9').code).toBe(1); // not in config
    expect(run(w, 'import stratus_db.main db-1').code).toBe(0); // db exists (provisioned above)
  });

  it('detects console drift and apply forces the cloud back to the code', () => {
    const w = terraformWorld();
    run(w, 'init');
    run(w, 'import stratus_vm.web-01 i-1');
    run(w, 'import stratus_vm.vm-02 i-2');
    run(w, 'import stratus_lb.lb01 lb-1');
    run(w, 'import stratus_db.main db-1');
    // someone clicks the console: db resized to db.micro behind terraform's back
    w.db.plan = 'db.micro';
    const driftPlan = run(w, 'plan').lines.map((l) => l.text).join('\n');
    expect(driftPlan).toContain('drift detected');
    expect(w.tf!.driftDetected).toBe(true);
    const apply = run(w, 'apply -auto-approve');
    expect(apply.code).toBe(0);
    expect(w.db.plan).toBe('db.small'); // forced back
    expect(w.tf!.driftResolved).toBe(true);
    expect(run(w, 'plan').lines.map((l) => l.text).join('\n')).toContain('No changes');
  });

  it('refuses to run outside /opt/infra and requires init', () => {
    const w = terraformWorld();
    const noInit = terraformCmd(w, ['terraform', 'plan'], '/opt/infra');
    expect(noInit.lines[0].text).toContain('init');
    expect(run(w, 'init').code).toBe(0);
    const wrongDir = terraformCmd(w, ['terraform', 'plan'], '/opt/app');
    expect(wrongDir.lines[0].text).toContain('/opt/infra');
  });

  it('the scheduled tf_drift event performs the console change', () => {
    const w = terraformWorld();
    w.scheduledEvents.push({ atMin: w.nowMin + 5, kind: 'tf_drift' });
    tick(w, 6);
    expect(w.db.plan).toBe('db.micro');
    expect(w.audit.some((a) => a.text.includes('DRIFT'))).toBe(true);
  });
});
