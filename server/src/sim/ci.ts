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
  p.strategy = typeof doc.strategy === 'string' ? doc.strategy : undefined;
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
  const run: CiRun = {
    id: 'run-' + hashStr(pipelinePath + world.nowMin + world.ci.runs.length).slice(0, 6),
    startedAtMin: world.nowMin,
    pipelinePath,
    commitSha: headSha,
    status: 'running',
    stages: []
  };
  world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Pipeline ${pipeline.name} started on ${headSha.slice(0, 7)}` });
  world.ci.runs.push(run);
  if (world.ci.runs.length > 30) world.ci.runs.splice(0, world.ci.runs.length - 25);

  processSteps(world, run, pipeline.steps, { repoPath, headSha, strategy: pipeline.strategy });
  return run;
}

/** Canary deploy: ship to 10% of traffic and watch before promoting. */
export function startCanary(world: World, image: string): void {
  world.ci.canary = { active: true, image, startedAtMin: world.nowMin, trafficPct: 10, errorPct: 0, status: 'running' };
  // an armed regression surfaces on the canary after a few minutes — a
  // runtime-only bug (m23) slips past staging e2e and only shows under traffic
  world.flags.canaryBugLive = Boolean(world.flags.nextDeployHasBug) || Boolean(world.flags.canaryRuntimeBug);
  world.flags.canaryConfigured = true;
  world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'deploy', text: `Canary live: ${image} at 10% of traffic — watching error rate for 30 sim minutes` });
}

/** Spin up an ephemeral preview environment for this run (P5b, m38). */
export function spawnPreview(world: World, run: CiRun, image: string): { ok: boolean; message: string } {
  if (!image) return { ok: false, message: 'no image to preview: build/push must run first' };
  const n = Number(world.flags.previewCounter ?? 0) + 1;
  world.flags.previewCounter = n;
  const id = `pr-${n}`;
  if (!world.ci.previews) world.ci.previews = [];
  const preview = {
    id,
    runId: run.id,
    image,
    url: `${id}.preview.${world.company.slug}.dev`,
    createdAtMin: world.nowMin,
    expiresAtMin: world.nowMin + 120
  };
  world.ci.previews.push(preview);
  if (world.ci.previews.length > 12) world.ci.previews.splice(0, world.ci.previews.length - 10);
  world.flags.previewConfigured = true;
  world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'deploy', text: `Preview environment up: ${preview.url} (${image}) — auto-destroys in 120 sim minutes` });
  return { ok: true, message: `preview ${id} live at ${preview.url}` };
}

/** Is a pipeline a preview-enabled pipeline (has a preview step)? */
export function hasPreviewStep(p: Pipeline): boolean {
  return p.steps.some((s) => /preview/i.test(s.name) || (s.uses ?? '').includes('preview') || /preview\s+(up|deploy)/.test(s.run ?? ''));
}

/** Approve or reject a run that is waiting on the production approval gate. */
export function approveRun(world: World, runId: string, approve: boolean): { ok: boolean; message: string } {
  const run = world.ci.runs.find((r) => r.id === runId);
  if (!run) return { ok: false, message: 'run not found' };
  if (run.status !== 'waiting_approval') return { ok: false, message: `run is ${run.status}, not waiting for approval` };
  const pending = run.pendingSteps ?? [];
  run.pendingSteps = [];
  const stage = run.stages[run.stages.length - 1];
  if (!approve) {
    if (stage) stage.log.push('Deployment rejected by reviewer — pipeline cancelled');
    run.status = 'rejected';
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'ci', text: `Production deploy REJECTED (run ${run.id})` });
    return { ok: true, message: 'run rejected — production was not touched' };
  }
  if (stage) stage.log.push(`Approved by ${world.session.user} at ${new Date().toISOString().slice(11, 16)} UTC`);
  world.flags.ciApprovalUsed = true;
  world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'ci', text: `Production deploy APPROVED (run ${run.id})` });
  const repo = findRepoFor(world, '/opt/app');
  const pipeline = loadPipeline(world, repo?.path ?? '/opt/app', run.pipelinePath);
  processSteps(world, run, pending, { repoPath: repo?.path ?? '/opt/app', headSha: run.commitSha, strategy: pipeline.strategy });
  return { ok: true, message: `approved — run ${run.id} continued` };
}

interface StepCtx { repoPath: string; headSha: string; strategy?: string }

/** Execute pipeline steps, appending stages to the run. Stops on failure or approval gate. */
function processSteps(world: World, run: CiRun, steps: PipelineStep[], ctx: StepCtx): void {
  const { repoPath, headSha } = ctx;
  run.status = 'running';
  let lastBuiltTag: string | null = null;
  let pushedTag: string | null = null;
  // remember what earlier stages of THIS run produced (resume case)
  for (const st of run.stages) {
    const m = /Built (\S+) /.exec(st.log.join('\n'));
    if (m) lastBuiltTag = m[1];
    const p = /pushed (\S+)/.exec(st.log.join('\n'));
    if (p) pushedTag = p[1];
  }

  const finish = (status: 'success' | 'failed') => {
    run.status = status;
    world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Pipeline ${status === 'success' ? 'succeeded' : 'failed'} (${run.pipelinePath})` });
  };

  /** On failure the remaining steps show up as skipped, like a real runner. */
  const failRemaining = (fromIdx: number) => {
    for (const s of steps.slice(fromIdx + 1)) run.stages.push({ name: s.name, status: 'skipped', log: [] });
  };

  for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
    const step = steps[stepIdx];
    const stage: CiRun['stages'][number] = { name: step.name, status: 'success', log: [] };
    run.stages.push(stage);
    const log = stage.log;
    const isStagingDeploy = (/staging/i.test(step.name) || /staging/i.test(step.run ?? '') || (step.uses ?? '').includes('deploy-staging')) && /deploy/i.test(step.name + (step.uses ?? '') + (step.run ?? ''));
    const isE2e = /e2e|end-to-end|end.to.end/i.test(step.name) || /e2e|end-to-end/.test(step.run ?? '');
    const isApproval = (step.uses ?? '').includes('approval');
    const isPreview = /preview/i.test(step.name) || (step.uses ?? '').includes('preview') || /preview\s+(up|deploy)/.test(step.run ?? '');
    const isSign = /^cosign\s+sign/.test(step.run ?? '') || (/sign/.test(step.name) && /cosign/.test(step.run ?? ''));
    const isSbom = /cosign\s+attest/.test(step.run ?? '') || (/sbom/i.test(step.name) && /cosign|attest/.test(step.run ?? ''));

    if ((step.uses ?? '').includes('checkout')) {
      log.push(`HEAD is now at ${headSha.slice(0, 7)}`);
      log.push(`Checked out ${repoPath}`);
    } else if (isApproval) {
      log.push('⏸ Waiting for production approval…');
      log.push('This pipeline ships to PRODUCTION only after a human approves.');
      run.status = 'waiting_approval';
      run.pendingSteps = steps.slice(steps.indexOf(step) + 1);
      run.image = pushedTag ?? lastBuiltTag ?? undefined;
      world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Pipeline paused: production approval required (run ${run.id})` });
      return;
    } else if (isStagingDeploy) {
      const image = pushedTag ?? lastBuiltTag;
      if (!image) { log.push('no image to deploy to staging: build/push must run first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      if (!world.ci.staging) world.ci.staging = { image: null, deployedAtMin: 0, e2ePassed: false, e2eLog: [] };
      world.ci.staging.image = image;
      world.ci.staging.deployedAtMin = world.nowMin;
      world.ci.staging.e2ePassed = false;
      log.push(`Deploying ${image} to staging (staging.acme.internal)…`);
      log.push('Staging container healthy after 4.1s');
      world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: `Deployed ${image} to STAGING` });
    } else if (isPreview) {
      // ephemeral preview environment per run (P5b, m38)
      const image = pushedTag ?? lastBuiltTag;
      if (!image) { log.push('no image to preview: build/push must run first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      const r = spawnPreview(world, run, image);
      log.push(r.message);
      log.push(`Preview URL: ${world.ci.previews?.at(-1)?.url} (destroys itself in 120 sim minutes)`);
    } else if (isSign) {
      // supply chain (P5a, m35): sign what this pipeline just pushed
      const tag = pushedTag ?? lastBuiltTag;
      if (!tag) { log.push('no image to sign: build/push must run first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      const img = world.registry.find((i) => i.repoTags.includes(tag)) ?? world.docker.images.find((i) => i.repoTags.includes(tag));
      if (!img) { log.push(`image ${tag} not found`); stage.status = 'failed'; failRemaining(stepIdx); break; }
      img.signed = true;
      log.push(`Signing [${tag}] — keyless, transparency log entry created`);
      world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'security', text: `CI signed image ${tag} (cosign, keyless)` });
    } else if (isSbom) {
      const tag = pushedTag ?? lastBuiltTag;
      if (!tag) { log.push('no image to attest: build/push must run first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      const img = world.registry.find((i) => i.repoTags.includes(tag)) ?? world.docker.images.find((i) => i.repoTags.includes(tag));
      if (!img) { log.push(`image ${tag} not found`); stage.status = 'failed'; failRemaining(stepIdx); break; }
      if (!img.signed) { log.push(`${tag} is not signed — attest requires a signature first`); stage.status = 'failed'; failRemaining(stepIdx); break; }
      img.sbom = true;
      log.push(`SBOM attestation attached to ${tag} (SPDX, 148 packages)`);
      world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'security', text: `CI attached SBOM attestation to ${tag}` });
    } else if (isE2e) {
      const staging = world.ci.staging;
      if (!staging?.image) { log.push('e2e needs a staging deploy step first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      log.push('> playwright test --config e2e/staging.config.ts');
      log.push('');
      if (world.flags.nextDeployHasBug) {
        // regression caught in staging: production is never touched
        stage.status = 'failed';
        world.flags.nextDeployHasBug = false;
        world.flags.stagingCaughtBug = true;
        world.flags.stagingCaughtAtMin = world.nowMin;
        world.flags.stagingCaughtDeployId = world.ci.deployments.find((d) => d.active)?.id ?? '';
        log.push('  1) [chromium] › orders › shows the order history  …  FAILED');
        log.push('     Error: expect(received).toHaveLength(48213) — received 0');
        log.push('');
        log.push('  1 failed, 22 passed (14.8s)');
        log.push('PRODUCTION WAS NOT TOUCHED. The regression was caught in staging.');
        staging.e2eLog = [...log];
        world.audit.push({ t: world.nowMin, actor: 'ci', kind: 'ci', text: 'E2E in staging CAUGHT a regression — production deploy blocked' });
        failRemaining(stepIdx);
        break;
      }
      log.push('  23 passed (12.4s)');
      log.push('staging verified end-to-end');
      staging.e2ePassed = true;
      staging.e2eLog = [...log];
    } else if (/npm\s+test/.test(step.run ?? '')) {
      log.push('> api@1.0.0 test');
      log.push('> vitest run');
      log.push('');
      log.push(' 48 passing (3.1s)');
      if (world.flags.badCodeSeeded) {
        log.push(' 1 failing: orders endpoint returns 500 under load');
        stage.status = 'failed';
        failRemaining(stepIdx);
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
      if (!res.ok) { stage.status = 'failed'; failRemaining(stepIdx); break; }
      log.push(`Built ${tag} (${res.image?.sizeMB}MB)`);
      lastBuiltTag = tag;
    } else if (/^docker\s+push/.test(step.run ?? '') || (/push/.test(step.name) && !/push/i.test(step.uses ?? 'x'))) {
      const tag = lastBuiltTag ?? /docker\s+push\s+(\S+)/.exec(step.run ?? '')?.[1] ?? null;
      if (!tag) { log.push('no image to push: build step must run first'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      log.push(...pushToRegistry(world, tag).map((l) => l.text));
      log.push(`pushed ${tag}`);
      pushedTag = tag;
    } else if (/deploy/i.test(step.name) || /deploy/i.test(step.run ?? '') || (step.uses ?? '').includes('deploy')) {
      const image = step.with?.image ?? pushedTag ?? lastBuiltTag;
      if (!image) { log.push('no image available to deploy'); stage.status = 'failed'; failRemaining(stepIdx); break; }
      const strategy = String(step.with?.strategy ?? ctx.strategy ?? 'rolling').toLowerCase();
      if (strategy === 'canary') {
        // progressive delivery: 10% fleet first, promote from the observation window
        startCanary(world, image);
        log.push(`Canary deploy: ${image} to 10% of traffic`);
        log.push('Observing for 30 sim minutes — auto-abort on error spike, auto-promote when clean');
      } else {
        if (strategy === 'blue-green') {
          // instant traffic switch, previous release kept warm for rollback
          world.ci.blueGreen = { activeImage: image, warmImage: world.app.image ?? image };
          world.flags.blueGreenUsed = true;
          log.push(`Blue/green switch: green (${image}) live, blue (${world.ci.blueGreen.warmImage}) kept warm`);
        }
        const d = deployImage(world, image as string, 'api', 'ci');
        log.push(`Deploying ${image} …`);
        log.push(`Container ${d ? 'replaced' : 'created'} for service api`);
        log.push('Health check passed after 3.2s');
        if (world.flags.nextDeployHasBug && !world.flags.badDeployBug) {
          world.flags.badDeployBug = true;
          world.flags.nextDeployHasBug = false;
          if ((world.flags.m17BugPending && !world.flags.stagingCaughtBug)
            || (world.flags.canaryBugPending && !world.flags.canaryAutoAbort)) {
            // QA's regression re-plants itself in the next release until the pipeline catches it
            world.flags.nextDeployHasBug = true;
          }
          log.push('Deployment accepted; watch error rate closely');
        }
      }
    } else if (step.run) {
      log.push(`$ ${step.run}`);
      log.push('done');
    }
  }

  // a failed stage ends the run (remaining steps were appended as skipped)
  if (run.status === 'running' && run.stages.some((s) => s.status === 'failed')) {
    finish('failed');
  } else if (run.status === 'running') {
    finish('success');
  }
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
