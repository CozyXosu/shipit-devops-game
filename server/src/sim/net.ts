// In-sim networking: DNS resolution + HTTP requests that travel through the
// simulated world (curl -> DNS table -> host -> nginx config -> app).
import { World, SimHost } from '../types';
import { getDir, getFile, listDir } from './fs';

export interface HttpResult {
  ok: boolean; // request reached something
  status?: number;
  statusText?: string;
  headers?: string[];
  body?: string;
  error?: string; // curl-style error text
  timeMs: number;
}

export interface NginxSite {
  file: string;
  listen: number;
  serverName: string;
  proxyPass?: string; // http://127.0.0.1:8080
  root?: string;
}

export function resolveHostname(world: World, hostname: string): { kind: 'session' } | { kind: 'host'; host: SimHost } | { kind: 'lb' } | { kind: 'nxdomain'; error: string } {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return { kind: 'session' };
  if (world.lb?.provisioned && (world.lb.ip === hostname)) return { kind: 'lb' };
  for (const h of Object.values(world.hosts)) {
    if (h.ip === hostname) return { kind: 'host', host: h };
  }
  for (const zone of Object.keys(world.dns)) {
    const rec = world.dns[zone][hostname];
    if (rec && rec.type === 'A') {
      if (world.lb?.provisioned && world.lb.ip === rec.value) return { kind: 'lb' };
      for (const h of Object.values(world.hosts)) {
        if (h.ip === rec.value) return { kind: 'host', host: h };
      }
    }
  }
  return { kind: 'nxdomain', error: `curl: (6) Could not resolve host: ${hostname}` };
}

/** Containers running on a given host ('web-01' is the default for older saves). */
export function containersOn(world: World, hostId: string, port: number): typeof world.docker.containers {
  return world.docker.containers.filter((c) => (c.hostId ?? 'web-01') === hostId && c.status === 'running' && c.hostPort === port);
}

/** Is the API currently served from this host (systemd service or container on :8080)? */
export function hostServesApi(world: World, hostId: string): boolean {
  const h = world.hosts[hostId];
  if (!h) return false;
  const svc = h.services['api'];
  if (svc && svc.state === 'active') return true;
  return containersOn(world, hostId, 8080).length > 0;
}

/**
 * Backends the LB can route to, in order. A backend is usable when its host
 * actually serves the app; `healthy` additionally excludes hosts that are down.
 */
export function lbBackends(world: World): { id: string; healthy: boolean }[] {
  if (!world.lb?.provisioned) return [];
  const out: { id: string; healthy: boolean }[] = [];
  for (const hostId of ['web-01', 'vm-02']) {
    if (!hostServesApi(world, hostId)) continue;
    const down = hostId === 'web-01' && Boolean(world.flags.web01Down);
    out.push({ id: hostId, healthy: !down });
  }
  return out;
}

/** Parse nginx configs from a host's /etc/nginx/sites-enabled/*.conf */
export function parseNginxSites(host: SimHost): NginxSite[] {
  const sites: NginxSite[] = [];
  const dir = getDir(host.fs, '/etc/nginx/sites-enabled');
  if (!dir) return sites;
  for (const { name, node } of listDir(dir, '') ?? []) {
    if (node.type !== 'file') continue;
    const text = node.content;
    const site: NginxSite = { file: name, listen: 80, serverName: '_' };
    const listenM = /listen\s+(\d+)/.exec(text);
    if (listenM) site.listen = parseInt(listenM[1], 10);
    const nameM = /server_name\s+([^;]+);/.exec(text);
    if (nameM) site.serverName = nameM[1].trim().split(/\s+/)[0];
    const proxyM = /proxy_pass\s+(https?:\/\/[^;]+);/.exec(text);
    if (proxyM) site.proxyPass = proxyM[1];
    const rootM = /root\s+([^;]+);/.exec(text);
    if (rootM) site.root = rootM[1];
    sites.push(site);
  }
  return sites;
}

export function listenersOn(host: SimHost, port: number): { kind: 'service'; name: string } | { kind: 'container'; name: string } | { kind: 'process'; pid: number; cmd: string } | null {
  for (const s of Object.values(host.services)) {
    if (s.state === 'active' && s.port === port) return { kind: 'service', name: s.name };
  }
  // containers (containers run on their host; we keep one host for the slice)
  return null;
}

function appResponse(world: World, path: string, host: SimHost): HttpResult {
  const headers = ['Server: node/20', 'Content-Type: application/json'];
  const app = world.app;
  const healthy = app.mode !== 'stopped';
  if (!healthy) {
    return { ok: false, error: 'curl: (7) Failed to connect: connection refused by target', timeMs: 1 };
  }
  const upSec = app.uptimeSinceMin != null ? Math.max(0, (world.nowMin - app.uptimeSinceMin) * 60) : 0;
  if (path === '/' || path === '/health') {
    return {
      ok: true, status: 200, statusText: 'OK', headers,
      body: JSON.stringify({ status: 'ok', service: world.company.slug + '-api', version: app.version, uptimeSec: upSec, database: app.database }, null, 2),
      timeMs: 8
    };
  }
  // API routes degrade when error sources are active
  const errorSources = countErrorSources(world);
  if (errorSources > 0) {
    const fail = (hash(path + Math.floor(world.nowMin / 3)) % 100) < 35 + errorSources * 10;
    if (fail) {
      return {
        ok: true, status: 500, statusText: 'Internal Server Error', headers,
        body: JSON.stringify({ error: 'internal server error', requestId: hash(path + String(world.nowMin)).toString(16) }),
        timeMs: 900 + (hash(path) % 800)
      };
    }
    return {
      ok: true, status: 200, statusText: 'OK', headers,
      body: JSON.stringify({ data: [], slow: errorSources > 0 }), timeMs: 600 + (hash(path) % 500)
    };
  }
  return {
    ok: true, status: 200, statusText: 'OK', headers,
    body: JSON.stringify({ data: [{ id: 1, name: 'example' }] }), timeMs: 24
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

export function countErrorSources(world: World): number {
  let n = 0;
  const diskPct = diskUsagePct(world);
  if (diskPct >= 99.5) n += 2; // ENOSPC
  if (world.flags.badDeployBug) n += 3;
  if (world.db.provisioned && world.db.cpuPct > 90 && !world.flags.indexFixApplied) n += 1;
  return n;
}

export function diskUsagePct(world: World): number {
  const host = world.hosts['web-01'];
  if (!host) return 0;
  return (host.diskUsedBaseMB + logVolumeMB(world)) / host.diskTotalMB * 100;
}

export function logVolumeMB(world: World): number {
  return world.flags.logrotateConfigured ? 52 : Math.min(40000, Math.max(0, world.nowMin - Number(world.flags.logStartMin ?? 0)) * 0.12);
}

/** Perform an HTTP request inside the simulation. */
export function httpRequest(world: World, rawUrl: string, opts: { headOnly?: boolean; method?: string } = {}): HttpResult {
  let url = rawUrl;
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  let m = /^https?:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) return { ok: false, error: `curl: (3) URL rejected: ${rawUrl}`, timeMs: 0 };
  const [, hostname, portStr, path = '/'] = m;
  const port = portStr ? parseInt(portStr, 10) : 80;

  if (hostname === 'registry.acme.dev') {
    return { ok: true, status: 200, statusText: 'OK', headers: ['Server: registry/2.0'], body: '{}', timeMs: 15 };
  }

  const resolved = resolveHostname(world, hostname);
  if (resolved.kind === 'nxdomain') return { ok: false, error: resolved.error, timeMs: 12 };

  // load balancer: pick a healthy backend (rotate by sim minute), forward there
  if (resolved.kind === 'lb') {
    const backends = lbBackends(world);
    if (!backends.length) {
      return { ok: true, status: 502, statusText: 'Bad Gateway', headers: ['Server: lb/2.0'], body: '<html><body><h1>502: no healthy backends</h1></body></html>', timeMs: 8 };
    }
    const healthy = backends.filter((b) => b.healthy);
    if (!healthy.length) {
      return { ok: true, status: 503, statusText: 'Service Unavailable', headers: ['Server: lb/2.0'], body: '<html><body><h1>503: all backends down</h1></body></html>', timeMs: 8 };
    }
    const chosen = healthy[world.nowMin % healthy.length];
    const res = appResponse(world, path, world.hosts[chosen.id]);
    if (res.ok && res.headers) res.headers = ['Server: lb/2.0', 'X-Backend: ' + chosen.id, ...res.headers];
    return res;
  }

  const host = resolved.kind === 'session' ? world.hosts[world.session.hostId] : resolved.host;
  if (!host) return { ok: false, error: 'curl: (7) no route to host', timeMs: 5 };
  // a downed host refuses connections outright
  if (host.id === 'web-01' && world.flags.web01Down) {
    return { ok: false, error: `curl: (7) Failed to connect to ${hostname} port ${port}: Connection refused (host down)`, timeMs: 2 };
  }

  // what is listening on that port?
  for (const s of Object.values(host.services)) {
    if (s.state === 'active' && s.port === port) {
      if (s.name === 'nginx') {
        const sites = parseNginxSites(host);
        const site = sites.find((x) => x.listen === port);
        if (site && site.proxyPass) {
          const pm = /^https?:\/\/[^/]+(?::(\d+))?/.exec(site.proxyPass);
          const upstreamPort = pm && pm[1] ? parseInt(pm[1], 10) : 80;
          return proxyRequest(world, host, upstreamPort, path);
        }
        return { ok: true, status: 200, statusText: 'OK', headers: ['Server: nginx'], body: '<html><body>Welcome to nginx!</body></html>', timeMs: 5 };
      }
      if (s.name === 'api') return appResponse(world, path, host);
    }
  }
  // containers on this host
  const cont = containersOn(world, host.id, port)[0];
  if (cont) return appResponse(world, path, host);

  // plain processes (e.g. the stale legacy server)
  const proc = host.processes.find((p) => p.port === port && p.state !== 'zombie');
  if (proc) {
    if (proc.cmd.includes('legacy-server')) {
      return { ok: true, status: 200, statusText: 'OK', headers: ['Server: legacy'], body: JSON.stringify({ status: 'ok', legacy: true }), timeMs: 40 };
    }
    return appResponse(world, path, host);
  }

  return { ok: false, error: `curl: (7) Failed to connect to ${hostname} port ${port} after 2 ms: Connection refused`, timeMs: 2 };
}

function proxyRequest(world: World, host: SimHost, upstreamPort: number, path: string): HttpResult {
  const api = host.services['api'];
  const apiUp = api && api.state === 'active';
  const cont = world.docker.containers.find((c) => c.status === 'running' && c.hostPort === upstreamPort);
  if (!apiUp && !cont) {
    return { ok: true, status: 502, statusText: 'Bad Gateway', headers: ['Server: nginx'], body: '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>', timeMs: 6 };
  }
  const res = appResponse(world, path, host);
  if (res.ok && res.headers) res.headers = ['Server: nginx', ...res.headers.filter((h) => !h.startsWith('Server:'))];
  return res;
}

export function formatCurl(res: HttpResult, headOnly: boolean): string[] {
  if (!res.ok) return [res.error ?? 'curl: (7) request failed'];
  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${res.status} ${res.statusText}`);
  for (const h of res.headers ?? []) lines.push(h);
  if (!headOnly) {
    lines.push('');
    lines.push(...(res.body ?? '').split('\n'));
  }
  return lines;
}

/** DNS lookup used by `dig`. */
export function digLookup(world: World, name: string): string[] {
  for (const zone of Object.keys(world.dns)) {
    if (name === zone || world.dns[zone][name]) {
      const rec = world.dns[zone][name] ?? world.dns[zone][zone];
      if (rec) {
        return [
          `; <<>> DiG 9.18 <<>> ${name}`,
          ';; ANSWER SECTION:',
          `${name}.			${rec.ttl}	IN	${rec.type}	${rec.value}`,
          '',
          `;; Query time: 12 msec`,
          ';; WHEN: sim-time'
        ];
      }
    }
  }
  return [`; <<>> DiG 9.18 <<>> ${name}`, ';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN', ';; QUESTION SECTION:', `;${name}.			IN	A`, '', ';; no servers could be reached'];
}
