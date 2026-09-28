// SimHost: the simulated Linux machine and its command set. Every command a
// player runs is executed against the virtual world ONLY — nothing here
// touches the real host OS (spec §47).
import { World, OutLine, SimHost, SimProcess, GitCommit } from '../types';
import * as fs from './fs';
import { parseLine, Pipeline, splitLogical } from './shell';
import { httpRequest, formatCurl, digLookup, resolveHostname } from './net';
import { getRepo, findRepoFor, initRepo, status as gitStatus, makeCommit, mergeBranch, completeMergeCommit, logLines, worktreeFiles, resolveRef, treeDiff, isAncestor, GITIGNORE_DEFAULT } from './git';
import { buildImage, runContainer, pushToRegistry, parseDockerfile, hashStr } from './docker';
import { runSql } from './dbsim';

export interface CmdOut { lines: OutLine[]; code: number }

const L = (text: string, cls?: OutLine['cls']): OutLine => ({ text, cls });

// ---------------- host factory ----------------
export function makeHost(id: string, label: string, ip: string, os: string): SimHost {
  return {
    id, label, ip, os,
    fs: fs.newDir(0o755, 'root'),
    processes: [],
    nextPid: 800,
    services: {},
    users: {},
    packages: [],
    diskTotalMB: 40 * 1024,
    diskUsedBaseMB: 0
  };
}

export function addProcess(host: SimHost, cmd: string, user: string, port?: number, service?: string, state: SimProcess['state'] = 'sleeping'): SimProcess {
  const p: SimProcess = { pid: host.nextPid++, cmd, user, cpuPct: 0.3, memMB: 45, port, state, service, startedAtMin: 0 };
  host.processes.push(p);
  return p;
}

// ---------------- main entry ----------------
export function runTerminalInput(world: World, input: string): CmdOut {
  const session = world.session;
  const trimmed = input.trim();
  if (!trimmed) return { lines: [], code: 0 };

  // pending ssh password
  if (session.pending) {
    const pend = session.pending;
    session.pending = null;
    if (trimmed.length === 0) {
      return { lines: [L('Permission denied (publickey,password).', 'err'), L('')], code: 255 };
    }
    session.hostId = pend.hostId;
    session.user = pend.user;
    session.cwd = `/home/${pend.user}`;
    session.env = { ...session.env, HOME: `/home/${pend.user}`, USER: pend.user };
    world.audit.push({ t: world.nowMin, actor: pend.user, kind: 'ssh', text: `SSH session established on ${pend.hostId}` });
    return {
      lines: [
        L(`Welcome to ${world.hosts[pend.hostId].os} (${pend.hostId})`, 'dim'),
        L(`Last login: day ${Math.floor(world.nowMin / 1440) + 1}`, 'dim'),
        L(''),
        L('  System load is fine. Packages may be out of date.', 'dim'),
        L('')
      ],
      code: 0
    };
  }

  const segments = splitLogical(trimmed);
  const allLines: OutLine[] = [];
  let code = 0;
  let ran = false;
  for (const seg of segments) {
    if (ran && seg.join === '&&' && code !== 0) continue;
    if (ran && seg.join === '||' && code === 0) continue;
    ran = true;
    const parsed = parseLine(seg.text, session.env);
    for (const pipeline of parsed.pipelines) {
      const res = execPipeline(world, pipeline, parsed.envPre);
      allLines.push(...res.lines);
      code = res.code;
      if (code !== 0 && world.flags.setE) break;
    }
  }
  session.env.PREV_EXIT = String(code);
  return { lines: allLines, code };
}

function execPipeline(world: World, pipeline: Pipeline, envPre: Record<string, string>): CmdOut {
  let stdin: string | null = null;
  let lines: OutLine[] = [];
  let code = 0;
  const lastIdx = pipeline.cmds.length - 1;
  for (let ci = 0; ci < pipeline.cmds.length; ci++) {
    const cmd = pipeline.cmds[ci];
    let argv = cmd.argv.map((a) => a);
    if (!argv.length) continue;
    const env = { ...world.session.env, ...envPre };
    const isSudo = argv[0] === 'sudo';
    if (isSudo) {
      argv = argv.slice(1);
      if (!argv.length) { return { lines: [L('usage: sudo <command>', 'err')], code: 1 }; }
    }
    const host = world.hosts[world.session.hostId] ?? world.hosts['web-01'];
    const handler = COMMANDS[argv[0]];
    if (!handler) {
      const res: CmdOut = { lines: [L(`${argv[0]}: command not found`, 'err')], code: 127 };
      code = res.code;
      if (ci === lastIdx) lines = lines.concat(applyRedirects(world, cmd, res, stdin).lines);
      continue;
    }
    if (isSudo && !host.users[world.session.user]?.sudo && world.session.hostId !== 'laptop') {
      const res: CmdOut = { lines: [L(`${world.session.user} is not in the sudoers file. This incident will be reported.`, 'err')], code: 1 };
      code = res.code;
      if (ci === lastIdx) lines = lines.concat(applyRedirects(world, cmd, res, stdin).lines);
      continue;
    }
    let out: CmdOut;
    try {
      out = handler(world, host, argv, stdin, isSudo, env);
    } catch (e) {
      out = { lines: [L(`${argv[0]}: internal sim error: ${String((e as Error).message ?? e)}`, 'err')], code: 1 };
    }
    code = out.code;
    // only the final command of a pipeline writes to the terminal
    if (ci === lastIdx) lines = lines.concat(applyRedirects(world, cmd, out, stdin).lines);
    stdin = out.lines.map((l) => l.text).join('\n');
  }
  return { lines, code };
}

function applyRedirects(world: World, cmd: { stdoutFile?: string; append?: boolean; stderrFile?: string }, out: CmdOut, stdin: string | null): CmdOut {
  if (cmd.stderrFile) {
    fs.writeFile(world.hosts[world.session.hostId].fs, fs.resolvePath(world.session.cwd, cmd.stderrFile), out.lines.filter((l) => l.cls === 'err').map((l) => l.text).join('\n'), world.session.user);
  }
  if (cmd.stdoutFile) {
    const path = fs.resolvePath(world.session.cwd, cmd.stdoutFile);
    const content = out.lines.map((l) => l.text).join('\n');
    if (cmd.append) {
      const prev = fs.readFile(world.hosts[world.session.hostId].fs, path) ?? '';
      fs.writeFile(world.hosts[world.session.hostId].fs, path, prev + (prev ? '\n' : '') + content, world.session.user);
    } else {
      fs.writeFile(world.hosts[world.session.hostId].fs, path, content, world.session.user);
    }
    return { lines: [], code: out.code };
  }
  return out;
}

type Handler = (world: World, host: SimHost, argv: string[], stdin: string | null, sudo: boolean, env: Record<string, string>) => CmdOut;

function flag(argv: string[], names: string[]): boolean { return argv.some((a) => names.includes(a)); }
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------------- file commands ----------------
const COMMANDS: Record<string, Handler> = {
  ls: (w, h, argv) => {
    const showAll = flag(argv, ['-a', '-la', '-al']);
    const long = flag(argv, ['-l', '-la', '-al']);
    const target = argv.filter((a) => !a.startsWith('-'))[1];
    const path = fs.resolvePath(w.session.cwd, target ?? '.');
    const node = fs.getNode(h.fs, path);
    if (!node) return { lines: [L(`ls: cannot access '${target ?? path}': No such file or directory`, 'err')], code: 2 };
    if (node.type === 'file') return { lines: [L(target ?? path)], code: 0 };
    const entries = fs.listDir(h.fs, path) ?? [];
    const visible = entries.filter((e) => showAll || !e.name.startsWith('.'));
    if (long) {
      const lines = [L(`total ${visible.length * 4}`, 'dim')];
      for (const { name, node: n } of visible) {
        const sizeKB = Math.max(4, Math.round(fs.nodeSizeMB(n) * 1024));
        lines.push(L(`${fs.modeString(n)} ${n.type === 'dir' ? 2 : 1} ${n.owner} ${n.owner} ${String(sizeKB).padStart(6)} ${name}${n.type === 'dir' ? '/' : ''}`));
      }
      return { lines, code: 0 };
    }
    const names = visible.map((e) => (e.node.type === 'dir' ? e.name + '/' : e.name));
    return { lines: [L(names.join('   ') || '(empty)')], code: 0 };
  },

  cd: (w, h, argv) => {
    let target = argv[1] ?? env(w).HOME ?? '/root';
    if (target === '~') target = env(w).HOME ?? '/root';
    else if (target.startsWith('~/')) target = (env(w).HOME ?? '/root') + target.slice(1);
    const path = fs.resolvePath(w.session.cwd, target);
    const d = fs.getDir(h.fs, path);
    if (!d) return { lines: [L(`cd: ${target}: No such file or directory`, 'err')], code: 1 };
    w.session.cwd = path;
    return { lines: [], code: 0 };
  },

  pwd: (w) => ({ lines: [L(w.session.cwd)], code: 0 }),

  cat: (w, h, argv, stdin) => {
    const paths = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (!paths.length && stdin !== null) return { lines: stdin.split('\n').map((t) => L(t)), code: 0 };
    const lines: OutLine[] = [];
    for (const p of paths) {
      const f = fs.getFile(h.fs, fs.resolvePath(w.session.cwd, p));
      if (!f) { lines.push(L(`cat: ${p}: No such file or directory`, 'err')); continue; }
      if (f.type !== 'file') { lines.push(L(`cat: ${p}: Is a directory`, 'err')); continue; }
      const content = f.content.length > 60000 ? f.content.slice(-60000) : f.content;
      for (const t of content.split('\n')) lines.push(L(t));
      if (p === 'handoff.txt' || p.endsWith('/handoff.txt')) w.flags.readHandoff = true;
    }
    return { lines, code: lines.some((l) => l.cls === 'err') ? 1 : 0 };
  },

  head: (w, h, argv, stdin) => {
    const n = parseInt(flagValue(argv, '-n') ?? '10', 10);
    const paths = argv.filter((a) => !a.startsWith('-') && a !== argv[0] && a !== String(n));
    const src = paths.length ? (fs.getFile(h.fs, fs.resolvePath(w.session.cwd, paths[0]))?.content ?? null) : stdin;
    if (src === null) return { lines: [L(`head: cannot open '${paths[0] ?? ''}'`, 'err')], code: 1 };
    return { lines: src.split('\n').slice(0, n).map((t) => L(t)), code: 0 };
  },

  tail: (w, h, argv, stdin) => {
    const n = parseInt(flagValue(argv, '-n') ?? '10', 10);
    const paths = argv.filter((a) => !a.startsWith('-') && a !== argv[0] && a !== String(n));
    const src = paths.length ? (fs.getFile(h.fs, fs.resolvePath(w.session.cwd, paths[0]))?.content ?? null) : stdin;
    if (src === null) return { lines: [L(`tail: cannot open '${paths[0] ?? ''}'`, 'err')], code: 1 };
    return { lines: src.split('\n').slice(-n).map((t) => L(t)), code: 0 };
  },

  grep: (w, h, argv, stdin) => {
    const showN = flag(argv, ['-n']);
    const ignoreCase = flag(argv, ['-i']);
    const invert = flag(argv, ['-v']);
    const count = flag(argv, ['-c']);
    const rest = argv.filter((a) => !a.startsWith('-') && a !== 'grep');
    const pattern = rest[0];
    if (!pattern) return { lines: [L('usage: grep [-i] [-n] [-v] PATTERN [FILE…]', 'err')], code: 2 };
    const re = new RegExp(pattern, ignoreCase ? 'i' : '');
    const sources: { name: string; text: string }[] = [];
    const paths = rest.slice(1);
    if (paths.length) {
      for (const p of paths) {
        const content = fs.readFile(h.fs, fs.resolvePath(w.session.cwd, p));
        if (content === null) { continue; }
        sources.push({ name: p, text: content });
      }
    } else if (stdin !== null) sources.push({ name: '', text: stdin });
    const lines: OutLine[] = [];
    let matched = 0;
    for (const src of sources) {
      src.text.split('\n').forEach((line, i) => {
        const hit = re.test(line);
        if (hit !== invert) {
          matched++;
          const prefix = showN ? `${i + 1}:` : '';
          const namePrefix = sources.length > 1 ? `${src.name}:` : '';
          lines.push(L(`${namePrefix}${prefix}${line}`));
        }
      });
    }
    if (count) return { lines: [L(String(matched))], code: matched ? 0 : 1 };
    return { lines, code: matched ? 0 : 1 };
  },

  echo: (w, _h, argv) => ({ lines: [L(argv.slice(1).join(' '))], code: 0 }),

  touch: (w, h, argv) => {
    for (const p of argv.slice(1)) {
      const path = fs.resolvePath(w.session.cwd, p);
      if (!fs.getFile(h.fs, path)) fs.writeFile(h.fs, path, '', w.session.user);
    }
    return { lines: [], code: 0 };
  },

  mkdir: (w, h, argv) => {
    const p = flag(argv, ['-p']);
    for (const t of argv.slice(1).filter((a) => !a.startsWith('-'))) {
      const path = fs.resolvePath(w.session.cwd, t);
      if (p) fs.ensureDir(h.fs, path, w.session.user);
      else {
        if (fs.getNode(h.fs, path)) return { lines: [L(`mkdir: cannot create directory '${t}': File exists`, 'err')], code: 1 };
        fs.ensureDir(h.fs, path, w.session.user);
      }
    }
    return { lines: [], code: 0 };
  },

  rm: (w, h, argv) => {
    const rec = flag(argv, ['-r', '-rf', '-fr', '-R']);
    const force = flag(argv, ['-f', '-rf', '-fr']);
    const targets = argv.slice(1).filter((a) => !a.startsWith('-'));
    const lines: OutLine[] = [];
    let code = 0;
    for (const t of targets) {
      const path = fs.resolvePath(w.session.cwd, t);
      const node = fs.getNode(h.fs, path);
      if (!node) {
        if (!force) { lines.push(L(`rm: cannot remove '${t}': No such file or directory`, 'err')); code = 1; }
        continue;
      }
      if (node.type === 'dir' && !rec && Object.keys(node.children).length) {
        lines.push(L(`rm: cannot remove '${t}': Is a directory`, 'err')); code = 1; continue;
      }
      const res = fs.rmNode(h.fs, path);
      if (!res.ok && !force) { lines.push(L(`rm: ${res.error}`, 'err')); code = 1; }
    }
    return { lines, code };
  },

  mv: (w, h, argv) => {
    const [from, to] = argv.slice(1);
    if (!from || !to) return { lines: [L('usage: mv SRC DST', 'err')], code: 1 };
    const srcPath = fs.resolvePath(w.session.cwd, from);
    const node = fs.getNode(h.fs, srcPath);
    if (!node) return { lines: [L(`mv: cannot stat '${from}': No such file or directory`, 'err')], code: 1 };
    let dstPath = fs.resolvePath(w.session.cwd, to);
    if (fs.getDir(h.fs, dstPath)) dstPath = dstPath.replace(/\/$/, '') + '/' + srcPath.split('/').pop();
    const res = fs.rmNode(h.fs, srcPath);
    if (!res.ok) return { lines: [L(`mv: ${res.error}`, 'err')], code: 1 };
    if (node.type === 'file') fs.writeFile(h.fs, dstPath, node.content, node.owner, node.mode);
    else {
      const d = fs.ensureDir(h.fs, dstPath, node.owner)!;
      d.children = node.children;
    }
    return { lines: [], code: 0 };
  },

  cp: (w, h, argv) => {
    const [from, to] = argv.slice(1);
    if (!from || !to) return { lines: [L('usage: cp SRC DST', 'err')], code: 1 };
    const f = fs.getFile(h.fs, fs.resolvePath(w.session.cwd, from));
    if (!f) return { lines: [L(`cp: cannot stat '${from}'`, 'err')], code: 1 };
    const dstPath = fs.getDir(h.fs, fs.resolvePath(w.session.cwd, to))
      ? fs.resolvePath(w.session.cwd, to).replace(/\/$/, '') + '/' + from.split('/').pop()
      : fs.resolvePath(w.session.cwd, to);
    fs.writeFile(h.fs, dstPath, f.content, w.session.user, f.mode);
    return { lines: [], code: 0 };
  },

  find: (w, h, argv) => {
    const nameIdx = argv.indexOf('-name');
    const pattern = nameIdx >= 0 ? argv[nameIdx + 1] : null;
    const base = fs.resolvePath(w.session.cwd, argv[1] && !argv[1].startsWith('-') ? argv[1] : '.');
    const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const lines: OutLine[] = [];
    const walk = (path: string) => {
      const node = fs.getNode(h.fs, path);
      if (!node) return;
      if (!re || re.test(path.split('/').pop() ?? '')) lines.push(L(path));
      if (node.type === 'dir') for (const name of Object.keys(node.children)) walk(path === '/' ? `/${name}` : `${path}/${name}`);
    };
    walk(base);
    return { lines, code: 0 };
  },

  du: (w, h, argv) => {
    const target = fs.resolvePath(w.session.cwd, argv.filter((a) => !a.startsWith('-'))[1] ?? '.');
    const node = fs.getNode(h.fs, target);
    if (!node) return { lines: [L(`du: cannot access '${target}'`, 'err')], code: 1 };
    const mb = fs.nodeSizeMB(node);
    return { lines: [L(`${humanSize(mb)}\t${target}`)], code: 0 };
  },

  df: (w) => {
    const used = w.hosts['web-01'].diskUsedBaseMB + logVolumeMb(w);
    const total = w.hosts['web-01'].diskTotalMB;
    const pct = Math.min(100, (used / total) * 100);
    return {
      lines: [
        L('Filesystem      Size  Used Avail Use% Mounted on', 'hdr'),
        L(`/dev/vda1       ${humanSize(total)}  ${humanSize(used)}  ${humanSize(total - used)}  ${Math.round(pct)}% /`)
      ],
      code: 0
    };
  },

  chmod: (w, h, argv) => {
    const rec = flag(argv, ['-R']);
    const rest = argv.filter((a) => !a.startsWith('-') && a !== 'chmod');
    const [modeStr, target] = rest;
    if (!modeStr || !target) return { lines: [L('usage: chmod [-R] MODE FILE', 'err')], code: 1 };
    const mode = fs.parseMode(modeStr);
    if (mode === null) return { lines: [L(`chmod: invalid mode: '${modeStr}' (use numeric, e.g. 640)`, 'err')], code: 1 };
    const res = fs.chmodNode(h.fs, fs.resolvePath(w.session.cwd, target), mode, rec);
    return res.ok ? { lines: [], code: 0 } : { lines: [L(`chmod: ${res.error}`, 'err')], code: 1 };
  },

  chown: (w, h, argv) => {
    const rec = flag(argv, ['-R']);
    const rest = argv.filter((a) => !a.startsWith('-') && a !== 'chown');
    const [ownerStr, target] = rest;
    if (!ownerStr || !target) return { lines: [L('usage: chown [-R] OWNER[:GROUP] FILE', 'err')], code: 1 };
    const owner = ownerStr.split(':')[0];
    const res = fs.chownNode(h.fs, fs.resolvePath(w.session.cwd, target), owner, rec);
    return res.ok ? { lines: [], code: 0 } : { lines: [L(`chown: ${res.error}`, 'err')], code: 1 };
  },

  // ---------------- processes & system ----------------
  ps: (w, h, argv) => {
    void argv;
    const lines = [L('USER       PID %CPU %MEM     COMMAND', 'hdr')];
    for (const p of h.processes.filter((p) => p.state !== 'zombie')) {
      lines.push(L(`${p.user.padEnd(9)} ${String(p.pid).padEnd(5)} ${p.cpuPct.toFixed(1).padStart(4)} ${((p.memMB / 3864) * 100).toFixed(1).padStart(4)} ${p.cmd}${p.port ? ` (port ${p.port})` : ''}`));
    }
    return { lines, code: 0 };
  },

  top: (w, h) => {
    const lines = [
      L(`top - day ${Math.floor(w.nowMin / 1440) + 1}, load average: ${(0.2 + (w.app.mode !== 'stopped' ? 0.8 : 0)).toFixed(2)}`, 'hdr'),
      L(`Tasks: ${h.processes.length + 2} total`, 'dim'),
      L('%CPU  %MEM  PID   USER  COMMAND', 'hdr')
    ];
    const procs = [...h.processes].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 8);
    for (const p of procs) lines.push(L(`${p.cpuPct.toFixed(1).padStart(4)}  ${((p.memMB / 3864) * 100).toFixed(1).padStart(5)}  ${String(p.pid).padEnd(5)} ${p.user.padEnd(6)} ${p.cmd}`));
    return { lines, code: 0 };
  },

  kill: (w, h, argv) => {
    const pid = parseInt(argv.filter((a) => !a.startsWith('-'))[1] ?? '', 10);
    const p = h.processes.find((x) => x.pid === pid);
    if (!p) return { lines: [L(`kill: (${pid}) - No such process`, 'err')], code: 1 };
    p.state = 'zombie';
    h.processes = h.processes.filter((x) => x !== p);
    if (p.service) {
      const svc = h.services[p.service];
      if (svc) { svc.state = 'inactive'; svc.pid = undefined; }
    }
    w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'proc', text: `Killed pid ${pid} (${p.cmd})` });
    return { lines: [], code: 0 };
  },

  free: (w) => ({
    lines: [
      L('               total        used        free', 'hdr'),
      L(`Mem:            3864        ${1800 + Math.round(cpuNow(w) * 4)}        ${Math.max(0, 2064 - Math.round(cpuNow(w) * 4))}`)
    ],
    code: 0
  }),

  uptime: (w) => ({ lines: [L(` ${new Date().toISOString().slice(11, 19)} up ${Math.floor((w.nowMin % 14400) / 60)}:${String(w.nowMin % 60).padStart(2, '0')},  1 user,  load average: ${(0.3 + cpuNow(w) / 100).toFixed(2)}`)], code: 0 }),
  uname: (w, h) => ({ lines: [L(`Linux ${h.id} ${h.os} #1 SMP x86_64 GNU/Linux`)], code: 0 }),
  whoami: (w) => ({ lines: [L(w.session.user)], code: 0 }),
  id: (w, h) => {
    const u = h.users[w.session.user];
    return { lines: [L(`uid=${u?.uid ?? 1000}(${w.session.user}) gid=${u?.uid ?? 1000}(${w.session.user}) groups=${(u?.groups ?? ['users']).join(',')}`)], code: 0 };
  },
  hostname: (w, h) => ({ lines: [L(h.id)], code: 0 }),
  date: (w) => ({ lines: [L(`day ${Math.floor(w.nowMin / 1440) + 1} ${String(Math.floor((w.nowMin % 1440) / 60)).padStart(2, '0')}:${String(w.nowMin % 60).padStart(2, '0')} sim-time`)], code: 0 }),
  history: (w) => ({ lines: w.session.history.slice(-20).map((hh, i) => L(`${String(i + 1).padStart(4)}  ${hh}`)), code: 0 }),
  env: (w) => ({ lines: Object.entries(w.session.env).map(([k, v]) => L(`${k}=${v}`)), code: 0 }),
  printenv: (w, _h, argv) => {
    if (argv[1]) return { lines: w.session.env[argv[1]] ? [L(w.session.env[argv[1]])] : [], code: w.session.env[argv[1]] ? 0 : 1 };
    return COMMANDS.env(w, _h, argv, null, false, {});
  },
  export: (w, _h, argv) => {
    for (const a of argv.slice(1)) {
      const eq = a.indexOf('=');
      if (eq > 0) w.session.env[a.slice(0, eq)] = a.slice(eq + 1);
    }
    return { lines: [], code: 0 };
  },
  useradd: (w, h, argv) => {
    const name = argv[argv.length - 1];
    if (!name || !/^[a-z_][a-z0-9_-]*$/.test(name)) return { lines: [L('usage: useradd NAME', 'err')], code: 1 };
    if (h.users[name]) return { lines: [L(`useradd: user '${name}' already exists`, 'err')], code: 9 };
    const uid = 1000 + Object.keys(h.users).length;
    h.users[name] = { name, uid, sudo: argv.includes('-s') && false, groups: [name] };
    fs.ensureDir(h.fs, `/home/${name}`, name);
    return { lines: [], code: 0 };
  },
  which: (w, h, argv) => {
    const cmd = argv[1];
    if (!cmd) return { lines: [], code: 1 };
    const known: Record<string, string> = { node: '/usr/bin/node', npm: '/usr/bin/npm', git: '/usr/bin/git', docker: '/usr/bin/docker', psql: '/usr/bin/psql', curl: '/usr/bin/curl', nginx: '/usr/sbin/nginx', python3: '/usr/bin/python3' };
    const hasPkg = cmd === 'docker' ? h.packages.includes('docker.io') : true;
    if (known[cmd] && hasPkg) return { lines: [L(known[cmd])], code: 0 };
    return { lines: [], code: 1 };
  },
  man: (w, _h, argv) => {
    const pages: Record<string, string[]> = {
      ss: ['ss - another utility to investigate sockets', '  -t  TCP  -u  UDP  -l  listening  -p  processes  -n  numeric'],
      journalctl: ['Query the systemd journal.', '  -u UNIT   show logs for unit', '  -n N      show N most recent lines'],
      systemctl: ['Control the systemd system and service manager.', '  status|start|stop|restart|enable|disable UNIT'],
      chmod: ['change file mode bits', '  640 = owner rw, group r, others none'],
      curl: ['transfer a URL', '  -I headers only, -s silent, -X method'],
      df: ['report file system disk space usage (-h human readable)'],
      dig: ['DNS lookup utility', '  dig +short api.example.com'],
      nginx: ['high performance web server / reverse proxy', '  nginx -t tests configuration']
    };
    const p = pages[argv[1] ?? ''];
    return p ? { lines: [L(`MANUAL: ${argv[1]}`, 'hdr'), ...p.map((x) => L(x))], code: 0 } : { lines: [L(`No manual entry for ${argv[1] ?? ''}`, 'err')], code: 1 };
  },
  nano: () => ({ lines: [L('nano: interactive editors are disabled — use the built-in EDITOR tab (left sidebar).', 'warn')], code: 1 }),
  vim: () => ({ lines: [L('vim: interactive editors are disabled — use the built-in EDITOR tab (left sidebar).', 'warn')], code: 1 }),
  vi: () => ({ lines: [L('vi: interactive editors are disabled — use the built-in EDITOR tab (left sidebar).', 'warn')], code: 1 }),
  htop: () => ({ lines: [L('htop: use `top` (one-shot) in the terminal, or the MONITORING dashboard.', 'warn')], code: 1 }),
  crontab: () => ({ lines: [L('crontab: scheduled jobs arrive in a later phase — for now use systemd or manual commands.', 'warn')], code: 1 }),

  // ---------------- services & logs ----------------
  systemctl: (w, h, argv) => systemctlCmd(w, h, argv),
  service: (w, h, argv) => systemctlCmd(w, h, ['systemctl', ...argv.slice(1)]),
  journalctl: (w, h, argv) => {
    const unit = flagValue(argv, '-u');
    const n = parseInt(flagValue(argv, '-n') ?? '15', 10);
    if (!unit) return { lines: [L('-- Logs begin at day 1 --', 'dim'), L('(system journal: use journalctl -u UNIT for service logs)')], code: 0 };
    const svc = h.services[unit.replace('.service', '')];
    if (!svc) return { lines: [L(`Failed to add match "_SYSTEMD_UNIT=${unit}".`, 'err')], code: 1 };
    const entries = svc.log.slice(-n);
    return { lines: entries.length ? entries.map((t) => L(t)) : [L('-- No entries --', 'dim')], code: 0 };
  },

  // ---------------- packages ----------------
  'apt-get': (w, h, argv) => aptCmd(w, h, argv),
  apt: (w, h, argv) => aptCmd(w, h, ['apt-get', ...argv.slice(1)]),

  // ---------------- network ----------------
  ss: (w, h) => {
    const rows: string[] = [];
    for (const s of Object.values(h.services)) {
      if (s.state === 'active' && s.port) rows.push(`tcp  LISTEN  0 128  0.0.0.0:${s.port}  users:(("${s.name}",pid=${s.pid ?? 0}))`);
    }
    for (const c of w.docker.containers) {
      if (c.status === 'running' && c.hostPort) rows.push(`tcp  LISTEN  0 128  0.0.0.0:${c.hostPort}  users:(("docker-proxy",pid=${h.nextPid}))`);
    }
    for (const p of h.processes) {
      if (p.port && p.state !== 'zombie' && !rows.some((r) => r.includes(`:${p.port} `))) rows.push(`tcp  LISTEN  0 128  0.0.0.0:${p.port}  users:(("${p.cmd.split('/').pop()}",pid=${p.pid}))`);
    }
    return { lines: [L('Netid State  Recv-Q Send-Q Local Address:Port  Process', 'hdr'), ...rows.map((r) => L(r))], code: 0 };
  },
  netstat: (w, h, argv, stdin, sudo, env) => COMMANDS.ss(w, h, ['ss'], stdin, sudo, env),
  curl: (w, _h, argv) => {
    const headOnly = flag(argv, ['-I', '--head']);
    const url = argv.filter((a) => !a.startsWith('-') && a !== 'curl')[0];
    if (!url) return { lines: [L('curl: try `curl URL` (e.g. curl -I http://localhost:8080/health)', 'err')], code: 2 };
    const res = httpRequest(w, url, { headOnly });
    return { lines: formatCurl(res, headOnly).map((t) => L(t, res.ok && res.status && res.status >= 500 ? 'err' : undefined)), code: res.ok ? 0 : 7 };
  },
  ping: (w, _h, argv) => {
    const target = argv[1];
    if (!target) return { lines: [L('usage: ping HOST', 'err')], code: 1 };
    const res = resolveHostname(w, target);
    if (res.kind === 'nxdomain') return { lines: [L(`ping: ${target}: Name or service not known`, 'err')], code: 1 };
    const ip = res.kind === 'host' ? res.host.ip : '127.0.0.1';
    const lines = [L(`PING ${target} (${ip}) 56(84) bytes of data.`)];
    for (let i = 1; i <= 3; i++) lines.push(L(`64 bytes from ${ip}: icmp_seq=${i} ttl=64 time=${(0.4 + (i % 3) * 0.15).toFixed(1)} ms`));
    lines.push(L(''));
    lines.push(L(`--- ${target} ping statistics ---`));
    lines.push(L('3 packets transmitted, 3 received, 0% packet loss'));
    return { lines, code: 0 };
  },
  dig: (w, _h, argv) => {
    const name = argv.filter((a) => !a.startsWith('-') && !a.startsWith('+') && a !== 'dig')[0];
    if (!name) return { lines: [L('usage: dig [@server] NAME'), L('example: dig +short api.example.com', 'dim')], code: 1 };
    return { lines: digLookup(w, name).map((t) => L(t)), code: 0 };
  },
  ufw: (w, _h, argv) => {
    const sub = argv[1];
    if (sub === 'status') {
      const lines: OutLine[] = [L(`Status: ${w.firewall.enabled ? 'active' : 'inactive'}`, 'hdr')];
      for (const p of w.firewall.allowedPorts) lines.push(L(`${String(p).padEnd(6)} ALLOW  Anywhere`));
      return { lines, code: 0 };
    }
    if (sub === 'allow') {
      const port = parseInt((argv[2] ?? '').split('/')[0], 10);
      if (!port) return { lines: [L('usage: ufw allow PORT[/tcp]', 'err')], code: 1 };
      if (!w.firewall.allowedPorts.includes(port)) w.firewall.allowedPorts.push(port);
      w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'net', text: `Firewall: allowed port ${port}` });
      return { lines: [L(`Rule added`, 'ok'), L(`Rule added (v6)`)], code: 0 };
    }
    if (sub === 'deny') {
      const port = parseInt((argv[2] ?? '').split('/')[0], 10);
      w.firewall.allowedPorts = w.firewall.allowedPorts.filter((p) => p !== port);
      return { lines: [L('Rule updated', 'ok')], code: 0 };
    }
    if (sub === 'enable') { w.firewall.enabled = true; return { lines: [L('Firewall is active and enabled on system startup', 'ok')], code: 0 }; }
    return { lines: [L('usage: ufw status|allow|deny|enable', 'err')], code: 1 };
  },

  // ---------------- delegating to other sims ----------------
  git: (w, h, argv) => gitCmd(w, h, argv),
  docker: (w, h, argv) => dockerCmd(w, h, argv),
  psql: (w, _h, argv) => {
    const sqlIdx = argv.findIndex((a) => a === '-c');
    const sql = sqlIdx >= 0 ? argv[sqlIdx + 1] : null;
    if (!sql) return { lines: [L('usage: psql -c "SQL"  (connection is configured via DATABASE_URL)', 'err')], code: 1 };
    const res = runSql(w, sql);
    const lines: OutLine[] = [];
    if (res.error) lines.push(L(`psql: error: ${res.error}`, 'err'));
    else {
      if (res.columns.length) {
        lines.push(L(res.columns.join(' | '), 'hdr'));
        lines.push(L(res.columns.map(() => '---').join(' + '), 'dim'));
        for (const r of res.rows.slice(0, 30)) lines.push(L(r.join(' | ')));
      }
      if (res.notice) lines.push(L(res.notice, 'dim'));
      if (res.commandTag) lines.push(L(res.commandTag, 'dim'));
    }
    return { lines, code: res.error ? 1 : 0 };
  },

  bash: (w, h, argv) => {
    const scriptPath = fs.resolvePath(w.session.cwd, argv[1] ?? '');
    const content = fs.readFile(h.fs, scriptPath);
    if (content === null) return { lines: [L(`bash: ${argv[1]}: No such file or directory`, 'err')], code: 127 };
    const lines: OutLine[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const res = runTerminalInput(w, line);
      lines.push(...res.lines);
      if (res.code !== 0) break;
    }
    return { lines, code: 0 };
  },

  ssh: (w, _h, argv) => {
    const target = argv[1];
    if (!target) return { lines: [L('usage: ssh user@host', 'err')], code: 1 };
    const m = /^(?:ssh:\/\/)?([^@]+)@(.+)$/.exec(target);
    if (!m) return { lines: [L('ssh: must specify user@host (e.g. ssh dev@203.0.113.10)', 'err')], code: 255 };
    const [, user, hostRef] = m;
    const h = Object.values(w.hosts).find((x) => x.id === hostRef || x.ip === hostRef);
    if (!h) return { lines: [L(`ssh: connect to host ${hostRef} port 22: Connection refused`, 'err')], code: 255 };
    if (!h.users[user]) return { lines: [L(`${user}@${hostRef}: Permission denied (publickey,password).`, 'err')], code: 255 };
    w.session.pending = { kind: 'ssh-password', hostId: h.id, user };
    return { lines: [L(`${user}@${h.ip}'s password: `)], code: 0 };
  },
  exit: (w) => {
    if (w.session.hostId !== 'laptop') {
      w.session.hostId = 'laptop';
      w.session.user = 'you';
      w.session.cwd = '/Users/you';
      w.session.env = { ...w.session.env, HOME: '/Users/you', USER: 'you' };
      return { lines: [L('logout'), L('Connection to web-01 closed.', 'dim')], code: 0 };
    }
    return { lines: [L('logout')], code: 0 };
  },
  clear: () => ({ lines: [{ text: '__CLEAR__' }], code: 0 }),
  terraform: () => ({ lines: [L('terraform: infrastructure-as-code arrives in Phase 2 — for now manage resources in the CLOUD console.', 'warn')], code: 127 }),
  kubectl: () => ({ lines: [L('kubectl: Kubernetes arrives in Phase 2 — the cluster is not unlocked yet.', 'warn')], code: 127 })
};

function env(w: World): Record<string, string> { return w.session.env; }

function cpuNow(w: World): number {
  return w.monitoring.series.cpu_pct?.length ? w.monitoring.series.cpu_pct[w.monitoring.series.cpu_pct.length - 1].v : 12;
}

function logVolumeMb(w: World): number {
  return w.flags.logrotateConfigured ? 52 : Math.min(38000, Math.max(0, w.nowMin - Number(w.flags.logStartMin ?? 0)) * 0.12);
}

function humanSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.max(1, Math.round(mb))}M`;
}

// ---------------- systemctl ----------------
function systemctlCmd(w: World, h: SimHost, argv: string[]): CmdOut {
  const sub = argv[1];
  const unitName = (argv[2] ?? '').replace('.service', '');
  const svc = h.services[unitName];
  if (!sub || !svc) return { lines: [L(`Unknown operation ${sub ?? ''} or unit ${unitName}. Units: ${Object.keys(h.services).join(', ') || 'none'}`, 'err')], code: 1 };
  switch (sub) {
    case 'status': {
      const lines: OutLine[] = [];
      const stateTxt = svc.state === 'active' ? `active (running)` : svc.state === 'failed' ? 'failed (Result: exit-code)' : 'inactive (dead)';
      lines.push(L(`● ${svc.name}.service - ${svc.description}`, svc.state === 'active' ? 'ok' : 'err'));
      lines.push(L(`     Loaded: loaded (/etc/systemd/system/${svc.name}.service; ${svc.enabled ? 'enabled' : 'disabled'})`));
      lines.push(L(`     Active: ${stateTxt}`));
      if (svc.pid) lines.push(L(`   Main PID: ${svc.pid} (node)`));
      lines.push(L(''));
      for (const t of svc.log.slice(-4)) lines.push(L(t, svc.state === 'failed' ? 'err' : 'dim'));
      return { lines, code: svc.state === 'active' ? 0 : 3 };
    }
    case 'is-active':
      return { lines: [L(svc.state === 'active' ? 'active' : svc.state === 'failed' ? 'failed' : 'inactive')], code: svc.state === 'active' ? 0 : 3 };
    case 'start': {
      if (svc.state === 'active') return { lines: [], code: 0 };
      // re-read the unit file: User= and EnvironmentFile= may have been edited
      const unitContent = fs.readFile(h.fs, `/etc/systemd/system/${svc.name}.service`);
      if (unitContent) {
        const userM = /^User\s*=\s*(\S+)\s*$/m.exec(unitContent);
        if (userM) svc.user = userM[1];
        const envM = /^EnvironmentFile\s*=\s*(\S+)\s*$/m.exec(unitContent);
        svc.envFile = envM ? envM[1] : undefined;
      }
      // port conflict check
      if (svc.port) {
        const cont = w.docker.containers.find((c) => c.status === 'running' && c.hostPort === svc.port);
        const stale = h.processes.find((p) => p.port === svc.port && p.state !== 'zombie' && (!p.service || p.service !== svc.name));
        if (cont || stale) {
          svc.state = 'failed';
          const ts = tsOf(w);
          svc.log.push(ts + ' ' + h.id + ' api[1024]: Error: listen EADDRINUSE: address already in use :' + svc.port);
          return { lines: [L(`Job for ${svc.name}.service failed because the control process exited with error code.`, 'err'), L(`See "systemctl status ${svc.name}" and "journalctl -u ${svc.name}" for details.`, 'err')], code: 1 };
        }
      }
      svc.state = 'active';
      svc.pid = h.nextPid++;
      const exec = svc.execStart.split(' ').pop() ?? 'node';
      addProcess(h, `${exec} ${svc.execStart.split(' ').pop()}`, svc.user, svc.port, svc.name);
      h.processes[h.processes.length - 1].pid = svc.pid;
      svc.log.push(`${tsOf(w)} ${h.id} ${svc.name}[${svc.pid}]: ${svc.name} listening on :${svc.port}`);
      if (svc.name === 'api') {
        w.app = { ...w.app, mode: 'service', uptimeSinceMin: w.nowMin, env: readEnvFileFor(w, svc) };
        w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'deploy', text: `Started ${svc.name}.service (${w.app.version})` });
      }
      return { lines: [], code: 0 };
    }
    case 'stop': {
      svc.state = 'inactive';
      svc.pid = undefined;
      h.processes = h.processes.filter((p) => p.service !== svc.name);
      if (svc.name === 'api') w.app = { ...w.app, mode: w.docker.containers.some((c) => c.status === 'running' && c.serviceRef === 'api') ? 'container' : 'stopped' };
      w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'deploy', text: `Stopped ${svc.name}.service` });
      return { lines: [], code: 0 };
    }
    case 'restart': {
      systemctlCmd(w, h, ['systemctl', 'stop', unitName]);
      return systemctlCmd(w, h, ['systemctl', 'start', unitName]);
    }
    case 'enable': svc.enabled = true; return { lines: [L(`Created symlink /etc/systemd/system/multi-user.target.wants/${svc.name}.service → /etc/systemd/system/${svc.name}.service.`)], code: 0 };
    case 'disable': svc.enabled = false; return { lines: [L(`Removed "/etc/systemd/system/multi-user.target.wants/${svc.name}.service".`)], code: 0 };
    case 'reload':
    case 'daemon-reload':
      return { lines: [], code: 0 };
    default:
      return { lines: [L(`Unknown systemctl operation: ${sub}`, 'err')], code: 1 };
  }
}

function tsOf(w: World): string {
  const day = Math.floor(w.nowMin / 1440) + 1;
  const hh = String(Math.floor((w.nowMin % 1440) / 60)).padStart(2, '0');
  const mm = String(w.nowMin % 60).padStart(2, '0');
  return `Sep ${String(((day - 1) % 28) + 1).padStart(2, '0')} ${hh}:${mm}:00`;
}

export function readEnvFileFor(w: World, svc: { envFile?: string }): Record<string, string> {
  if (!svc.envFile) return {};
  const content = fs.readFile(w.hosts['web-01'].fs, svc.envFile) ?? '';
  const env: Record<string, string> = {};
  for (const l of content.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// ---------------- apt ----------------
const APT_PACKAGES: Record<string, { desc: string; sizeMB: number }> = {
  nginx: { desc: 'high performance web server and reverse proxy', sizeMB: 18 },
  'docker.io': { desc: 'Docker container runtime', sizeMB: 320 },
  logrotate: { desc: 'Log rotation utility', sizeMB: 1 },
  'postgresql-client': { desc: 'front-end programs for PostgreSQL', sizeMB: 12 },
  htop: { desc: 'interactive processes viewer', sizeMB: 2 },
  sqlite3: { desc: 'Command line interface for SQLite', sizeMB: 3 }
};

function aptCmd(w: World, h: SimHost, argv: string[]): CmdOut {
  const lines: OutLine[] = [];
  const installIdx = argv.findIndex((a) => a === 'install');
  if (installIdx === -1) return { lines: [L('usage: apt-get install [-y] PACKAGE', 'err')], code: 1 };
  for (const pkg of argv.slice(installIdx + 1).filter((a) => !a.startsWith('-'))) {
    const meta = APT_PACKAGES[pkg];
    if (!meta) { lines.push(L(`E: Unable to locate package ${pkg}`, 'err')); return { lines, code: 100 }; }
    if (h.packages.includes(pkg)) { lines.push(L(`${pkg} is already the newest version (${1 + pkg.length}.0).`, 'dim')); continue; }
    lines.push(L(`Reading package lists... Done`, 'dim'));
    lines.push(L(`The following NEW packages will be installed:`, 'dim'));
    lines.push(L(`  ${pkg} (${meta.desc})`, 'dim'));
    lines.push(L(`Need to get ${meta.sizeMB}.0 MB of archives.`, 'dim'));
    lines.push(L(`Setting up ${pkg} ...`, 'ok'));
    h.packages.push(pkg);
    h.diskUsedBaseMB += meta.sizeMB;
    w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'pkg', text: `Installed ${pkg}` });
    if (pkg === 'nginx') provisionNginx(w, h);
  }
  return { lines, code: 0 };
}

function provisionNginx(w: World, h: SimHost): void {
  fs.ensureDir(h.fs, '/etc/nginx/sites-enabled', 'root');
  fs.ensureDir(h.fs, '/etc/nginx/sites-available', 'root');
  fs.writeFile(h.fs, '/etc/nginx/sites-enabled/default', `server {\n    listen 80 default_server;\n    server_name _;\n    root /var/www/html;\n}\n`);
  h.services['nginx'] = {
    name: 'nginx',
    description: 'A high performance web server and reverse proxy',
    state: 'inactive',
    enabled: false,
    execStart: '/usr/sbin/nginx -g "daemon on; master_process on;"',
    user: 'root',
    port: 80,
    log: []
  };
  void w;
}

// ---------------- git command ----------------
function gitCmd(w: World, h: SimHost, argv: string[]): CmdOut {
  const origCwd = w.session.cwd;
  // git -C <path> … runs as if started in <path>; the shell cwd is not changed
  const cIdx = argv.indexOf('-C');
  if (cIdx >= 0 && argv[cIdx + 1]) {
    w.session.cwd = fs.resolvePath(origCwd, argv[cIdx + 1]);
    argv = argv.filter((_, i) => i !== cIdx && i !== cIdx + 1);
  }
  try {
    return gitCmdInner(w, h, argv);
  } finally {
    w.session.cwd = origCwd;
  }
}

function gitCmdInner(w: World, h: SimHost, argv: string[]): CmdOut {
  const sub = argv[1];
  const repo = findRepoFor(w, w.session.cwd);
  const err = (t: string, code = 1): CmdOut => ({ lines: [L(t, 'err')], code });

  if (sub === 'config') {
    const rest = argv.slice(2).filter((a) => a !== '--global');
    const key = rest[0];
    const val = rest[1];
    if (!key || !val) return { lines: [L(`usage: git config [--global] user.name "Your Name"`, 'err')], code: 1 };
    w.session.env[key === 'user.name' ? 'GIT_AUTHOR_NAME' : 'GIT_AUTHOR_EMAIL'] = val;
    return { lines: [], code: 0 };
  }
  if (sub === 'init') {
    const target = argv[2] ? fs.resolvePath(w.session.cwd, argv[2]) : w.session.cwd;
    if (w.git[target]) return err(`Reinitialized existing Git repository in ${target}/.git/`);
    initRepo(w, target);
    return { lines: [L(`Initialized empty Git repository in ${target}/.git/`, 'ok')], code: 0 };
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return {
      lines: [
        L('git — version control (simulated)', 'hdr'),
        L('usage: git <command> [args]', 'dim'),
        L(''),
        L('start:   init, clone'),
        L('work:    status, add, mv, rm, restore [--staged], reset [--soft|--hard], diff'),
        L('history: commit, log [--oneline], show <rev>, blame <file>, tag'),
        L('branch:  branch [-d|-D], checkout [-b], switch [-c], merge'),
        L('remote:  fetch [remote], pull [remote <branch>], push [remote], remote add'),
        L('repair:  revert <rev>, cherry-pick <rev>, stash [push|list|pop|drop]')
      ],
      code: 0
    };
  }
  if (!repo) return err('fatal: not a git repository (or any of the parent directories): .git');
  const st = () => gitStatus(w, repo);

  switch (sub) {
    case 'status': {
      const s = st();
      const lines: OutLine[] = [];
      lines.push(L(`On branch ${s.branch}`));
      if (s.merging) lines.push(L(`You have unmerged paths.`, 'warn'));
      if (s.ahead || s.behind) {
        const parts = [];
        if (s.ahead) parts.push(`Your branch is ahead of 'origin/${s.branch}' by ${s.ahead} commit${s.ahead > 1 ? 's' : ''}.`);
        if (s.behind) parts.push(`Your branch is behind 'origin/${s.branch}' by ${s.behind} commit${s.behind > 1 ? 's' : ''}.`);
        if (parts.length) lines.push(L(parts.join(' '), 'dim'));
      } else if (repo.remoteBranches[`origin/${s.branch}`]) {
        lines.push(L(`Your branch is up to date with 'origin/${s.branch}'.`, 'dim'));
      }
      if (s.conflicted.length) {
        lines.push(L('Unmerged paths:', 'hdr'));
        for (const p of s.conflicted) lines.push(L(`   both modified:   ${p}`, 'err'));
      }
      if (s.staged.length) {
        lines.push(L('Changes to be committed:', 'hdr'));
        for (const c of s.staged) lines.push(L(`        ${c.kind}:   ${c.path}`, 'ok'));
      }
      if (s.unstaged.length) {
        lines.push(L('Changes not staged for commit:', 'hdr'));
        for (const c of s.unstaged) lines.push(L(`        ${c.kind}:   ${c.path}`, 'err'));
      }
      if (s.untracked.length) {
        lines.push(L('Untracked files:', 'hdr'));
        for (const p of s.untracked) lines.push(L(`        ${p}`, 'err'));
        lines.push(L('  (use "git add <file>..." to include in what will be committed)', 'dim'));
      }
      if (!s.staged.length && !s.unstaged.length && !s.untracked.length && !s.conflicted.length) {
        lines.push(L('nothing to commit, working tree clean'));
      }
      return { lines, code: 0 };
    }
    case 'add': {
      const rawArgs = argv.slice(2);
      const targets = rawArgs.filter((a) => !a.startsWith('-'));
      const files = worktreeFiles(w, repo);
      const addOne = (rel: string, content: string | null) => { repo.staging[rel] = content; };
      if (rawArgs.includes('-A') || rawArgs.includes('--all') || targets.includes('.')) {
        for (const rel of files) if (!readFileSafeIgnored(repo, w, rel)) addOne(rel, fs.readFile(h.fs, `${repo.path}/${rel}`) ?? '');
        for (const p of Object.keys(repo.commits[repo.branches[repo.head].commit]?.tree ?? {})) {
          if (!files.includes(p) && !readFileSafeIgnored(repo, w, p)) addOne(p, null);
        }
      } else {
        for (const t of targets) {
          const rel = t.startsWith('/') ? t.slice(repo.path.length + 1) : t;
          const content = fs.readFile(h.fs, `${repo.path}/${rel}`);
          if (content === null) return err(`fatal: pathspec '${t}' did not match any files`);
          addOne(rel, content);
        }
      }
      // resolve conflicts
      if (repo.merging) {
        for (const t of targets) {
          const rel = t.startsWith('/') ? t.slice(repo.path.length + 1) : t;
          repo.merging.conflicted = repo.merging.conflicted.filter((p) => p !== rel);
        }
      }
      return { lines: [], code: 0 };
    }
    case 'commit': {
      const mIdx = argv.findIndex((a) => a === '-m');
      let message = mIdx >= 0 ? argv[mIdx + 1] : null;
      if (!w.session.env.GIT_AUTHOR_NAME || !w.session.env.GIT_AUTHOR_EMAIL) {
        return err(`Author identity unknown\n\n*** Please tell me who you are.\n\nRun:\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n`);
      }
      if (!Object.keys(repo.staging).length && !repo.merging) return err('nothing to commit, working tree clean');
      if (repo.merging && repo.merging.conflicted.length) return err(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the EDITOR, then 'git add' the files.`);
      if (!message) message = repo.merging ? `Merge branch '${repo.merging.from}'` : 'Update';
      const changed = Object.keys(repo.staging);
      const c = repo.merging ? completeMergeCommit(w, repo) : makeCommit(w, repo, message!, changed);
      return { lines: [L(`[${repo.head} ${c.sha.slice(0, 7)}] ${c.message}`, 'ok'), L(` ${changed.length} file${changed.length !== 1 ? 's' : ''} changed`, 'dim')], code: 0 };
    }
    case 'branch': {
      const delFlag = ['-d', '-D', '--delete'].find((f) => argv.includes(f));
      if (delFlag) {
        const name = argv[argv.indexOf(delFlag) + 1];
        if (!name || !repo.branches[name]) return err(`error: branch '${name ?? ''}' not found.`);
        if (name === repo.head) return err(`error: cannot delete branch '${name}' used by worktree at '${repo.path}'`);
        if (delFlag === '-d' && !isAncestor(repo, repo.branches[name].commit, repo.head)) {
          return err(`error: the branch '${name}' is not fully merged.\nhint: if you are sure you want to delete it, run 'git branch -D ${name}'.`);
        }
        const sha = repo.branches[name].commit;
        delete repo.branches[name];
        return { lines: [L(`Deleted branch ${name} (was ${(repo.commits[sha]?.sha ?? sha).slice(0, 7)}).`, 'dim')], code: 0 };
      }
      if (!argv[2]) return { lines: Object.keys(repo.branches).map((b) => L(`${b === repo.head ? '* ' : '  '}${b}`)), code: 0 };
      const name = argv[2];
      if (repo.branches[name]) return err(`fatal: a branch named '${name}' already exists`);
      repo.branches[name] = { commit: repo.branches[repo.head].commit };
      return { lines: [], code: 0 };
    }
    case 'checkout':
    case 'switch': {
      let name = argv[2] === '--' ? argv[3] : argv[2];
      const create = flag(argv, ['-b', '-c']);
      if (create) {
        name = argv[argv.indexOf('-b') + 1] ?? argv[argv.indexOf('-c') + 1];
        if (!name) return err('fatal: branch name required');
        if (repo.branches[name]) return err(`fatal: a branch named '${name}' already exists`);
        repo.branches[name] = { commit: repo.branches[repo.head].commit };
      }
      if (!name) return err('fatal: branch name required');
      if (repo.merging && repo.merging.conflicted.length && repo.branches[name]) return err('error: you need to resolve your current merge first');
      if (!repo.branches[name]) {
        // not a branch — maybe a tracked file path: restore it from HEAD
        const headCommit = repo.branches[repo.head]?.commit ? repo.commits[repo.branches[repo.head].commit] : null;
        if (headCommit && headCommit.tree[name] !== undefined) {
          fs.writeFile(h.fs, `${repo.path}/${name}`, headCommit.tree[name]);
          return { lines: [], code: 0 };
        }
        return err(`error: pathspec '${name}' did not match any file(s) known to git`);
      }
      repo.head = name;
      const commit = repo.commits[repo.branches[name].commit];
      if (commit) restoreTree(w, repo, commit.tree);
      return { lines: [L(`Switched to branch '${name}'`, 'ok')], code: 0 };
    }
    case 'merge': {
      const from = argv[2];
      if (!from) return err('fatal: merge requires a branch or remote ref');
      const res = mergeBranch(w, repo, from);
      return { lines: res.lines, code: res.conflicted ? 1 : 0 };
    }
    case 'pull': {
      let remoteRef: string;
      if (argv[3]) remoteRef = `${argv[2]}/${argv[3]}`; // git pull origin main
      else if (argv[2]) remoteRef = argv[2];            // git pull origin/main
      else remoteRef = `origin/${repo.head}`;
      const remoteSha = repo.remoteBranches[remoteRef];
      if (!remoteSha) return { lines: [L('Already up to date.')], code: 0 };
      const res = mergeBranch(w, repo, remoteRef);
      return { lines: res.lines, code: res.conflicted ? 1 : 0 };
    }
    case 'push': {
      const remote = argv[2] ?? 'origin';
      if (!repo.remotes[remote]) return err(`fatal: '${remote}' does not appear to be a git repository`);
      const sha = repo.branches[repo.head]?.commit;
      if (!sha) return err('error: failed to push some refs: nothing to push');
      repo.remoteBranches[`origin/${repo.head}`] = sha;
      w.flags.pushedToRemote = true;
      w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'git', text: `Pushed ${repo.head} (${sha.slice(0, 7)}) to origin` });
      return { lines: [L(`Enumerating objects: ${Object.keys(repo.commits).length * 3}, done.`, 'dim'), L(`To ${repo.remotes[remote]}`, 'dim'), L(` * [new branch]      ${repo.head} -> ${repo.head}`, 'ok')], code: 0 };
    }
    case 'remote': {
      if (argv[2] === 'add') {
        repo.remotes[argv[3]] = argv[4] ?? '';
        return { lines: [], code: 0 };
      }
      return { lines: Object.entries(repo.remotes).map(([k, v]) => L(`${k}\t${v}`)), code: 0 };
    }
    case 'log': {
      return { lines: logLines(repo, flag(argv, ['--oneline'])), code: 0 };
    }
    case 'diff': {
      const s = st();
      const lines: OutLine[] = [];
      const headTree = repo.branches[repo.head].commit ? repo.commits[repo.branches[repo.head].commit].tree : {};
      for (const c of [...s.staged, ...s.unstaged]) {
        lines.push(L(`diff --git a/${c.path} b/${c.path}`, 'hdr'));
        const oldC = headTree[c.path] ?? '';
        const newC = repo.staging[c.path] ?? fs.readFile(h.fs, `${repo.path}/${c.path}`) ?? '';
        const oldL = oldC.split('\n');
        const newL = newC.split('\n');
        lines.push(L(`@@ -1,${oldL.length} +1,${newL.length} @@`, 'dim'));
        for (const l of oldL) if (!newL.includes(l)) lines.push(L(`-${l}`, 'err'));
        for (const l of newL) if (!oldL.includes(l)) lines.push(L(`+${l}`, 'ok'));
      }
      return { lines: lines.length ? lines : [L('(no diff)')], code: 0 };
    }
    case 'tag': {
      if (argv[2]) {
        repo.commits[repo.branches[repo.head].commit]?.changed.push(`__tag:${argv[2]}`);
        w.flags['tag:' + argv[2]] = true;
        return { lines: [], code: 0 };
      }
      return { lines: Object.keys(w.flags).filter((k) => k.startsWith('tag:')).map((k) => L(k.slice(4))), code: 0 };
    }
    case 'fetch': {
      const remote = argv.slice(2).find((a) => !a.startsWith('-')) ?? 'origin';
      if (!repo.remotes[remote]) return err(`fatal: '${remote}' does not appear to be a git repository`);
      const lines: OutLine[] = [];
      lines.push(L(`Fetching ${remote}`, 'dim'));
      let changed = false;
      for (const [ref, sha] of Object.entries(repo.remoteBranches)) {
        const localBranch = ref.replace('origin/', '');
        const local = repo.branches[localBranch]?.commit;
        if (!local) {
          lines.push(L(` * [new branch]      ${localBranch} -> ${ref}`));
          changed = true;
        } else if (local !== sha && !isAncestor(repo, sha, localBranch)) {
          lines.push(L(`   ${local.slice(0, 7)}..${sha.slice(0, 7)}  ${localBranch} -> ${ref}`));
          changed = true;
        }
      }
      if (!changed) lines.push(L('Already up to date.', 'dim'));
      lines.push({ text: `hint: integrate with 'git merge origin/${repo.head}' or 'git pull'`, cls: 'dim' });
      return { lines, code: 0 };
    }
    case 'revert': {
      const s = gitStatus(w, repo);
      if (s.staged.length || s.unstaged.length || s.conflicted.length) {
        return err(`error: your local changes to the following files would be overwritten by revert:\n${[...s.staged, ...s.unstaged].map((c) => '\t' + c.path).join('\n')}\nhint: commit your changes first, or stash them with 'git stash'.`);
      }
      const target = resolveRef(repo, argv[2] ?? 'HEAD');
      if (!target) return err(`fatal: bad revision '${argv[2] ?? ''}'`);
      const parent = target.parents[0] ? repo.commits[target.parents[0]] : null;
      const paths = new Set<string>([...Object.keys(target.tree), ...(parent ? Object.keys(parent.tree) : [])]);
      const changed: string[] = [];
      for (const p of paths) {
        const before = parent ? parent.tree[p] : undefined;
        if (target.tree[p] === before) continue;
        if (before === undefined) {
          fs.rmNode(h.fs, `${repo.path}/${p}`);
          repo.staging[p] = null;
        } else {
          fs.writeFile(h.fs, `${repo.path}/${p}`, before);
          repo.staging[p] = before;
        }
        changed.push(p);
      }
      if (!changed.length) return err(`error: commit ${target.sha} is empty — nothing to revert`);
      const c = makeCommit(w, repo, `Revert "${target.message}"`, changed);
      w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'git', text: `Reverted ${target.sha.slice(0, 7)} ("${target.message}") as ${c.sha.slice(0, 7)}` });
      return { lines: [L(`[${repo.head} ${c.sha.slice(0, 7)}] Revert "${target.message}"`, 'ok'), L(` ${changed.length} file${changed.length !== 1 ? 's' : ''} changed`, 'dim')], code: 0 };
    }
    case 'restore': {
      const staged = flag(argv, ['--staged', '-S']);
      const targets = argv.slice(2).filter((a) => !a.startsWith('-'));
      if (!targets.length) return err('fatal: you must specify path(s) to restore');
      const headCommit = repo.branches[repo.head]?.commit ? repo.commits[repo.branches[repo.head].commit] : null;
      if (staged) {
        for (const t of targets) {
          if (t === '.') { repo.staging = {}; continue; }
          if (repo.staging[t] === undefined && !headCommit?.tree[t]) return err(`error: pathspec '${t}' did not match any file(s) known to git`);
          delete repo.staging[t];
        }
        return { lines: [], code: 0 };
      }
      for (const t of targets) {
        if (t === '.') {
          for (const [p, content] of Object.entries(headCommit?.tree ?? {})) fs.writeFile(h.fs, `${repo.path}/${p}`, content);
          continue;
        }
        if (!headCommit || headCommit.tree[t] === undefined) {
          return err(`error: pathspec '${t}' did not match any file(s) known to git\nhint: '${t}' has no committed version to restore — did you mean 'git restore --staged ${t}'?`);
        }
        fs.writeFile(h.fs, `${repo.path}/${t}`, headCommit.tree[t]);
      }
      return { lines: [], code: 0 };
    }
    case 'reset': {
      const modeArg = ['-soft', '--soft', '--mixed', '--hard'].find((f) => argv.includes(f));
      const refArg = argv.slice(2).find((a) => !a.startsWith('-'));
      if (repo.merging && repo.merging.conflicted.length) return err('fatal: cannot reset a merge in progress — resolve the conflict or use `git merge --abort`');
      const target = resolveRef(repo, refArg ?? 'HEAD');
      if (!target) return err(`fatal: ambiguous argument '${refArg ?? ''}': unknown revision`);
      repo.branches[repo.head] = { commit: target.sha };
      if (modeArg === '--soft') {
        return { lines: [], code: 0 };
      }
      if (modeArg === '--hard') {
        restoreTree(w, repo, target.tree);
        repo.staging = {};
        repo.merging = null;
        w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'git', text: `git reset --hard ${target.sha.slice(0, 7)} (working tree restored)` });
        return { lines: [L(`HEAD is now at ${target.sha.slice(0, 7)} ${target.message}`)], code: 0 };
      }
      repo.staging = {};
      const s = gitStatus(w, repo);
      const lines: OutLine[] = [L(`Unstaged changes after reset:`)];
      for (const c2 of s.unstaged) lines.push(L(`M\t${c2.path}`));
      return { lines, code: 0 };
    }
    case 'show': {
      const target = resolveRef(repo, argv[2] ?? 'HEAD');
      if (!target) return err(`fatal: bad revision '${argv[2] ?? 'HEAD'}'`);
      const lines: OutLine[] = [
        L(`commit ${target.sha}`),
        L(`Author: ${target.author} <${target.email}>`, 'dim'),
        L(`Date:   day ${Math.floor(target.timeMin / 1440) + 1}`, 'dim'),
        L(''),
        L(`    ${target.message}`),
        L('')
      ];
      const diff = treeDiff(repo, target);
      for (const [p, content] of Object.entries(diff)) {
        lines.push(L(`diff --git a/${p} b/${p}`, 'hdr'));
        const old = target.parents[0] ? repo.commits[target.parents[0]]?.tree[p] ?? '' : '';
        for (const l of old.split('\n')) if (l) lines.push(L(`-${l}`, 'err'));
        for (const l of (content ?? '').split('\n')) if (l) lines.push(L(`+${l}`, 'ok'));
      }
      return { lines, code: 0 };
    }
    case 'blame': {
      const file = argv[2];
      const headCommit = repo.branches[repo.head]?.commit ? repo.commits[repo.branches[repo.head].commit] : null;
      if (!headCommit || headCommit.tree[file] === undefined) return err(`fatal: no such path '${file ?? ''}' in HEAD`);
      const fileLines = headCommit.tree[file].split('\n');
      const shaOf: (string | null)[] = new Array(fileLines.length).fill(null);
      const assigned = new Set<number>();
      let cur: GitCommit | undefined = headCommit;
      while (cur) {
        const parent: GitCommit | null = cur.parents[0] ? repo.commits[cur.parents[0]] ?? null : null;
        const curLines = (cur.tree[file] ?? '').split('\n');
        const parentLines = new Set((parent ? parent.tree[file] ?? '' : '').split('\n'));
        const c = cur;
        curLines.forEach((ln, i) => {
          if (!assigned.has(i) && ln && !parentLines.has(ln)) { shaOf[i] = c.sha; assigned.add(i); }
        });
        cur = parent ?? undefined;
      }
      const first = Object.keys(repo.commits).length ? headCommit : null;
      void first;
      return {
        lines: fileLines.map((ln, i) => L(`${(shaOf[i] ?? headCommit.sha).slice(0, 7)} (${(repo.commits[shaOf[i] ?? headCommit.sha]?.author ?? headCommit.author).padEnd(6)} day ${Math.floor((repo.commits[shaOf[i] ?? headCommit.sha]?.timeMin ?? headCommit.timeMin) / 1440) + 1}) ${String(i + 1).padStart(3)}) ${ln}`)),
        code: 0
      };
    }
    case 'stash': {
      repo.stash ??= [];
      const subArg = argv[2] && !argv[2].startsWith('-') ? argv[2] : 'push';
      const headCommit = repo.branches[repo.head]?.commit ? repo.commits[repo.branches[repo.head].commit] : null;
      if (subArg === 'push' || subArg === 'save' || argv.length <= 2) {
        const s = gitStatus(w, repo);
        const paths = new Set<string>([...Object.keys(repo.staging), ...s.unstaged.map((u) => u.path)]);
        if (!paths.size) return err('No local changes to save');
        const msg = flagValue(argv, '-m') ?? flagValue(argv, '--message') ?? `WIP on ${repo.head}`;
        const files: Record<string, string | null> = {};
        for (const p of paths) files[p] = fs.readFile(h.fs, `${repo.path}/${p}`);
        repo.stash.unshift({ id: Date.now() % 100000, message: `On ${repo.head}: ${msg}`, files });
        // restore worktree to HEAD
        for (const p of paths) {
          if (headCommit && headCommit.tree[p] !== undefined) fs.writeFile(h.fs, `${repo.path}/${p}`, headCommit.tree[p]);
          else fs.rmNode(h.fs, `${repo.path}/${p}`);
        }
        repo.staging = {};
        return { lines: [L(`Saved working directory and index state ${repo.stash[0].message}`)], code: 0 };
      }
      if (subArg === 'list') {
        if (!repo.stash.length) return err('No stash entries found.');
        return { lines: repo.stash.map((st, i) => L(`stash@{${i}}: ${st.message}`)), code: 0 };
      }
      if (subArg === 'pop' || subArg === 'apply' || subArg === 'drop') {
        const idxMatch = /^stash@\{(\d+)\}$/.exec(argv[3] ?? '');
        const idx = idxMatch ? Number(idxMatch[1]) : 0;
        const entry = repo.stash[idx];
        if (!entry) return err(`error: ${argv[3] ?? 'stash@{0}'} is not a valid reference`);
        if (subArg !== 'drop') {
          if (repo.merging && repo.merging.conflicted.length) return err('error: cannot stash pop during a merge');
          for (const [p, content] of Object.entries(entry.files)) {
            if (content === null) fs.rmNode(h.fs, `${repo.path}/${p}`);
            else fs.writeFile(h.fs, `${repo.path}/${p}`, content);
            repo.staging[p] = content;
          }
        }
        if (subArg === 'pop' || subArg === 'drop') repo.stash.splice(idx, 1);
        return { lines: subArg === 'drop' ? [L(`Dropped ${argv[3] ?? 'stash@{0}'}`, 'dim')] : [L(`${entry.message}`, 'dim')], code: 0 };
      }
      return err(`git stash: '${subArg}' is not a stash command. See 'git --help'.`);
    }
    case 'cherry-pick': {
      const s = gitStatus(w, repo);
      if (s.staged.length || s.conflicted.length) return err('error: your local changes would be overwritten — commit or stash first');
      if (repo.merging && repo.merging.conflicted.length) return err('error: you need to resolve your current merge first');
      const src = resolveRef(repo, argv[2]);
      if (!src) return err(`fatal: bad revision '${argv[2] ?? ''}'`);
      if (!src.parents.length) return err('error: cannot cherry-pick a root commit in this sandbox');
      const diff = treeDiff(repo, src);
      for (const [p, content] of Object.entries(diff)) {
        if (content === null) fs.rmNode(h.fs, `${repo.path}/${p}`);
        else fs.writeFile(h.fs, `${repo.path}/${p}`, content);
        repo.staging[p] = content;
      }
      const c = makeCommit(w, repo, `${src.message} (cherry-picked from ${src.sha.slice(0, 7)})`, Object.keys(diff));
      return { lines: [L(`[main ${c.sha.slice(0, 7)}] ${c.message}`, 'ok')], code: 0 };
    }
    case 'mv': {
      const [src, dst] = argv.slice(2).filter((a) => !a.startsWith('-'));
      if (!src || !dst) return err('usage: git mv SOURCE DEST');
      const content = fs.readFile(h.fs, `${repo.path}/${src}`);
      if (content === null) return err(`fatal: bad source, source='${src}', error: source file is not under version control`);
      fs.writeFile(h.fs, `${repo.path}/${dst}`, content);
      fs.rmNode(h.fs, `${repo.path}/${src}`);
      repo.staging[src] = null;
      repo.staging[dst] = content;
      return { lines: [], code: 0 };
    }
    case 'rm': {
      const cached = flag(argv, ['--cached']);
      const targets = argv.slice(2).filter((a) => !a.startsWith('-'));
      if (!targets.length) return err('usage: git rm [--cached] FILE');
      const lines: OutLine[] = [];
      for (const t of targets) {
        if (!cached) {
          const res = fs.rmNode(h.fs, `${repo.path}/${t}`);
          if (!res.ok) return err(`fatal: pathspec '${t}' did not match any files`);
        }
        repo.staging[t] = null;
        lines.push(L(`rm '${t}'`, 'dim'));
      }
      return { lines, code: 0 };
    }
    case 'clone': return err('git clone is disabled in the sandbox — use the repository on the server');
    default: return err(`git: '${sub ?? ''}' is not a git command. See 'git --help'.`);
  }
}

function readFileSafeIgnored(repo: import('../types').GitRepo, w: World, rel: string): boolean {
  try {
    return isIgnoredShim(repo, w, rel);
  } catch { return false; }
}

function isIgnoredShim(repo: import('../types').GitRepo, w: World, rel: string): boolean {
  // .gitignore read directly from repo path on the host fs
  const content = fs.readFile(w.hosts['web-01'].fs, `${repo.path}/.gitignore`) ?? '';
  for (const pat of content.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))) {
    const p = pat.replace(/\/$/, '');
    if (p === rel) return true;
    if (pat.endsWith('/') && rel.startsWith(p + '/')) return true;
  }
  return false;
}

function restoreTree(w: World, repo: import('../types').GitRepo, tree: Record<string, string>): void {
  for (const [p, content] of Object.entries(tree)) {
    fs.writeFile(w.hosts['web-01'].fs, `${repo.path}/${p}`, content);
  }
}

// ---------------- docker command ----------------
function dockerCmd(w: World, h: SimHost, argv: string[]): CmdOut {
  if (!h.packages.includes('docker.io')) return { lines: [L('docker: command not found — install it first: sudo apt-get install -y docker.io', 'err')], code: 127 };
  const sub = argv[1];
  switch (sub) {
    case 'build': {
      const tIdx = argv.indexOf('-t');
      const tag = tIdx >= 0 ? argv[tIdx + 1] : null;
      const ctxIdx = argv.lastIndexOf('.');
      const ctxPath = ctxIdx > 0 ? fs.resolvePath(w.session.cwd, argv[ctxIdx]) : w.session.cwd;
      if (!tag) return { lines: [L('docker build: "-t name:tag" is required', 'err')], code: 1 };
      const res = buildImage(w, tag, `${ctxPath}/Dockerfile`);
      return { lines: res.lines, code: res.ok ? 0 : 1 };
    }
    case 'run': {
      const res = runContainer(w, argv.slice(2));
      return { lines: res.lines, code: res.container ? 0 : 125 };
    }
    case 'ps': {
      const all = flag(argv, ['-a', '--all']);
      const lines = [L('CONTAINER ID   IMAGE                    STATUS           PORTS                    NAMES', 'hdr')];
      for (const c of w.docker.containers) {
        if (!all && c.status !== 'running') continue;
        const upMin = w.nowMin - c.startedAtMin;
        const health = c.status === 'running' ? (c.healthy ? ' (healthy)' : ' (health: starting)') : '';
        lines.push(L(`${c.id.slice(0, 12)}   ${c.image.padEnd(24)} Up ${upMin} min${health.padEnd(10)} ${c.hostPort ? `0.0.0.0:${c.hostPort}->${c.containerPort}/tcp` : ''.padEnd(24)} ${c.name}`));
      }
      return { lines, code: 0 };
    }
    case 'images': {
      const lines = [L('REPOSITORY                       TAG       IMAGE ID       SIZE', 'hdr')];
      for (const img of w.docker.images) {
        const [repo2, tag] = splitTag(img.repoTags[0]);
        lines.push(L(`${repo2.padEnd(32)} ${tag.padEnd(9)} ${img.id.slice(7, 19)}   ${img.sizeMB}MB`));
      }
      return { lines, code: 0 };
    }
    case 'logs': {
      const name = argv.filter((a) => !a.startsWith('-'))[2];
      const c = w.docker.containers.find((x) => x.name === name || x.id.startsWith(name ?? ''));
      if (!c) return { lines: [L(`Error: no such container: ${name}`, 'err')], code: 1 };
      return { lines: c.logs.slice(-25).map((t) => L(t)), code: 0 };
    }
    case 'stop': {
      const name = argv[2];
      const c = w.docker.containers.find((x) => x.name === name || x.id.startsWith(name ?? ''));
      if (!c) return { lines: [L(`Error response from daemon: No such container: ${name}`, 'err')], code: 1 };
      c.status = 'exited';
      if (c.serviceRef === 'api' && w.app.mode === 'container') w.app = { ...w.app, mode: 'stopped' };
      w.audit.push({ t: w.nowMin, actor: w.session.user, kind: 'deploy', text: `Stopped container ${c.name}` });
      return { lines: [L(c.name)], code: 0 };
    }
    case 'start': {
      const name = argv[2];
      const c = w.docker.containers.find((x) => x.name === name || x.id.startsWith(name ?? ''));
      if (!c) return { lines: [L(`Error: no such container: ${name}`, 'err')], code: 1 };
      c.status = 'running';
      c.startedAtMin = w.nowMin;
      if (c.serviceRef === 'api') w.app = { ...w.app, mode: 'container', image: c.image, uptimeSinceMin: w.nowMin };
      return { lines: [L(c.name)], code: 0 };
    }
    case 'rm': {
      const name = argv.filter((a) => !a.startsWith('-'))[2];
      const c = w.docker.containers.find((x) => x.name === name || x.id.startsWith(name ?? ''));
      if (!c) return { lines: [L(`Error: no such container: ${name}`, 'err')], code: 1 };
      if (c.status === 'running') return { lines: [L(`Error response from daemon: cannot remove container ${c.name}: container is running; stop it first`, 'err')], code: 1 };
      w.docker.containers = w.docker.containers.filter((x) => x !== c);
      return { lines: [L(c.name)], code: 0 };
    }
    case 'tag': {
      const [src, dst] = argv.slice(2);
      const img = w.docker.images.find((i) => i.repoTags.includes(src ?? ''));
      if (!img) return { lines: [L(`Error response from daemon: No such image: ${src}`, 'err')], code: 1 };
      img.repoTags.push(dst);
      return { lines: [], code: 0 };
    }
    case 'push': {
      const tag = argv[2];
      return { lines: pushToRegistry(w, tag ?? ''), code: 0 };
    }
    case 'pull': {
      const tag = argv[2];
      const img = w.registry.find((i) => i.repoTags.includes(tag ?? ''));
      if (!img) return { lines: [L(`Error response from daemon: pull access denied for ${tag}, repository does not exist`, 'err')], code: 1 };
      worldPush(w, img, tag!);
      return { lines: [L(`${tag}: Pulling from registry`, 'dim'), L(`Digest: sha256:${hashStr(tag ?? '').slice(0, 24)}`, 'dim'), L(`Status: Downloaded newer image for ${tag}`, 'ok')], code: 0 };
    }
    case 'inspect': {
      const name = argv[2];
      const c = w.docker.containers.find((x) => x.name === name || x.id.startsWith(name ?? ''));
      if (!c) return { lines: [L(`Error: No such object: ${name}`, 'err')], code: 1 };
      return { lines: [L(JSON.stringify({ State: { Status: c.status, Health: c.healthy ? 'healthy' : 'starting' }, Config: { Image: c.image, Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`) }, NetworkSettings: { Ports: c.hostPort ? { [`8080/tcp`]: [{ HostPort: String(c.hostPort) }] } : {} } }, null, 2))], code: 0 };
    }
    case 'version': return { lines: [L('Docker version 24.0.7 (simulated runtime)')], code: 0 };
    case 'exec': return { lines: [L('docker exec is limited in this environment — use docker logs and the app endpoints.', 'warn')], code: 1 };
    default: return { lines: [L(`docker: '${sub ?? ''}' is not a docker command.`, 'err')], code: 1 };
  }
}

function worldPush(w: World, img: import('../types').DockerImage, tag: string): void {
  const exists = w.docker.images.find((i) => i.repoTags.includes(tag));
  if (!exists) w.docker.images.push({ ...img, repoTags: [tag] });
}

function splitTag(full: string): [string, string] {
  const i = full.lastIndexOf(':');
  if (i === -1 || full.slice(i).includes('/')) return [full, 'latest'];
  return [full.slice(0, i), full.slice(i + 1)];
}

// Dockerfile inspection used by validators
export function inspectDockerfile(world: World, path = '/opt/app/Dockerfile'): ReturnType<typeof parseDockerfile> | null {
  const f = fs.getFile(world.hosts['web-01'].fs, path);
  if (!f) return null;
  return parseDockerfile(f.content);
}

export { GITIGNORE_DEFAULT };
