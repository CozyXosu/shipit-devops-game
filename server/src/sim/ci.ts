// CI simulation: validate pipeline YAML (GitHub-Actions-flavored subset),
// run stages with realistic logs, build/push images through the docker sim,
// create deployments, support rollback.
import { World, Pipeline, PipelineStep, CiRun, Deployment, OutLine } from '../types';
import { parseYaml } from './yaml';
import { buildImage, pushToRegistry } from './docker';
import { readFile } from './fs';
import { findRepoFor, worktreeFiles } from './git';
import { hashStr } from './docker';

export function loadPipeline(world: World, repoPath: string, relFile: string): Pipeline {
  const fs = world.hosts['web-01'].fs;
  const path = `${repoPath}/${relFile}`;
  const content = readFile(fs, path);
  const p: Pipeline = { name: 'pipeline', on: 'push', steps: [], path: relFile, valid: false, problems: [] };
  if (content === null) { p.problems.push(`${relFile}: file not found`); return p; }
  const parsed = parseYaml(content);
  if (parsed.error) { p.problems.push(`YAML error: ${parsed.error.message} (line ${parsed.error.line})`); return p; }
  const doc = parsed.value as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') { p.problems.push('YAML root must be a mapping'); return p; }
  p.name = typeof doc.name === 'string' ? doc.name : 'pipeline';
  p.on = typeof doc.on === 'string' ? doc.on : 'push';
  const stepsRaw = doc.steps;
  if (!Array.isArray(stepsRaw)) { p.problems.push('missing "steps:" list'); return p; }
  let i = 0;
  for (const s of stepsRaw) {
    i++;
    if (!s || typeof s !== 'object') { p.problems.push(`step ${i}: not a mapping`); continue; }
    const st = s as Record<string, unknown>;
    const step: PipelineStep = {
      name: typeof st.name === 'string' ? st.name : `step-${i}`,
      uses: typeof st.uses === 'string' ? st.uses : undefined,
      run: typeof st.run === 'string' ? st.run : undefined,
      with: (st.with && typeof st.with === 'object') ? Object.fromEntries(Object.entries(st.with as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined
    };
    if (!step.uses && !step.run) p.problems.push(`step "${step.name}": needs "run:" or "uses:"`);
    p.steps.push(step);
  }
  p.valid = p.problems.length === 0 && p.steps.length > 0;
  return p;
}

export interface StageCheck { kind: 'checkout' | 'test' | 'build' | 'docker_build' | 'push' | 'deploy' | 'other'; present: boolean }

export function analyzeStages(p: Pipeline): StageCheck[] {
  const has = (fn: (s: PipelineStep) => boolean) => p.steps.some(fn);
  return [
    { kind: 'checkout', present: has((s) => (s.uses ?? '').includes('checkout')) },
    { kind: 'test', present: has((s) => /test/i.test(s.name) || /test/.test(s.run ?? '')) },
    { kind: 'build', present: has((s) => /build/.test(s.name) && !/docker/i.test(s.name) && !/docker/i.test(s.run ?? '')) },
    { kind: 'docker_build', present: has((s) => /docker/.test(s.name) && /build/.test(s.name + (s.run ?? '')) || /^docker\s+build/.test(s.run ?? '')) },
    { kind: 'push', present: has((s) => /push/.test(s.name + (s.run ?? ''))) },
    { kind: 'deploy', present: has((s) => /deploy/.test(s.name) || (s.uses ?? '').includes('deploy') || /deploy/.test(s.run ?? '')) }
  ];
}

export function runPipeline(world: World, pipelinePath: string): CiRun {
  const repo = findRepoFor(world, '/opt/app');
  const repoPath = repo?.path ?? '/opt/app';
  const pipeline = loadPipeline(world, repoPath, pipelinePath);
  const headSha = repo ? (repo.branches[repo.head]?.commit ?? 'unknown') : 'no-repo';
  let lastBuiltTag: string | null = null;
  let pushedTag: string | null = null;
  const run: CiRun = {
    id: 'run-' + hashStr(pipelinePath + world.nowMin).slice(0, 6),
    startedAtMin: world.nowMin,
    pipelinePath,
    commitSha: headSha,
    status: 'running',
    stages: []
  };
  world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Pipeline ${pipeline.name} started on ${headSha.slice(0, 7)}` });
  world.ci.runs.push(run);
  if (world.ci.runs.length > 30) world.ci.runs.splice(0, world.ci.runs.length - 25);

  const finish = (status: 'success' | 'failed') => {
    run.status = status;
    world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Pipeline ${status === 'success' ? 'succeeded' : 'failed'} (${pipelinePath})` });
  };

  for (const step of pipeline.steps) {
    const stage: CiRun['stages'][number] = { name: step.name, status: 'success', log: [] };
    run.stages.push(stage);
    const log = stage.log;
    const kindOf = (step.uses ?? '') + ' ' + (step.run ?? '');
    if ((step.uses ?? '').includes('checkout')) {
      log.push(`HEAD is now at ${headSha.slice(0, 7)}`);
      log.push(`Checked out ${repoPath} (${repo ? Object.keys(repo.commits).length : 0} commits)`);
    } else if (/npm\s+test/.test(step.run ?? '')) {
      log.push('> api@1.0.0 test');
      log.push('> vitest run');
      log.push('');
      log.push(' 48 passing (3.1s)');
      if (world.flags.badCodeSeeded) {
        log.push(' 1 failing: orders endpoint returns 500 under load', 'FAILED');
        stage.status = 'failed';
        break;
      }
    } else if (/npm\s+(run\s+)?build|npm\s+ci/.test(step.run ?? '')) {
      log.push('dependencies installed (412 packages)');
      log.push('esbuild bundle complete: dist/server.js (1.2MB)');
    } else if (/^docker\s+build/.test(step.run ?? '') || /docker_build/.test(step.name)) {
      const tagM = /docker\s+build[^-]*-t\s+(\S+)/.exec(step.run ?? '');
      const rawTag = tagM ? tagM[1] : 'registry.acme.dev/api:latest';
      const tag = rawTag
        .replace('$COMMIT', headSha.slice(0, 7))
        .replace('${COMMIT}', headSha.slice(0, 7))
        .replace('$GITHUB_SHA', headSha.slice(0, 7));
      const res = buildImage(world, tag, `${repoPath}/Dockerfile`);
      log.push(...res.lines.map((l) => l.text));
      if (!res.ok) { stage.status = 'failed'; break; }
      stage.log.push(`Built ${tag} (${res.image?.sizeMB}MB)`);
      lastBuiltTag = tag;
    } else if (/^docker\s+push/.test(step.run ?? '') || /push/.test(step.name)) {
      const tag = lastBuiltTag ?? /docker\s+push\s+(\S+)/.exec(step.run ?? '')?.[1] ?? null;
      if (!tag) { log.push('no image to push: build step must run first'); stage.status = 'failed'; break; }
      log.push(...pushToRegistry(world, tag).map((l) => l.text));
      pushedTag = tag;
    } else if (/deploy/.test(step.name) || /deploy/.test(step.run ?? '') || (step.uses ?? '').includes('deploy')) {
      const image = step.with?.image ?? pushedTag ?? lastBuiltTag;
      if (!image) { log.push('no image available to deploy'); stage.status = 'failed'; break; }
      const d = deployImage(world, image as string, 'api', 'ci');
      log.push(`Deploying ${image} …`);
      log.push(`Container ${d ? 'replaced' : 'created'} for service api`);
      log.push('Health check passed after 3.2s');
      if (world.flags.nextDeployHasBug && !world.flags.badDeployBug) {
        world.flags.badDeployBug = true;
        world.flags.nextDeployHasBug = false;
        log.push('Deployment accepted; watch error rate closely');
      }
    } else if (step.run) {
      log.push(`$ ${step.run}`);
      log.push('done');
    }
  }

  // mark remaining stages skipped on failure
  if (run.status === 'running' && run.stages.some((s) => s.status === 'failed')) {
    let seenFailure = false;
    for (const s of run.stages) {
      if (s.status === 'failed') seenFailure = true;
      else if (seenFailure && s.status === 'success') s.status = 'skipped';
    }
    finish('failed');
  } else if (run.status === 'running') {
    finish('success');
  }
  return run;
}

export function deployImage(world: World, image: string, service: string, source: Deployment['source']): Deployment {
  // retire whatever currently serves the app port (manual container or CI one)
  const old = world.docker.containers.find((c) => c.status === 'running' && (c.serviceRef === service || c.hostPort === 8080));
  if (old) old.status = 'exited';
  const regImg = world.registry.find((i) => i.repoTags.includes(image));
  const localImg = world.docker.images.find((i) => i.repoTags.includes(image));
  const envFile = readFile(world.hosts['web-01'].fs, '/opt/app/.env') ?? '';
  const env: Record<string, string> = {};
  for (const l of envFile.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const cont = {
    id: hashStr(image + world.nowMin).slice(0, 12),
    name: service + '-' + hashStr(image + world.nowMin).toLowerCase().slice(0, 6),
    image,
    env,
    hostPort: 8080,
    containerPort: 8080,
    status: 'running' as const,
    healthy: true, // health gate below flips it if the image is broken
    startedAtMin: world.nowMin,
    serviceRef: service,
    logs: [`listening on :8080 (image ${image})`]
  };
  world.docker.containers.push(cont);
  void regImg; void localImg;
  const dep: Deployment = { id: 'dep-' + hashStr(image + world.nowMin).slice(0, 6), service, image, createdAtMin: world.nowMin, source, active: true };
  for (const d of world.ci.deployments) d.active = false;
  world.ci.deployments.push(dep);
  world.app = {
    version: image.split(':').pop() ?? 'latest',
    mode: 'container',
    image,
    database: world.flags.migrationsDone ? 'postgres' : 'sqlite',
    env,
    uptimeSinceMin: world.nowMin
  };
  world.audit.push({ t: world.nowMin, actor: source === 'ci' ? 'ci' : world.session.user, kind: 'deploy', text: `Deployed ${image} to ${service}` });
  return dep;
}

export function rollback(world: World, service: string): { ok: boolean; message: string } {
  const active = world.ci.deployments.find((d) => d.active && d.service === service);
  const previous = [...world.ci.deployments].filter((d) => d.service === service && d.id !== active?.id).pop();
  if (!previous) return { ok: false, message: 'no previous deployment to roll back to' };
  deployImage(world, previous.image, service, 'rollback');
  world.flags.badDeployBug = false;
  return { ok: true, message: `Rolled back ${service} to ${previous.image}` };
}

export { worktreeFiles };
