// Terraform simulation: a small HCL subset over the same world the cloud
// console mutates. Config files describe stratus_vm / stratus_lb / stratus_db
// resources; plan diffs config-vs-state-vs-real-world so drift (console
// changes) becomes visible, and apply reconciles the world back to code.
import { World, TfResource, OutLine } from '../types';
import { getDir, listDir } from './fs';
import { hashStr } from './docker';
import { provisionVm, provisionLb, provisionDb, resizeDb } from '../world';

export const TF_DIR = '/opt/infra';

// ------------------------------------------------------------------
// HCL subset parser: provider/terraform/resource blocks + key = value attrs
// ------------------------------------------------------------------
export interface HclBlock {
  type: 'resource' | 'provider' | 'terraform' | 'variable' | 'output';
  resourceType?: string; // for resource blocks: stratus_vm
  name: string;
  attrs: Record<string, string>;
}

export function parseHcl(text: string): { blocks: HclBlock[]; error?: string } {
  const lines = text.split('\n');
  const blocks: HclBlock[] = [];
  let i = 0;
  const strip = (s: string) => {
    const c = s.indexOf('#'); const c2 = s.indexOf('//');
    let cut = -1;
    if (c >= 0) cut = c;
    if (c2 >= 0 && (cut === -1 || c2 < cut)) cut = c2;
    return (cut >= 0 ? s.slice(0, cut) : s).trim();
  };
  while (i < lines.length) {
    const line = strip(lines[i]);
    i++;
    if (!line) continue;
    const bm = /^(resource|provider|terraform|variable|output)\s+"?([\w-]+)"?\s*(?:"([\w-]+)")?\s*\{/.exec(line);
    if (!bm) {
      if (line === '}') continue;
      return { blocks: [], error: `line ${i}: expected a block like "resource \"stratus_vm\" \"web-01\" {"` };
    }
    const block: HclBlock = {
      type: bm[1] as HclBlock['type'],
      resourceType: bm[1] === 'resource' ? bm[2] : undefined,
      name: bm[1] === 'resource' ? (bm[3] ?? '') : bm[2],
      attrs: {}
    };
    // attrs until closing brace
    let closed = false;
    while (i < lines.length) {
      const inner = strip(lines[i]);
      i++;
      if (!inner) continue;
      if (inner === '}') { closed = true; break; }
      const am = /^([\w-]+)\s*=\s*(.+)$/.exec(inner);
      if (!am) return { blocks: [], error: `line ${i}: expected "key = value" or "}"` };
      block.attrs[am[1]] = unquote(am[2]);
    }
    if (!closed) return { blocks: [], error: `unterminated block "${block.name}" — missing "}"` };
    blocks.push(block);
  }
  return { blocks };
}

function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  // strip trailing comments and references like stratus_lb.lb01.id
  return s;
}

// ------------------------------------------------------------------
// Config <-> world mapping
// ------------------------------------------------------------------
type ResourceKind = 'vm' | 'lb' | 'db';

function kindOf(resourceType: string): ResourceKind | null {
  if (resourceType === 'stratus_vm') return 'vm';
  if (resourceType === 'stratus_lb') return 'lb';
  if (resourceType === 'stratus_db') return 'db';
  return null;
}

interface ActualAttrs { exists: boolean; attrs: Record<string, string>; id: string }

/** What the real world looks like for a resource address. */
function actualWorld(world: World, kind: ResourceKind, name: string): ActualAttrs {
  if (kind === 'vm') {
    const host = world.hosts[name];
    if (!host || name === 'laptop') return { exists: false, attrs: {}, id: '' };
    return { exists: true, attrs: { size: 'm3.medium', image: host.os, ip: host.ip }, id: 'i-' + hashStr(name).slice(0, 8) };
  }
  if (kind === 'lb') {
    if (!world.lb?.provisioned) return { exists: false, attrs: {}, id: '' };
    return { exists: true, attrs: { ip: world.lb.ip }, id: 'lb-' + hashStr('lb01').slice(0, 8) };
  }
  if (!world.db.provisioned) return { exists: false, attrs: {}, id: '' };
  return { exists: true, attrs: { plan: world.db.plan, version: world.db.version }, id: 'db-' + hashStr('main').slice(0, 8) };
}

/** Attributes that matter for plan/apply comparison. */
const TRACKED: Record<ResourceKind, string[]> = {
  vm: ['size', 'image'],
  lb: ['ip'],
  db: ['plan']
};

interface PlanAction {
  address: string;
  verb: 'create' | 'import' | 'update' | 'destroy' | 'drift-update';
  detail: string;
}

export function computePlan(world: World): { actions: PlanAction[]; clean: boolean; drift: boolean } {
  const tf = world.tf!;
  const { blocks, error } = readConfig(world);
  if (error) return { actions: [], clean: false, drift: false };
  const actions: PlanAction[] = [];
  let drift = false;
  const configAddrs = new Set<string>();

  for (const b of blocks) {
    if (b.type !== 'resource') continue;
    const kind = kindOf(b.resourceType!);
    if (!kind) continue;
    const address = `${b.resourceType}.${b.name}`;
    configAddrs.add(address);
    const stateRes = tf.resources[address];
    const tracked = TRACKED[kind];
    const actual = actualWorld(world, kind, b.name);

    if (!stateRes) {
      // not managed yet
      if (actual.exists) {
        actions.push({ address, verb: 'import', detail: `exists in the cloud but is not managed — run:\n  terraform import ${address} ${actual.id}` });
      } else {
        actions.push({ address, verb: 'create', detail: `will be created (${fmtAttrs(b.attrs, tracked)})` });
      }
      continue;
    }
    // state exists: compare config vs state (desired change) and state vs world (drift)
    for (const key of tracked) {
      const want = b.attrs[key];
      if (want === undefined) continue;
      const had = stateRes.attrs[key];
      const is = actual.attrs[key];
      if (had !== want && is === want) {
        actions.push({ address, verb: 'update', detail: `${key}: "${had}" → "${want}"` });
      } else if (is !== want) {
        drift = true;
        actions.push({ address, verb: 'drift-update', detail: `drift detected: ${key} is "${is}" in the cloud but "${want}" in code (state had "${had}")` });
      }
    }
    if (!actual.exists) {
      actions.push({ address, verb: 'destroy', detail: 'resource in state no longer exists in the cloud' });
    }
  }
  for (const addr of Object.keys(tf.resources)) {
    if (!configAddrs.has(addr)) {
      actions.push({ address: addr, verb: 'destroy', detail: 'in state but not in configuration' });
    }
  }
  return { actions, clean: actions.length === 0, drift };
}

function fmtAttrs(attrs: Record<string, string>, keys: string[]): string {
  return keys.filter((k) => attrs[k] !== undefined).map((k) => `${k} = "${attrs[k]}"`).join(', ');
}

/** Read all *.tf files in the terraform dir. */
function readConfig(world: World): { blocks: HclBlock[]; error?: string } {
  const dir = getDir(world.hosts['web-01'].fs, TF_DIR);
  if (!dir) return { blocks: [], error: `${TF_DIR} does not exist — create it and write main.tf` };
  const files = (listDir(dir, '') ?? []).filter((e) => e.name.endsWith('.tf') && e.node.type === 'file');
  if (!files.length) return { blocks: [], error: `no .tf files in ${TF_DIR} — write ${TF_DIR}/main.tf` };
  const blocks: HclBlock[] = [];
  for (const { name, node } of files) {
    const parsed = parseHcl((node as { content: string }).content);
    if (parsed.error) return { blocks: [], error: `${name}: ${parsed.error}` };
    blocks.push(...parsed.blocks);
  }
  return { blocks };
}

// ------------------------------------------------------------------
// terraform command engine
// ------------------------------------------------------------------
export interface TfResult { lines: OutLine[]; code: number }

export function ensureTfState(world: World): NonNullable<World['tf']> {
  if (!world.tf) {
    world.tf = { initialized: false, dir: TF_DIR, resources: {}, lastPlan: [], lastPlanAtMin: 0, lastPlanClean: false, driftDetected: false, driftResolved: false };
  }
  return world.tf;
}

export function terraformCmd(world: World, argv: string[], cwd: string): TfResult {
  const sub = argv[1];
  const err = (t: string): TfResult => ({ lines: [{ text: `Error: ${t}`, cls: 'err' }], code: 1 });
  const out = (lines: OutLine[], code = 0): TfResult => ({ lines, code });

  if (!sub || sub === 'help' || sub === '-help') {
    return out([
      { text: 'Terraform v1.8.4 (simulated)', cls: 'hdr' },
      { text: 'usage: terraform <command> [args]', cls: 'dim' },
      { text: '' },
      { text: 'init      initialize the working directory (.terraform, providers)' },
      { text: 'validate  check the configuration files' },
      { text: 'plan      show changes required by the configuration' },
      { text: 'apply     create/update resources to match the configuration' },
      { text: 'import    bring an existing cloud resource under management' },
      { text: 'show      show the current state' },
      { text: `work in ${TF_DIR} (create main.tf with the EDITOR)` }
    ]);
  }
  if (sub === 'init') {
    const tf = ensureTfState(world);
    const dir = getDir(world.hosts['web-01'].fs, TF_DIR);
    if (!dir) return err(`${TF_DIR} does not exist. Create it first: mkdir -p ${TF_DIR}`);
    tf.initialized = true;
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'tf', text: 'terraform init — provider stratus installed, backend local' });
    return out([
      { text: 'Initializing the backend...', cls: 'dim' },
      { text: 'Initializing provider plugins...', cls: 'dim' },
      { text: '- Finding stratuscloud/stratus versions matching "1.8"...', cls: 'dim' },
      { text: '- Installing stratuscloud/stratus v1.8.4...', cls: 'dim' },
      { text: 'Terraform has created a lock file .terraform.lock.hcl', cls: 'ok' },
      { text: 'Terraform has been successfully initialized!', cls: 'ok' }
    ]);
  }

  const tf = ensureTfState(world);
  if (!tf.initialized) return err('the working directory is not initialized — run terraform init first');
  if (cwd !== TF_DIR) {
    return err(`this is not the terraform working directory — cd ${TF_DIR} first`);
  }

  switch (sub) {
    case 'validate': {
      const { blocks, error } = readConfig(world);
      if (error) return err(error);
      void blocks;
      return out([{ text: 'Success! The configuration is valid.', cls: 'ok' }]);
    }
    case 'plan': {
      const { actions, clean, drift } = computePlan(world);
      const tf = world.tf!;
      tf.lastPlanAtMin = world.nowMin;
      tf.lastPlanClean = clean;
      tf.lastPlan = actions.map((a) => `${a.verb === 'import' ? '+' : a.verb === 'create' ? '+' : a.verb === 'destroy' ? '-' : '~'} ${a.address}: ${a.detail}`);
      if (drift) {
        tf.driftDetected = true;
        world.audit.push({ t: world.nowMin, actor: 'terraform', kind: 'tf', text: 'terraform plan: DRIFT DETECTED — the cloud no longer matches the code' });
      }
      const lines: OutLine[] = [{ text: 'stratus_vm.stratus_lb.stratus_db: refreshing state...', cls: 'dim' }];
      if (clean) {
        lines.push({ text: '' }, { text: 'No changes. Your infrastructure matches the configuration.', cls: 'ok' });
        return out(lines);
      }
      lines.push({ text: '', cls: undefined }, { text: 'Terraform will perform the following actions:', cls: 'hdr' });
      let nCreate = 0, nChange = 0, nDestroy = 0, nImport = 0;
      for (const a of actions) {
        const mark = a.verb === 'create' ? '  +' : a.verb === 'destroy' ? '  -' : '  ~';
        const cls: OutLine['cls'] = a.verb === 'drift-update' ? 'err' : a.verb === 'import' ? 'warn' : undefined;
        lines.push({ text: `${mark} ${a.address}`, cls });
        for (const l of a.detail.split('\n')) lines.push({ text: `      ${l}`, cls: cls === 'err' ? 'err' : 'dim' });
        if (a.verb === 'create') nCreate++;
        else if (a.verb === 'destroy') nDestroy++;
        else if (a.verb === 'import') nImport++;
        else nChange++;
      }
      lines.push({ text: '' }, { text: `Plan: ${nCreate} to add, ${nChange} to change, ${nDestroy} to destroy${nImport ? `, ${nImport} to import` : ''}.`, cls: drift ? 'warn' : 'hdr' });
      if (drift) lines.push({ text: 'Note: drift between the code and the cloud was detected. terraform apply will force the cloud back to the code.', cls: 'warn' });
      return out(lines);
    }
    case 'apply': {
      const auto = argv.includes('-auto-approve') || argv.includes('--auto-approve');
      const { actions, drift } = computePlan(world);
      if (!actions.length) return out([{ text: 'Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', cls: 'ok' }]);
      const lines: OutLine[] = [];
      if (!auto) lines.push({ text: '(run with -auto-approve in this sim — skipping the interactive prompt)', cls: 'dim' });
      let added = 0, changed = 0, destroyed = 0;
      for (const a of actions) {
        const ok = applyAction(world, a, lines);
        if (!ok) return { lines: [...lines, { text: `Error: cannot apply ${a.address} — resolve the error above first`, cls: 'err' }], code: 1 };
        if (a.verb === 'create') added++;
        else if (a.verb === 'destroy') destroyed++;
        else changed++;
      }
      if (drift) {
        world.tf!.driftResolved = true;
        world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'tf', text: 'terraform apply: drift reconciled — the cloud matches the code again' });
      }
      lines.push({ text: `Apply complete! Resources: ${added} added, ${changed} changed, ${destroyed} destroyed.`, cls: 'ok' });
      return out(lines);
    }
    case 'import': {
      const address = argv[2];
      const id = argv[3];
      if (!address || !id) return err('usage: terraform import <resource_type>.<name> <cloud id>');
      const [rt, rn] = address.split('.');
      if (!rt || !rn) return err('address must look like stratus_vm.web-01');
      const kind = kindOf(rt);
      if (!kind) return err(`unsupported resource type "${rt}" (supported: stratus_vm, stratus_lb, stratus_db)`);
      const { blocks } = readConfig(world);
      const inConfig = blocks.some((b) => b.type === 'resource' && b.resourceType === rt && b.name === rn);
      if (!inConfig) return err(`resource ${address} is not declared in the configuration — add it to main.tf first`);
      const actual = actualWorld(world, kind, rn);
      if (!actual.exists) return err(`cannot import ${address}: no such resource in the cloud (id "${id}" not found)`);
      world.tf!.resources[address] = { address, type: rt, name: rn, attrs: { ...actual.attrs }, id };
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'tf', text: `Imported ${address} (id ${id})` });
      return out([
        { text: 'Import successful!', cls: 'ok' },
        { text: '', cls: undefined },
        { text: 'The resource is now in terraform state. Review the plan before your next apply.', cls: 'dim' }
      ]);
    }
    case 'show':
    case 'state': {
      if (sub === 'state' && argv[2] !== 'list') return err('usage: terraform state list');
      const resources = Object.values(world.tf!.resources);
      if (!resources.length) return out([{ text: 'The state file is empty. Resources that exist must be imported first.', cls: 'dim' }]);
      const lines: OutLine[] = [];
      if (sub === 'show') lines.push({ text: '# terraform.tfstate (local)', cls: 'hdr' });
      for (const r of resources) {
        if (sub === 'state') { lines.push({ text: r.address }); continue; }
        lines.push({ text: `resource "${r.type}" "${r.name}" {`, cls: 'hdr' });
        lines.push({ text: `    id     = "${r.id}"`, cls: 'dim' });
        for (const [k, v] of Object.entries(r.attrs)) lines.push({ text: `    ${k.padEnd(7)} = "${v}"`, cls: 'dim' });
        lines.push({ text: `}`, cls: 'hdr' });
      }
      return out(lines);
    }
    case 'destroy':
      return err('destroy is disabled in the company sim — you still need this infrastructure');
    default:
      return err(`unknown command "${sub}" — try terraform help`);
  }
}

/** Apply one action; returns false with output lines on a hard error. */
function applyAction(world: World, a: PlanAction, lines: OutLine[]): boolean {
  const [rt, rn] = a.address.split('.');
  const kind = kindOf(rt);
  if (!kind) { lines.push({ text: `  ✗ ${a.address}: unsupported resource type`, cls: 'err' }); return false; }
  const { blocks } = readConfig(world);
  const cfg = blocks.find((b) => b.type === 'resource' && b.resourceType === rt && b.name === rn);

  if (a.verb === 'create') {
    if (actualWorld(world, kind, rn).exists) {
      lines.push({ text: `  ✗ ${a.address}: resource already exists in the cloud — import it instead`, cls: 'err' });
      return false;
    }
    if (kind === 'vm') {
      // creating a second-class VM through code (same as the console does)
      const r = provisionVm(world);
      if (!r.ok) { lines.push({ text: `  ✗ ${a.address}: ${r.message}`, cls: 'err' }); return false; }
      lines.push({ text: `  + ${a.address}: VM ${rn} provisioned`, cls: 'ok' });
    } else if (kind === 'lb') {
      const r = provisionLb(world);
      if (!r.ok) { lines.push({ text: `  ✗ ${a.address}: ${r.message}`, cls: 'err' }); return false; }
      lines.push({ text: `  + ${a.address}: load balancer provisioned`, cls: 'ok' });
    } else {
      const plan = (cfg?.attrs.plan === 'db.micro' || cfg?.attrs.plan === 'db.medium') ? cfg!.attrs.plan as 'db.micro' | 'db.medium' : 'db.small';
      const r = provisionDb(world, plan);
      if (!r.ok) { lines.push({ text: `  ✗ ${a.address}: ${r.message}`, cls: 'err' }); return false; }
      lines.push({ text: `  + ${a.address}: managed Postgres provisioned (${plan})`, cls: 'ok' });
    }
    world.tf!.resources[a.address] = { address: a.address, type: rt, name: rn, attrs: { ...actualWorld(world, kind, rn).attrs }, id: actualWorld(world, kind, rn).id };
    return true;
  }
  if (a.verb === 'import') {
    lines.push({ text: `  ~ ${a.address}: exists — import it first: terraform import ${a.address} <id>`, cls: 'warn' });
    return false;
  }
  if (a.verb === 'update' || a.verb === 'drift-update') {
    // reconcile the world to the code
    if (kind === 'db' && cfg?.attrs.plan) {
      resizeDb(world, cfg.attrs.plan as 'db.micro' | 'db.small' | 'db.medium');
      lines.push({ text: `  ~ ${a.address}: plan → ${cfg.attrs.plan}`, cls: 'ok' });
    } else {
      lines.push({ text: `  ~ ${a.address}: attributes synchronized`, cls: 'ok' });
    }
    world.tf!.resources[a.address] = { address: a.address, type: rt, name: rn, attrs: { ...cfg?.attrs }, id: actualWorld(world, kind, rn).id };
    return true;
  }
  if (a.verb === 'destroy') {
    lines.push({ text: `  - ${a.address}: removed from state (the cloud resource stays — this sim refuses to destroy production)`, cls: 'warn' });
    delete world.tf!.resources[a.address];
    return true;
  }
  return false;
}
