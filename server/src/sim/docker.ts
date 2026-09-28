// Docker simulation: Dockerfile parser + layered builder + container runtime
// + registry. Image sizes use a plausible base-image table so "optimize your
// base image" is a real tradeoff.
import { World, DockerImage, DockerContainer, OutLine } from '../types';
import { getFile, readFile, resolvePath } from './fs';

export const BASE_SIZES: Record<string, number> = {
  'node:20': 380,
  'node:20-slim': 75,
  'node:20-alpine': 50,
  'node:22-alpine': 52,
  'alpine:3.19': 7,
  'nginx:alpine': 22,
  'ubuntu:22.04': 77,
  'debian:bookworm-slim': 74,
  'postgres:16': 130
};

export interface ParsedStage {
  from: string;
  as?: string;
  workdir?: string;
  user?: string;
  env: Record<string, string>;
  expose: number[];
  run: string[];
  copies: { src: string; dest: string; fromStage?: string }[];
  healthcheck?: { test: string };
  cmd?: string[];
  entrypoint?: string[];
}

export interface ParsedDockerfile {
  stages: ParsedStage[];
  final: ParsedStage | null;
  problems: string[];
  multiStage: boolean;
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const problems: string[] = [];
  const stages: ParsedStage[] = [];
  let cur: ParsedStage | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    // continuation lines
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + ' ' + lines[++i].trim();
    }
    const sp = line.indexOf(' ');
    const instr = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
    switch (instr) {
      case 'FROM': {
        const parts = rest.split(/\s+AS\s+/i);
        cur = { from: parts[0].trim(), as: parts[1]?.trim(), env: {}, expose: [], run: [], copies: [] };
        stages.push(cur);
        break;
      }
      case 'WORKDIR': if (cur) cur.workdir = rest; break;
      case 'USER': if (cur) cur.user = rest; break;
      case 'ENV': {
        if (!cur) break;
        const m = /^(\w+)=?(.*)$/.exec(rest.replace(/^(\w+)\s+/, '$1='));
        if (rest.includes('=')) {
          for (const kv of rest.matchAll(/(\w+)=("[^"]*"|'[^']*'|\S+)/g)) cur.env[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
        } else if (m) cur.env[m[1]] = m[2];
        break;
      }
      case 'EXPOSE': if (cur) for (const p of rest.split(/\s+/)) { const n = parseInt(p, 10); if (!isNaN(n)) cur.expose.push(n); } break;
      case 'RUN': if (cur) cur.run.push(rest); break;
      case 'COPY':
      case 'ADD': {
        if (!cur) break;
        const parts = rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
        const fromStage = (rest.match(/--from=(\S+)/) ?? [])[1];
        const clean = parts.filter((p) => !p.startsWith('--'));
        if (clean.length >= 2) cur.copies.push({ src: clean[0], dest: clean[clean.length - 1], fromStage });
        break;
      }
      case 'HEALTHCHECK': {
        if (!cur) break;
        const m = /CMD(\s+SHELL)?\s+(.*)/.exec(rest);
        cur.healthcheck = { test: m ? m[2] : rest };
        break;
      }
      case 'CMD': if (cur) cur.cmd = parseExec(rest); break;
      case 'ENTRYPOINT': if (cur) cur.entrypoint = parseExec(rest); break;
      case 'ARG': break;
      default:
        problems.push(`unknown instruction "${instr}" (line ${i + 1})`);
    }
  }
  if (!stages.length) problems.push('no FROM instruction found');
  const final = stages.length ? stages[stages.length - 1] : null;
  return { stages, final, problems, multiStage: stages.length > 1 };
}

function parseExec(rest: string): string[] {
  if (rest.startsWith('[')) {
    try { return JSON.parse(rest); } catch { return rest.replace(/[\[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')); }
  }
  return rest.split(' ');
}

export interface BuildResult {
  ok: boolean;
  lines: OutLine[];
  image?: DockerImage;
}

export function buildImage(world: World, tag: string, dockerfilePath: string): BuildResult {
  const host = world.hosts['web-01'];
  const f = getFile(host.fs, dockerfilePath);
  const lines: OutLine[] = [];
  if (!f) return { ok: false, lines: [{ text: `unable to prepare context: unable to evaluate symlinks in context path: no such file or directory: ${dockerfilePath}`, cls: 'err' }] };
  const parsed = parseDockerfile(f.content);
  for (const p of parsed.problems) lines.push({ text: `ERROR: ${p}`, cls: 'err' });
  if (!parsed.final) return { ok: false, lines };
  const stage = parsed.final;

  const baseKey = Object.keys(BASE_SIZES).find((k) => stage.from === k) ?? stage.from;
  const baseSize = BASE_SIZES[stage.from] ?? 100;
  const steps: { cmd: string; sizeMB: number }[] = [];
  steps.push({ cmd: `FROM ${stage.from}`, sizeMB: baseSize });

  let depSize = 0;
  for (const r of stage.run) {
    let size = 0.1;
    if (/npm\s+(ci|install)/.test(r)) size = /--production|--omit=dev/.test(r) ? 120 : 310;
    if (/apt-get?\s+install/.test(r)) size = 25 + (r.length % 3) * 10;
    if (/curl|wget/.test(r) && !/rm/.test(r)) size += 3;
    depSize += size;
    steps.push({ cmd: `RUN ${r}`, sizeMB: size });
  }
  for (const c of stage.copies) {
    let size = 1.2;
    if (c.dest.endsWith('node_modules') || c.src.includes('node_modules')) size = depSize || 120;
    steps.push({ cmd: `COPY ${c.src} ${c.dest}`, sizeMB: size });
  }
  const sizeMB = steps.reduce((a, s) => a + s.sizeMB, 0);

  lines.push({ text: `[+] Building 2.4s (${steps.length}/${steps.length}) FINISHED`, cls: 'hdr' });
  let idx = 1;
  for (const s of steps) {
    lines.push({ text: ` => [${idx}/${steps.length}] ${s.cmd}`, cls: 'dim' });
    idx++;
  }
  lines.push({ text: ` => => naming to ${tag}`, cls: 'dim' });

  const warnings: string[] = [];
  if (!stage.user || stage.user === 'root' || stage.user.startsWith('root')) warnings.push('To avoid running as root, add a USER directive');
  if (!stage.expose.length) warnings.push('No EXPOSE directive: the container port will not be documented');
  if (!stage.healthcheck) warnings.push('No HEALTHCHECK defined: orchestrators cannot detect a hung process');
  for (const w of warnings) lines.push({ text: `WARNING: ${w}`, cls: 'warn' });

  const image: DockerImage = {
    id: 'sha256:' + hashStr(f.content + tag).slice(0, 12),
    repoTags: [tag],
    sizeMB: Math.round(sizeMB * 10) / 10,
    baseImage: baseKey,
    user: stage.user,
    ports: stage.expose,
    env: { ...stage.env },
    healthcheck: stage.healthcheck,
    workdir: stage.workdir ?? '/',
    cmd: stage.cmd,
    layers: steps.map((s) => ({ cmd: s.cmd, sizeMB: s.sizeMB, cached: false })),
    multiStage: parsed.multiStage
  };
  // replace existing identical tag
  world.docker.images = world.docker.images.filter((i) => !i.repoTags.includes(tag));
  world.docker.images.push(image);
  return { ok: true, lines, image };
}

export function runContainer(world: World, args: string[]): { lines: OutLine[]; container?: DockerContainer } {
  const lines: OutLine[] = [];
  let image = '';
  let name = '';
  let hostPort: number | undefined;
  let containerPort: number | undefined;
  const env: Record<string, string> = {};
  let detach = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--detach') detach = true;
    else if (a === '--name') name = args[++i] ?? '';
    else if (a === '-p' || a === '--publish') {
      const m = /^(\d+):(\d+)$/.exec(args[++i] ?? '');
      if (m) { hostPort = parseInt(m[1], 10); containerPort = parseInt(m[2], 10); }
    } else if (a === '-e' || a === '--env') {
      const kv = args[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--env-file') {
      const content = readFile(world.hosts['web-01'].fs, resolvePath(world.session.cwd, args[++i] ?? '.env')) ?? '';
      for (const l of content.split('\n')) {
        const mm = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/.exec(l);
        if (mm && !mm[1].startsWith('#')) env[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
      }
    } else if (!a.startsWith('-')) { image = a; }
  }
  if (!image) return { lines: [{ text: 'docker: image name required', cls: 'err' }] };
  const img = [...world.docker.images, ...world.registry].find((i) => i.repoTags.includes(image));
  if (!img) {
    return { lines: [{ text: `docker: Unable to find image '${image}' locally`, cls: 'err' }, { text: `docker: Error response from daemon: pull access denied for ${image}, run 'docker login' or 'docker pull ${image}' first`, cls: 'err' }] };
  }
  if (hostPort !== undefined) {
    const portTaken =
      Object.values(world.hosts['web-01'].services).some((s) => s.state === 'active' && s.port === hostPort) ||
      world.docker.containers.some((c) => c.status === 'running' && c.hostPort === hostPort) ||
      world.hosts['web-01'].processes.some((p) => p.port === hostPort && p.state !== 'zombie');
    if (portTaken) {
      return { lines: [{ text: `docker: Error response from daemon: driver failed programming external connectivity on endpoint: Bind for 0.0.0.0:${hostPort} failed: port is already allocated`, cls: 'err' }] };
    }
  }
  const cont: DockerContainer = {
    id: hashStr(name + image + world.nowMin).slice(0, 12),
    name: name || 'eager_' + hashStr(image + world.nowMin).toLowerCase().slice(0, 6),
    image,
    env,
    hostPort,
    containerPort,
    status: 'running',
    healthy: false,
    startedAtMin: world.nowMin,
    logs: [],
    hostId: world.session.hostId === 'laptop' ? 'web-01' : world.session.hostId
  };
  world.docker.containers.push(cont);
  // a container bound to the app port becomes the live app runtime
  if (cont.hostPort === 8080 || cont.containerPort === 8080) {
    world.app = {
      version: image.includes(':') ? image.split(':').pop()! : 'latest',
      mode: 'container',
      image,
      database: world.flags.migrationsDone ? 'postgres' : 'sqlite',
      env,
      uptimeSinceMin: world.nowMin
    };
  }
  lines.push({ text: cont.id });
  lines.push({ text: `Container ${cont.name} started (${img.repoTags[0]})`, cls: 'dim' });
  if (img.user && img.user !== 'root') lines.push({ text: `Running as non-root user: ${img.user}`, cls: 'ok' });
  else lines.push({ text: `Process runs as root inside the container`, cls: 'warn' });
  return { lines, container: cont };
}

export function pushToRegistry(world: World, tag: string): OutLine[] {
  const img = world.docker.images.find((i) => i.repoTags.includes(tag));
  if (!img) return [{ text: `The push refers to repository [${tag}]`, cls: 'dim' }, { text: `An image does not exist locally with the tag: ${tag}`, cls: 'err' }];
  const regImg: DockerImage = { ...img, repoTags: [tag], layers: img.layers.map((l) => ({ ...l })) };
  world.registry = world.registry.filter((i) => !i.repoTags.includes(tag));
  world.registry.push(regImg);
  return [
    { text: `The push refers to repository [${tag}]`, cls: 'dim' },
    { text: `${img.id.slice(7, 19)}: Pushed `, cls: 'dim' },
    { text: `latest: digest: sha256:${hashStr(tag).slice(0, 24)} size: ${Math.round(img.sizeMB * 1024)}kB`, cls: 'ok' }
  ];
}

export function hashStr(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 1), 2654435761) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
