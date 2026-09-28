// Mission data — the game curriculum. Requirements are code checks over WORLD
// STATE (not clicks), hints are progressive, rewards feed the economy/skills.
import { World } from '../types';
import * as fs from '../sim/fs';
import { inspectDockerfile } from '../sim/host';
import { status as gitStatus, isIgnored } from '../sim/git';
import { parseNginxSites, httpRequest, hostServesApi } from '../sim/net';
import { analyzeStages, loadPipeline, hasPreviewStep } from '../sim/ci';
import { diskUsagePct, audit, sloReport, ensureCloud, ensureProducts, productMrrOf, baseMrrOf, setFinopsBaseline, monthlyInfraCost, complianceFindings, dueDiligence } from '../world';

export interface Requirement { id: string; label: string; check: (w: World) => boolean }

export interface MissionDef {
  id: string;
  index: number;
  title: string;
  phase: 'build' | 'operate' | 'ecosystem' | 'bonus' | 'trust' | 'platform';
  story: string;
  objective: string;
  coaching: string;
  skills: string[];
  requirements: Requirement[];
  hints: string[];
  lesson?: Lesson;
  rewards: { cash: number; xp: Record<string, number>; tournamentPoints?: number };
  onStart?: (w: World) => void;
  onComplete?: (w: World) => void;
}

// ---------- helper shorthands ----------
const f = (w: World, path: string) => fs.getFile(w.hosts['web-01'].fs, path);
const read = (w: World, path: string) => fs.readFile(w.hosts['web-01'].fs, path);
const svc = (w: World, name: string) => w.hosts['web-01'].services[name];
const dirExists = (w: World, path: string) => Boolean(fs.getDir(w.hosts['web-01'].fs, path));

function domain(w: World): string { return `${w.company.slug}.dev`; }
function apiDomain(w: World): string { return `api.${w.company.slug}.dev`; }

function configJsNoSecret(w: World): boolean {
  const content = read(w, '/opt/app/config.js') ?? '';
  return content.includes('process.env.DB_PASSWORD') && !content.includes('b1gmeter-prod-2024');
}

function nginxProxySite(w: World): string | null {
  for (const site of parseNginxSites(w.hosts['web-01'])) {
    if (site.proxyPass && site.proxyPass.includes('8080')) return site.file;
  }
  return null;
}

function lastRun(w: World) { return w.ci.runs[w.ci.runs.length - 1]; }

function missionApiContainer(w: World): boolean {
  return w.docker.containers.some((c) => c.status === 'running' && c.hostPort === 8080 && (c.serviceRef === 'api' || c.name.toLowerCase().includes('api') || c.image.toLowerCase().includes('api')));
}

// =====================================================================
// MISSIONS
// =====================================================================
import { k8sServes, imageSigned } from '../sim/k8s';
import { LESSONS, Lesson } from './lessons';

export const MISSIONS: MissionDef[] = [
  // -------------------------------------------------------- 1
  {
    id: 'm01-ssh',
    index: 1,
    title: 'Day One: the handoff note',
    phase: 'build',
    story: 'You just joined as the first platform hire. Jordan (founder) left a handoff note on your laptop. The API is down and there is a customer demo at 10:30. Everything the company has lives on one server.',
    objective: `Read the handoff note on your laptop, then SSH into the company server.`,
    coaching: 'The terminal starts on YOUR laptop. `ls` to find the note, `cat` to read it, then use `ssh user@host`.',
    skills: ['linux'],
    requirements: [
      { id: 'note-read', label: 'Read the handoff note (cat handoff.txt)', check: (w) => Boolean(w.flags.readHandoff) },
      { id: 'ssh-in', label: 'SSH into web-01 as dev', check: (w) => w.session.hostId === 'web-01' && w.session.user === 'dev' }
    ],
    hints: [
      'Files in the current directory: run `ls` to see them.',
      '`cat handoff.txt` prints the note. It contains the server address and username.',
      'Type: ssh dev@203.0.113.10 — then type anything as the password.'
    ],
    rewards: { cash: 500, xp: { linux: 20 } }
  },
  // -------------------------------------------------------- 2
  {
    id: 'm02-dead-api',
    index: 2,
    title: 'The case of the dead API',
    phase: 'build',
    story: 'You are in. The api.service unit exists but the app is not answering. The previous dev left notes in ~/notes.txt. Systemd says the service failed at boot.',
    objective: 'Find out WHY the API is down, make it start, and make it survive reboots. Verify with curl.',
    coaching: 'Classic trio: `journalctl -u api` (why it failed), `ps aux` + `ss -tulpn` (who owns :8080), `systemctl start/enable api`. When you find the culprit, `kill <PID>` it.',
    skills: ['linux', 'observability'],
    requirements: [
      { id: 'svc-active', label: 'api.service is active', check: (w) => svc(w, 'api')?.state === 'active' },
      { id: 'svc-enabled', label: 'api.service is enabled (starts on boot)', check: (w) => Boolean(svc(w, 'api')?.enabled) },
      { id: 'port-listening', label: 'Something healthy answers on :8080', check: (w) => {
        const res = httpRequest(w, 'http://localhost:8080/health');
        return res.ok && res.status === 200;
      } },
      { id: 'stale-gone', label: 'The stale legacy process is gone', check: (w) => !w.hosts['web-01'].processes.some((p) => p.cmd.includes('legacy-server') && p.state !== 'zombie') }
    ],
    hints: [
      'Ask systemd what happened: `journalctl -u api -n 10`. The last error line is the whole story.',
      '`ps aux` shows a process that should not be there, holding port 8080. `ss -tulpn` confirms which process owns a port.',
      'Kill the stale process: sudo kill 1024. Then: sudo systemctl start api && sudo systemctl enable api. Check: curl localhost:8080/health'
    ],
    rewards: { cash: 1000, xp: { linux: 30, observability: 10 } }
  },
  // -------------------------------------------------------- 3
  {
    id: 'm03-permissions',
    index: 3,
    title: 'Root cause: permissions',
    phase: 'build',
    story: 'A security review flags that the API runs as root — a bug in the app would own the whole box. The app only needs to run as the dev user.',
    objective: 'Run the API as a non-root user: change the unit file (User=), fix file ownership, and restart the service.',
    coaching: 'Edit /etc/systemd/system/api.service in the EDITOR tab (set User=dev). Take ownership of the app: chown -R dev:dev /opt/app. Then daemon-reload and restart.',
    skills: ['linux', 'security'],
    requirements: [
      { id: 'unit-user', label: 'api.service unit sets User=dev (not root)', check: (w) => {
        const unit = read(w, '/etc/systemd/system/api.service') ?? '';
        return /User\s*=\s*dev\s*$/m.test(unit);
      } },
      { id: 'app-owned', label: '/opt/app is owned by dev', check: (w) => {
        const node = fs.getNode(w.hosts['web-01'].fs, '/opt/app/server.js');
        return node?.owner === 'dev';
      } },
      { id: 'svc-active', label: 'api.service restarted and active as dev', check: (w) => svc(w, 'api')?.state === 'active' && svc(w, 'api')?.user === 'dev' }
    ],
    hints: [
      'Open the EDITOR tab, browse to /etc/systemd/system/api.service and change `User=root` to `User=dev`.',
      'The app files still belong to root: sudo chown -R dev:dev /opt/app gives them to the dev user.',
      'After editing a unit file: sudo systemctl daemon-reload && sudo systemctl restart api. Verify: systemctl status api'
    ],
    rewards: { cash: 1000, xp: { linux: 20, security: 30 } }
  },
  // -------------------------------------------------------- 4
  {
    id: 'm04-nginx',
    index: 4,
    title: 'The front door',
    phase: 'build',
    story: 'Customers should not talk to your app process on a weird port — and the app must never run privileged itself. Time for a reverse proxy on :80.',
    objective: 'Install nginx, proxy port 80 → 127.0.0.1:8080, open port 80 in the firewall, and make nginx start on boot.',
    coaching: 'sudo apt-get install -y nginx. Write a site config in /etc/nginx/sites-enabled/acme.conf with a server block (listen 80; proxy_pass http://127.0.0.1:8080;). Test: nginx -t... then start it. Open the firewall: ufw allow 80/tcp.',
    skills: ['networking', 'linux'],
    requirements: [
      { id: 'nginx-installed', label: 'nginx is installed', check: (w) => w.hosts['web-01'].packages.includes('nginx') },
      { id: 'site-conf', label: 'A site config proxies to 127.0.0.1:8080', check: (w) => nginxProxySite(w) !== null },
      { id: 'nginx-active', label: 'nginx service is running', check: (w) => svc(w, 'nginx')?.state === 'active' },
      { id: 'fw-80', label: 'Port 80 is reachable (firewall)', check: (w) => w.firewall.allowedPorts.includes(80) },
      { id: 'curl-80', label: 'curl http://localhost/ reaches the API', check: (w) => {
        const res = httpRequest(w, 'http://localhost/');
        return res.ok && res.status === 200;
      } }
    ],
    hints: [
      'Install: sudo apt-get install -y nginx. nginx ships with a default site in /etc/nginx/sites-enabled/default.',
      'Create /etc/nginx/sites-enabled/acme.conf via the EDITOR:',
      'server {\n  listen 80;\n  server_name _;\n  location / {\n    proxy_pass http://127.0.0.1:8080;\n  }\n}\nThen: sudo systemctl enable nginx && sudo systemctl start nginx && sudo ufw allow 80/tcp'
    ],
    rewards: { cash: 1500, xp: { networking: 40, linux: 10 } }
  },
  // -------------------------------------------------------- 5
  {
    id: 'm05-dns',
    index: 5,
    title: "What's in a name?",
    phase: 'build',
    story: `Nobody types IP addresses. The company owns the zone ${'{domain}'} — point api.${'{domain}'} at the server so customers get a real URL.`,
    objective: 'In the CLOUD console → DNS, add an A record: api → 203.0.113.10. Verify with dig and curl.',
    coaching: 'DNS records live in the cloud console (CLOUD tab → DNS). Then `dig +short api.{domain}` and `curl http://api.{domain}/health` should both work — try them from your laptop (type `exit` first).',
    skills: ['networking'],
    requirements: [
      { id: 'a-record', label: 'A record api → 203.0.113.10 exists', check: (w) => w.dns[domain(w)]?.[apiDomain(w)]?.value === '203.0.113.10' },
      { id: 'resolves', label: 'dig resolves the name', check: (w) => Boolean(w.dns[domain(w)]?.[apiDomain(w)]) },
      { id: 'curl-domain', label: 'curl http://api.<domain>/health works from the laptop', check: (w) => {
        const res = httpRequest(w, `http://${apiDomain(w)}/health`);
        return res.ok && res.status === 200;
      } }
    ],
    hints: [
      'Open the CLOUD tab (left sidebar) → DNS section.',
      'Add record: name "api", type A, value 203.0.113.10, TTL 300.',
      'Test from outside: type `exit` in the terminal to get back to your laptop, then `dig +short api.' + '{domain}' + '` and `curl http://api.' + '{domain}' + '/health`.'
    ],
    rewards: { cash: 1500, xp: { networking: 30, cloud: 10 } }
  },
  // -------------------------------------------------------- 6
  {
    id: 'm06-git',
    index: 6,
    title: 'Version control or chaos',
    phase: 'build',
    story: 'The app directory is not a git repository. One bad `rm` and the company is over. Time for version control.',
    objective: 'Turn /opt/app into a git repo, configure your identity, add a .gitignore, and make a first commit.',
    coaching: 'git init, then git config user.name / user.email (git refuses to commit without them). Create .gitignore (node_modules/, .env, *.log). git add -A, git commit -m "..."',
    skills: ['git'],
    requirements: [
      { id: 'repo', label: '/opt/app is a git repository', check: (w) => Boolean(w.git['/opt/app']) },
      { id: 'identity', label: 'git identity configured', check: (w) => Boolean(w.session.env.GIT_AUTHOR_NAME && w.session.env.GIT_AUTHOR_EMAIL) },
      { id: 'gitignore', label: '.gitignore exists and is committed', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        const head = repo.branches[repo.head]?.commit;
        return Boolean(head && repo.commits[head]?.tree['.gitignore'] !== undefined);
      } },
      { id: 'commit', label: 'At least one commit exists', check: (w) => Object.keys(w.git['/opt/app']?.commits ?? {}).length >= 1 },
      { id: 'clean', label: 'Working tree is clean', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        const s = gitStatus(w, repo);
        return s.staged.length === 0 && s.unstaged.length === 0 && s.untracked.length === 0;
      } }
    ],
    hints: [
      'cd /opt/app && git init. Git needs to know who you are: git config user.name "You" && git config user.email "you@' + '{domain}' + '"',
      'Create .gitignore (EDITOR tab) with: node_modules/  .env  *.log — then `git add -A`.',
      'git commit -m "initial import of api source" — then `git status` should say "working tree clean".'
    ],
    rewards: { cash: 1500, xp: { git: 40 } }
  },
  // -------------------------------------------------------- 7
  {
    id: 'm07-branch',
    index: 7,
    title: 'Branches & the merge conflict',
    phase: 'build',
    story: 'A partner integration needs API_TIMEOUT=60. Work on a feature branch — and watch out: your teammate Jaime pushes to main while you work.',
    objective: 'Create a feature branch, change apiTimeout to 60 in config.js, commit, then merge with main (Jaime pushed a change to the same file). Resolve the conflict properly.',
    coaching: 'git checkout -b feature/timeout → edit config.js → git add + commit → git merge main (or pull). Git will stop on the conflict: open the file in the EDITOR, keep BOTH teammates\' intent (apiTimeout: 60 AND retryMax: 5), remove the markers, git add, git commit.',
    skills: ['git'],
    requirements: [
      { id: 'branch', label: 'A feature branch was created', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        return Object.keys(repo.branches).some((b) => b !== 'main');
      } },
      { id: 'commit-feature', label: 'The timeout change was committed on the branch', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        return Object.values(repo.commits).some((c) => (c.tree['config.js'] ?? '').includes('apiTimeout: 60'));
      } },
      { id: 'conflict-resolved', label: 'Conflict resolved: no markers, both changes kept', check: (w) => {
        const c = read(w, '/opt/app/config.js') ?? '';
        return !c.includes('<<<<<<<') && /apiTimeout:\s*60/.test(c) && /retryMax:\s*5/.test(c);
      } },
      { id: 'merged', label: 'Merged into main (merge commit with 2 parents)', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        const head = repo.branches['main']?.commit;
        return Boolean(head && repo.commits[head].parents.length >= 2);
      } },
      { id: 'clean', label: 'Working tree clean on main', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        const s = gitStatus(w, repo);
        return repo.head === 'main' && s.staged.length === 0 && s.unstaged.length === 0 && s.untracked.length === 0;
      } }
    ],
    hints: [
      'git checkout -b feature/api-timeout, then edit config.js: apiTimeout: 60. git add config.js && git commit -m "raise timeout for partner API".',
      'Bring in the teammate: git pull origin main. Git prints CONFLICT (content): Merge conflict in config.js — the file now contains <<<<<<< / ======= / >>>>>>> markers.',
      'In the EDITOR keep the lines you need so it reads: apiTimeout: 60, retryMax: 5 — no markers left. Then: git add config.js && git commit (completes the merge), then git checkout main && git merge feature/api-timeout.'
    ],
    rewards: { cash: 2000, xp: { git: 50 } },
    onStart: (w) => {
      // Jaime pushed a commit to ORIGIN/main (not local main) touching the same file
      const repo = w.git['/opt/app'];
      if (!repo) return;
      const base = repo.branches['main']?.commit;
      const content = (read(w, '/opt/app/config.js') ?? '').replace('apiTimeout: 30', 'apiTimeout: 45').replace('retryMax: 3', 'retryMax: 5');
      const sha = 'jaime' + Math.abs(Math.floor(Math.sin(w.nowMin) * 1e6)).toString(16).slice(0, 4);
      repo.commits[sha] = {
        sha, message: 'bump retryMax, lower api timeout (Jaime)',
        parents: base ? [base] : [], author: 'jaime', email: 'jaime@acme.dev',
        timeMin: w.nowMin, tree: { 'config.js': content }, changed: ['config.js']
      };
      repo.remoteBranches['origin/main'] = sha;
      repo.remotes['origin'] = 'git@acme.dev:acme/api.git';
    }
  },
  // -------------------------------------------------------- 8
  {
    id: 'm08-secrets',
    index: 8,
    title: "Secrets don't belong in code",
    phase: 'build',
    story: 'You trip over a production password hard-coded in config.js — committed to history, visible to every future contractor. Fix the pattern, not just the value.',
    objective: 'Move the DB password into /opt/app/.env, make config.js read it from the environment, keep .env out of git, and restart the service with the env file.',
    coaching: 'Create .env (EDITOR): DB_PASSWORD=b1gmeter-prod-2024. Rewrite config.js to use process.env.DB_PASSWORD. Ensure .gitignore covers .env. Add EnvironmentFile=/opt/app/.env to the unit, daemon-reload, restart.',
    skills: ['security', 'linux'],
    requirements: [
      { id: 'env-file', label: '/opt/app/.env exists with DB_PASSWORD', check: (w) => Boolean(f(w, '/opt/app/.env')?.content.includes('DB_PASSWORD=')) },
      { id: 'config-clean', label: 'config.js uses process.env.DB_PASSWORD (secret removed)', check: configJsNoSecret },
      { id: 'env-ignored', label: '.env is ignored by git (not tracked)', check: (w) => {
        const repo = w.git['/opt/app'];
        if (!repo) return false;
        const head = repo.branches[repo.head]?.commit;
        if (head && repo.commits[head].tree['.env'] !== undefined) return false;
        return isIgnored(repo, w, '.env');
      } },
      { id: 'service-env', label: 'Service restarted with EnvironmentFile=/opt/app/.env', check: (w) => {
        const unit = read(w, '/etc/systemd/system/api.service') ?? '';
        return unit.includes('EnvironmentFile=/opt/app/.env');
      } }
    ],
    hints: [
      'EDITOR → /opt/app/.env (new file): DB_PASSWORD=b1gmeter-prod-2024',
      'EDITOR → /opt/app/config.js: replace the password line with `dbPassword: process.env.DB_PASSWORD,`',
      'Add `EnvironmentFile=/opt/app/.env` under [Service] in the unit file, then: sudo systemctl daemon-reload && sudo systemctl restart api. Check .gitignore contains .env'
    ],
    rewards: { cash: 2000, xp: { security: 50, git: 10 } }
  },
  // -------------------------------------------------------- 9
  {
    id: 'm09-docker',
    index: 9,
    title: 'Ship it in a box',
    phase: 'build',
    story: 'Works-on-my-machine is not a deployment strategy. The board has heard the word "containers" and would like some.',
    objective: 'Install Docker, write a production-grade Dockerfile (non-root USER, EXPOSE 8080, HEALTHCHECK), build it, and run the API as a container on :8080 (the systemd service must be stopped).',
    coaching: 'apt-get install -y docker.io. Write /opt/app/Dockerfile. Build: docker build -t acme/api:v1 . — run: docker run -d --name api -p 8080:8080 acme/api:v1. The port is still held by the systemd service — stop it first (sudo systemctl stop api).',
    skills: ['docker'],
    requirements: [
      { id: 'docker-installed', label: 'Docker installed', check: (w) => w.hosts['web-01'].packages.includes('docker.io') },
      { id: 'dockerfile', label: '/opt/app/Dockerfile exists', check: (w) => Boolean(f(w, '/opt/app/Dockerfile')) },
      { id: 'non-root', label: 'Dockerfile uses a non-root USER', check: (w) => {
        const df = inspectDockerfile(w);
        return Boolean(df?.final?.user && df.final.user !== 'root' && !df.final.user.startsWith('root'));
      } },
      { id: 'expose', label: 'Dockerfile EXPOSEs 8080', check: (w) => Boolean(inspectDockerfile(w)?.final?.expose.includes(8080)) },
      { id: 'healthcheck', label: 'Dockerfile has a HEALTHCHECK', check: (w) => Boolean(inspectDockerfile(w)?.final?.healthcheck) },
      { id: 'image-built', label: 'Image built', check: (w) => w.docker.images.length > 0 },
      { id: 'container-running', label: 'API container running on :8080', check: missionApiContainer },
      { id: 'service-stopped', label: 'The systemd api service is stopped', check: (w) => svc(w, 'api')?.state !== 'active' },
      { id: 'healthy', label: 'Container reports healthy', check: (w) => w.docker.containers.some((c) => c.status === 'running' && c.healthy) }
    ],
    hints: [
      'Install: sudo apt-get install -y docker.io. Then write /opt/app/Dockerfile in the EDITOR. Start from node:20-alpine.',
      'A solid Dockerfile:\nFROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install --omit=dev\nUSER node\nEXPOSE 8080\nHEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1\nCMD ["node", "server.js"]',
      'sudo systemctl stop api, then: docker build -t acme/api:v1 . && docker run -d --name api -p 8080:8080 acme/api:v1. Check: docker ps (healthy after ~2 min sim time)'
    ],
    rewards: { cash: 2500, xp: { docker: 60 } }
  },
  // -------------------------------------------------------- 10
  {
    id: 'm10-ci',
    index: 10,
    title: 'Robots deploy on Fridays too',
    phase: 'build',
    story: 'Deploying by hand from a SSH session at 23:00 is how Fridays die. The team agrees on a pipeline: test → build → docker → push → deploy.',
    objective: 'Write .ci/pipeline.yml in the repo (checkout, test, build, docker build, push, deploy), commit it, run it in the CI tab, and ship the image to production from the registry.',
    coaching: 'Pipeline YAML lives at /opt/app/.ci/pipeline.yml. Each step is `- name: …` with `run:` or `uses:`. Commit it, open the CI tab, press RUN PIPELINE. Deploy needs a pushed image tag (use registry.acme.dev/acme/api:…).',
    skills: ['cicd', 'docker'],
    requirements: [
      { id: 'pipeline-file', label: '.ci/pipeline.yml exists in the repo', check: (w) => Boolean(w.git['/opt/app'] && f(w, '/opt/app/.ci/pipeline.yml')) },
      { id: 'pipeline-valid', label: 'Pipeline has: checkout, test, build, docker build, push, deploy', check: (w) => {
        if (!w.git['/opt/app']) return false;
        const p = loadPipeline(w, '/opt/app', '.ci/pipeline.yml');
        if (!p.valid) return false;
        return analyzeStages(p).every((s) => s.present);
      } },
      { id: 'committed', label: 'Pipeline is committed', check: (w) => {
        const repo = w.git['/opt/app'];
        const head = repo?.branches[repo.head]?.commit;
        return Boolean(head && repo!.commits[head].tree['.ci/pipeline.yml'] !== undefined);
      } },
      { id: 'run-success', label: 'A CI run has completed successfully', check: (w) => lastRun(w)?.status === 'success' },
      { id: 'deployed', label: 'Image deployed from the registry', check: (w) => w.ci.deployments.some((d) => d.active && d.image.includes('registry.acme.dev')) }
    ],
    hints: [
      'Minimal viable pipeline (commit it): name: deploy\non: push\nsteps:\n  - name: checkout\n    uses: git/checkout\n  - name: test\n    run: npm test',
      '…continue with:\n  - name: build\n    run: npm run build\n  - name: docker_build\n    run: docker build -t registry.acme.dev/acme/api:v1 .\n  - name: push\n    run: docker push registry.acme.dev/acme/api:v1\n  - name: deploy\n    uses: sim/deploy',
      'git add .ci/pipeline.yml && git commit -m "add pipeline" — then CI tab → RUN PIPELINE. The deploy step ships the pushed image.'
    ],
    rewards: { cash: 3000, xp: { cicd: 60, docker: 10 } }
  },
  // -------------------------------------------------------- 11
  {
    id: 'm11-db',
    index: 11,
    title: 'The database moves out',
    phase: 'build',
    story: 'Launch week. The sqlite file on the same box as the app is the biggest risk left: one disk failure and the company data is gone. Move to a managed Postgres.',
    objective: 'Provision managed Postgres in the CLOUD console, run migrations (DATABASE tab), point the app at it via DATABASE_URL in .env, and redeploy the app with the new env.',
    coaching: 'CLOUD → Databases → provision (db.small). DATABASE tab → RUN MIGRATIONS. Add DATABASE_URL=postgresql://api:***@db-01.stratus.cloud:5432/bigmeter to /opt/app/.env. Recreate the container so it picks up the env (docker stop/rm + docker run --env-file .env, or push a CI run).',
    skills: ['databases', 'cloud'],
    requirements: [
      { id: 'provisioned', label: 'Managed Postgres provisioned', check: (w) => w.db.provisioned },
      { id: 'migrated', label: 'Migrations ran against Postgres', check: (w) => Boolean(w.db.migrationsDone) },
      { id: 'db-url', label: 'DATABASE_URL set in .env and loaded by the app', check: (w) => Boolean((w.app.env.DATABASE_URL ?? read(w, '/opt/app/.env') ?? '').includes('db-01.stratus.cloud')) },
      { id: 'sql-works', label: 'psql query against the managed DB works', check: (w) => w.db.provisioned && Boolean(w.db.tables['orders']) },
      { id: 'app-postgres', label: 'The running app reports database=postgres', check: (w) => {
        const res = httpRequest(w, 'http://localhost:8080/health');
        if (!res.ok || !res.body) return false;
        try { return JSON.parse(res.body).database === 'postgres'; } catch { return false; }
      } }
    ],
    hints: [
      'CLOUD tab → Managed databases → Provision db.small. It appears on the architecture map immediately.',
      'DATABASE tab → RUN MIGRATIONS moves the schema + data.',
      'EDITOR → /opt/app/.env, add: DATABASE_URL=postgresql://api:SECRET@db-01.stratus.cloud:5432/bigmeter — then find the running container (`docker ps`) and `docker stop <name>`, recreate with env: docker run -d --name api -p 8080:8080 --env-file /opt/app/.env registry.acme.dev/acme/api:v1'
    ],
    rewards: { cash: 3000, xp: { databases: 50, cloud: 20 } },
    onComplete: (w) => {
      w.company.launched = true;
      w.company.users = 1200;
      audit(w, 'system', 'game', 'LAUNCH: BigMeter dashboard is public. Users are arriving.');
    }
  },
  // -------------------------------------------------------- 12
  {
    id: 'm12-monitoring',
    index: 12,
    title: "If you can't measure it…",
    phase: 'build',
    story: 'Users exist now. The first outage report should come from YOU, not from a customer. Install the observability agent and define what "bad" means before it happens.',
    objective: 'Install the monitoring agent (CLOUD console), then create at least two alert rules in the MONITORING tab: error rate > 2% and one capacity signal (CPU, memory or disk).',
    coaching: 'CLOUD → Observability agent → Install. MONITORING → Alert rules → add: error_pct > 2, and cpu_pct > 85 (or disk_pct > 85). Alerts evaluate every simulated minute.',
    skills: ['observability'],
    requirements: [
      { id: 'agent', label: 'Observability agent installed', check: (w) => w.monitoring.agentInstalled },
      { id: 'error-alert', label: 'Alert rule: error_pct > 2 (or tighter)', check: (w) => w.monitoring.alertRules.some((r) => r.metric === 'error_pct' && r.threshold <= 5) },
      { id: 'cap-alert', label: 'Alert rule: a capacity signal (cpu/mem/disk ≤ 90)', check: (w) => w.monitoring.alertRules.some((r) => ['cpu_pct', 'mem_pct', 'disk_pct'].includes(r.metric) && r.threshold <= 90) }
    ],
    hints: [
      'CLOUD tab → Observability → INSTALL AGENT. Metrics appear in MONITORING instantly.',
      'MONITORING tab → Alert rules → New rule: metric error_pct, op >, threshold 2.',
      'Second rule: metric cpu_pct, op >, threshold 85. Watch the sparklines — they are live.'
    ],
    rewards: { cash: 2500, xp: { observability: 60 } },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'The platform is real now. The world will test it.');
    }
  },
  // -------------------------------------------------------- 13
  {
    id: 'm13-disk',
    index: 13,
    title: 'INCIDENT: the disk that ate the logs',
    phase: 'build',
    story: 'Watch the disk gauge. Logs on / are growing with no rotation in place. When it hits 100%, the API starts failing — and you get to live the pager life.',
    objective: 'When the incident fires: diagnose from real symptoms (df, du, journalctl, logs), free the space, configure logrotate so it cannot recur, then file the postmortem with corrective actions.',
    coaching: 'df -h shows the full disk. du -sh /var/log shows the culprit. Fix now: truncate/rotate old logs. Fix forever: /etc/logrotate.d/acme-api (EDITOR) with a weekly/rotate 7 policy. Then INCIDENTS → postmortem → tick the corrective actions.',
    skills: ['observability', 'linux', 'security'],
    requirements: [
      { id: 'logrotate', label: 'logrotate configured for /var/log/app.log', check: (w) => Boolean(w.flags.logrotateConfigured) },
      { id: 'disk-ok', label: 'Disk usage back under 85%', check: (w) => diskUsagePct(w) < 85 },
      { id: 'incident-opened', label: 'The disk incident fired (advance time if needed)', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'disk_full') },
      { id: 'incident-resolved', label: 'Incident resolved', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'disk_full' && i.status === 'resolved') },
      { id: 'postmortem', label: 'Postmortem filed with corrective actions', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'disk_full' && i.postmortemFiled) }
    ],
    hints: [
      'Is it happening yet? The TERMINAL answer: df -h. When Use% hits 100 the API starts throwing ENOSPC — check journalctl -u api.',
      'Free space now: sudo sh -c "echo \"\" > /var/log/app.log" (or rm old rotated logs) — the app recovers once the disk is under pressure level. Long term: EDITOR → /etc/logrotate.d/acme-api:\n/var/log/app.log {\n  daily\n  rotate 7\n  compress\n  missingok\n  notifempty\n}',
      'After disk < 85% and logrotate is active the incident auto-resolves. Then MONITORING → INCIDENTS → file postmortem → tick corrective actions.'
    ],
    rewards: { cash: 4000, xp: { observability: 40, linux: 20 } }
  },
  // -------------------------------------------------------- 14
  {
    id: 'm14-baddeploy',
    index: 14,
    title: 'INCIDENT: Friday deploy gone wrong',
    phase: 'build',
    story: 'Ship the next release through your own pipeline. What could go wrong? (Something will go wrong. That is the point.)',
    objective: 'Deploy the next release via CI. When error rate spikes: use metrics to confirm, roll back to the previous image, verify recovery, file the postmortem.',
    coaching: 'Run the pipeline (CI tab) as usual. When the incident opens: MONITORING shows error_pct spiking; CI → Deployments → Roll back to previous. Confirm error_pct < 1 again. Postmortem. Tick corrective actions.',
    skills: ['cicd', 'observability'],
    requirements: [
      { id: 'incident-fired', label: 'The bad-deploy incident fired (deploy the next release)', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'bad_deploy') },
      { id: 'rolled-back', label: 'Rolled back to the previous image', check: (w) => w.ci.deployments.some((d) => d.source === 'rollback') },
      { id: 'incident-resolved', label: 'Incident resolved (error rate recovered)', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'bad_deploy' && i.status === 'resolved') },
      { id: 'postmortem', label: 'Postmortem filed (≥2 corrective actions)', check: (w) => {
        const inc = w.monitoring.incidents.find((i) => i.kind === 'bad_deploy');
        return Boolean(inc?.postmortemFiled && inc.corrective.filter((c) => c.done).length >= 2);
      } }
    ],
    hints: [
      'Trigger: CI tab → RUN PIPELINE (the deploy step ships the release).',
      'Error rate spikes? MONITORING → INCIDENTS shows the open incident. CI tab → Deployments → ROLL BACK. The previous image takes over in seconds.',
      'Confirm error_pct back under 1 in MONITORING (advance time if needed), then file the postmortem with at least two corrective actions.'
    ],
    rewards: { cash: 5000, xp: { cicd: 30, observability: 30 } },
    onStart: (w) => {
      // the NEXT release ships with a regression — this is the incident
      w.flags.nextDeployHasBug = true;
    },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'INCIDENT CLOSED. Traffic keeps climbing — the platform is about to be tested again.');
    }
  },
  // -------------------------------------------------------- 15
  {
    id: 'm15-dbperf',
    index: 15,
    title: 'The index that saved the bill',
    phase: 'build',
    story: 'Product-market fit hit: users jumped ~6x and the orders query is suddenly the slowest path in the company. The managed database is running hot, and the error rate is creeping up with it. The board asks whether to buy a bigger database. A senior engineer asks whether the query is even indexed.',
    objective: 'Find the real bottleneck before spending money: EXPLAIN the hot query, add the missing index, and bring DB CPU back down at the new traffic level.',
    coaching: 'DATABASE tab → run: EXPLAIN ANALYZE SELECT * FROM orders WHERE status = \'paid\'; — read the plan. Then fix the root cause with CREATE INDEX (name it idx_orders_status) and watch the DB CPU metric recover.',
    skills: ['databases', 'observability'],
    requirements: [
      { id: 'investigated', label: 'Ran EXPLAIN on the orders query (see what the planner really does)', check: (w) => w.audit.some((a) => a.kind === 'db' && a.text.includes('EXPLAIN') && a.text.includes('orders')) },
      { id: 'index', label: 'Created an index on orders(status)', check: (w) => Boolean(w.db.tables['orders']?.indexes.some((ix) => ix.columns.includes('status'))) },
      { id: 'cpu-recovered', label: 'DB CPU peak under 70% over the last hour of traffic', check: (w) => {
        const recent = (w.monitoring.series.db_cpu_pct ?? []).slice(-60);
        if (recent.length < 10) return false;
        return Math.max(...recent.map((p) => p.v)) < 70;
      } },
      { id: 'errors-ok', label: 'Error rate back under 2%', check: (w) => (w.monitoring.series.error_pct.at(-1)?.v ?? 99) < 2 }
    ],
    hints: [
      'DATABASE tab → SQL console. Run: EXPLAIN ANALYZE SELECT * FROM orders WHERE status = \'paid\' — note it says "Seq Scan" and "full table scan over 1,048,576 rows".',
      'The fix is one statement: CREATE INDEX idx_orders_status ON orders (status); — the planner switches to an Index Scan and every lookup stops reading the whole table.',
      'Verify: run the EXPLAIN again (should say Index Scan using idx_orders_status), then watch the DB CPU gauge — advance time a few minutes and it should settle under 70%. Resizing the DB would also have "fixed" CPU, at 2x the monthly bill.'
    ],
    rewards: { cash: 4000, xp: { databases: 40, architecture: 20 } },
    onStart: (w) => {
      const before = Math.round(w.company.users);
      w.company.users = Math.round(before * 6) + 1500;
      audit(w, 'system', 'event', `Product-market fit: users jumped from ${before.toLocaleString()} to ${Math.round(w.company.users).toLocaleString()} in two weeks. The orders table is now the hottest path.`);
    },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'The database survives the growth. Next question the board keeps asking: "what happens if web-01 dies?"');
    }
  },
  // -------------------------------------------------------- 16
  {
    id: 'm16-ha',
    index: 16,
    title: 'One server is a single point of failure',
    phase: 'build',
    story: 'Everything the company earns flows through one 203.0.113.10 box. A failed kernel upgrade would take the whole company down. The board approved a small HA budget: a second VM and a load balancer. And engineering practice demands proof — a chaos drill that kills web-01 on purpose.',
    objective: 'Provision vm-02, deploy the API image to it, put the load balancer in front (update the api DNS record to the LB), get both backends healthy — then survive the automatic failover drill.',
    coaching: 'CLOUD → Compute: provision vm-02 and deploy the latest registry image to it. CLOUD → Load balancer: provision lb-01, then CLOUD → DNS: update the api record to the LB IP. Both backends healthy = the drill can pass. The drill fires automatically ~90 minutes after this mission starts.',
    skills: ['architecture', 'networking', 'cloud'],
    requirements: [
      { id: 'vm02', label: 'Second VM provisioned (vm-02)', check: (w) => Boolean(w.hosts['vm-02']) },
      { id: 'vm02-app', label: 'API image deployed and running on vm-02', check: (w) => w.docker.containers.some((c) => (c.hostId ?? 'web-01') === 'vm-02' && c.status === 'running') },
      { id: 'lb', label: 'Load balancer provisioned', check: (w) => Boolean(w.lb?.provisioned) },
      { id: 'dns-lb', label: 'api DNS record points at the load balancer', check: (w) => Boolean(w.lb?.provisioned && w.dns[`${w.company.slug}.dev`]?.[`api.${w.company.slug}.dev`]?.value === w.lb.ip) },
      { id: 'backends', label: 'Both backends serving (web-01 + vm-02)', check: (w) => Boolean(w.lb?.provisioned) && hostServesApi(w, 'web-01') && hostServesApi(w, 'vm-02') },
      { id: 'drill', label: 'Failover drill passed (web-01 killed, site stayed up)', check: (w) => Boolean(w.flags.haDrillSurvived) }
    ],
    hints: [
      'CLOUD tab → Compute → "Provision vm-02", then "Deploy latest image" (the registry already has your CI-built image). Wait ~2 sim minutes for its health check.',
      'CLOUD tab → Load balancer → Provision lb-01. Then CLOUD → DNS: edit/add the record api → 203.0.113.20 (the LB IP). Traffic now flows Users → LB → {web-01, vm-02}.',
      'The drill runs automatically ~90 sim minutes after the mission starts (16× speed helps). It kills web-01 for 30 minutes: if the LB can route to vm-02, users never notice and the drill passes. If it fails, it retries every ~3 hours — fix the architecture and let it try again.'
    ],
    rewards: { cash: 6000, xp: { architecture: 50, networking: 30, cloud: 20 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 90, kind: 'ha_drill' });
      audit(w, 'system', 'game', 'HA mission started — a chaos drill (web-01 kernel panic) is armed for ~90 sim minutes from now.');
    },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'The platform survives losing a server. Jordan: "now let us ship like grown-ups" — staging, e2e and approvals are next.');
    }
  },
  // -------------------------------------------------------- 17
  {
    id: 'm17-e2e',
    index: 17,
    title: 'Clicking on purpose',
    phase: 'build',
    story: 'Postmortem action from the bad deploy: nothing reaches production again without proof it works. Jordan mandates a staging environment and end-to-end tests — and QA\'s Sam plants a canary regression in the next release to PROVE the pipeline catches it.',
    objective: 'Extend the pipeline: deploy to STAGING, run E2E against it, then gate the production deploy behind an approval. Ship the release — watch e2e catch the canary — then ship the fixed release through the approval.',
    coaching: 'Edit .ci/pipeline.yml: add a deploy_staging step, an e2e step (run: npm run e2e), an approval gate (uses: sim/approval) BEFORE the production deploy step. Commit, run the pipeline in the CI tab, and watch what happens.',
    skills: ['cicd', 'observability'],
    requirements: [
      { id: 'staging', label: 'Staging environment deployed (deploy_staging step)', check: (w) => Boolean(w.ci.staging?.image) },
      { id: 'e2e', label: 'E2E suite ran against staging', check: (w) => (w.ci.staging?.e2eLog.length ?? 0) > 0 },
      { id: 'caught', label: 'The canary regression was caught in staging (production untouched)', check: (w) => {
        if (!w.flags.stagingCaughtBug) return false;
        const started = Number(w.flags.m17StartedAtMin ?? 0);
        return !w.monitoring.incidents.some((i) => i.kind === 'bad_deploy' && i.openedAtMin > started);
      } },
      { id: 'approved', label: 'A production deploy passed the approval gate', check: (w) => Boolean(w.flags.ciApprovalUsed) },
      { id: 'prod-fixed', label: 'The fixed release was deployed to production after the catch', check: (w) => {
        const active = w.ci.deployments.find((d) => d.active);
        return Boolean(active && active.id !== w.flags.stagingCaughtDeployId && active.createdAtMin >= Number(w.flags.stagingCaughtAtMin ?? Infinity));
      } }
    ],
    hints: [
      'Pipeline order matters: build → push → deploy_staging → e2e → approval → deploy. Commit the file first. Staging deploy step: `- name: deploy_staging\n    uses: sim/deploy-staging`',
      'Continue with:\n  - name: e2e\n    run: npm run e2e\n  - name: approve\n    uses: sim/approval\n  - name: deploy\n    uses: sim/deploy\nThe e2e step runs Playwright against staging. The run PAUSES at the approval — approve it in the CI tab.',
      'Run the pipeline: e2e FAILS (the canary!) and production is never touched. Teammate ships the fix — just RUN PIPELINE again: e2e passes, the run waits for your APPROVAL, and the fixed release deploys.'
    ],
    rewards: { cash: 5000, xp: { cicd: 60, observability: 20 } },
    onStart: (w) => {
      w.flags.nextDeployHasBug = true;
      w.flags.m17BugPending = true;
      w.flags.m17StartedAtMin = w.nowMin;
      audit(w, 'sam (qa)', 'game', 'Canary armed: the next release ships with a planted regression. If your pipeline is any good, users will never see it.');
    },
    onComplete: (w) => {
      w.flags.m17BugPending = false;
      w.flags.nextDeployHasBug = false;
      audit(w, 'system', 'game', 'The pipeline is trusted: staging catches what humans miss, approvals gate production. Maya the senior infra engineer starts Monday.');
    }
  },
  // -------------------------------------------------------- 18
  {
    id: 'm18-terraform',
    index: 18,
    title: 'Under new management',
    phase: 'build',
    story: 'Maya arrives and finds a console-built platform: two VMs, a load balancer and a database, all clicked into existence. "If it isn\'t code, it doesn\'t exist." Time to bring the infrastructure under Terraform management.',
    objective: 'Install terraform, describe the CURRENT infrastructure in /opt/infra/main.tf, initialize, and import every existing resource until the plan is clean. Then catch the console drift Maya predicts — and reconcile it with terraform apply.',
    coaching: 'sudo apt-get install -y terraform. mkdir -p /opt/infra; write main.tf in the EDITOR (stratus_vm web-01 + vm-02, stratus_lb lb01, stratus_db main). cd /opt/infra && terraform init, then terraform plan lists what needs importing — import each: terraform import stratus_vm.web-01 i-web01 (any id works).',
    skills: ['cloud', 'architecture'],
    requirements: [
      { id: 'installed', label: 'terraform installed', check: (w) => w.hosts['web-01'].packages.includes('terraform') },
      { id: 'init', label: 'Working directory initialized (terraform init)', check: (w) => Boolean(w.tf?.initialized) },
      { id: 'managed', label: 'All infra imported: both VMs, the LB, the database', check: (w) => {
        const r = w.tf?.resources ?? {};
        return Boolean(r['stratus_vm.web-01'] && r['stratus_vm.vm-02'] && (!w.lb?.provisioned || r['stratus_lb.lb01']) && (!w.db.provisioned || r['stratus_db.main']));
      } },
      { id: 'clean', label: 'terraform plan reports "No changes"', check: (w) => Boolean(w.tf?.lastPlanClean && w.tf.initialized) },
      { id: 'drift', label: 'Console drift detected with terraform plan', check: (w) => Boolean(w.tf?.driftDetected) },
      { id: 'reconciled', label: 'Drift reconciled with terraform apply (db back to db.small)', check: (w) => Boolean(w.tf?.driftResolved) && w.db.plan === 'db.small' }
    ],
    hints: [
      'main.tf describes what SHOULD exist:\nprovider "stratus" { region = "us-east-1" }\nresource "stratus_vm" "web-01" { size = "m3.medium" }\nresource "stratus_vm" "vm-02" { size = "m3.medium" }\nresource "stratus_lb" "lb01" { }\nresource "stratus_db" "main" { plan = "db.small" }',
      'cd /opt/infra && terraform init. terraform plan says "+ … will be created" for things that already exist — real Terraform would collide. Import them instead: terraform import stratus_vm.web-01 i-123 (repeat for vm-02, stratus_lb.lb01, stratus_db.main). Then plan again: "No changes".',
      'Maya\'s prediction: watch the audit feed — someone will "save money" via the console. When it happens: terraform plan shows the drift in red; terraform apply -auto-approve forces the cloud back to the code.'
    ],
    rewards: { cash: 5000, xp: { cloud: 50, architecture: 30 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 45, kind: 'tf_drift' });
      audit(w, 'maya', 'game', 'Maya: "Mark my words — within the hour, someone will click the console instead of changing the code."');
    },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'Infrastructure-as-code: the console is now read-only by convention, and drift has a detection loop.');
    }
  },
  // -------------------------------------------------------- 19
  {
    id: 'm19-k8s',
    index: 19,
    title: 'Pods of plenty',
    phase: 'build',
    story: 'Traffic keeps climbing and per-VM "docker run" deploys do not scale — you deploy to two boxes by hand. Maya runs a Kubernetes workshop and the board approves a managed cluster. Deploys become rollouts; the platform becomes self-healing.',
    objective: 'Provision the k8s cluster (CLOUD tab), write real manifests (Deployment with 2 replicas + readiness/liveness probes, Service type LoadBalancer, Ingress), apply them, route traffic through the cluster, prove a zero-downtime rolling update, and let an HPA handle the load.',
    coaching: 'CLOUD → Kubernetes → Provision. Write /opt/app/k8s/deployment.yaml + service.yaml + ingress.yaml in the EDITOR (a Service of type LoadBalancer gets an external IP and registers behind lb-01). Then: kubectl apply -f k8s/, kubectl get pods. Rolling update: kubectl set image deployment/api api=registry.acme.dev/acme/api:v2. HPA: kubectl autoscale deployment/api --min=2 --max=6 --cpu-percent=70.',
    skills: ['architecture', 'docker'],
    requirements: [
      { id: 'cluster', label: 'Kubernetes cluster provisioned', check: (w) => Boolean(w.k8s?.provisioned) },
      { id: 'deployment', label: 'api Deployment: ≥2 replicas with readiness AND liveness probes', check: (w) => {
        const d = w.k8s?.deployments['api'];
        return Boolean(d && d.replicas >= 2 && d.readinessProbe && d.livenessProbe);
      } },
      { id: 'exposed', label: 'Service (LoadBalancer) + Ingress expose the Deployment', check: (w) => {
        const k = w.k8s;
        return Boolean(k && Object.values(k.services).some((s) => s.type === 'LoadBalancer' && s.selector === 'api') && Object.keys(k.ingresses).length > 0);
      } },
      { id: 'serving', label: 'The cluster serves production traffic (behind lb-01)', check: (w) => k8sServes(w) },
      { id: 'rollout', label: 'Zero-downtime rolling update (revision ≥ 2, RollingUpdate)', check: (w) => {
        const d = w.k8s?.deployments['api'];
        return Boolean(d && d.revision >= 2 && d.strategy === 'RollingUpdate' && w.k8s?.zeroDowntimeProven);
      } },
      { id: 'hpa', label: 'HPA configured and it scaled out under load', check: (w) => {
        const k = w.k8s;
        return Boolean(k && Object.values(k.hpas).some((h) => h.deployment === 'api' && h.peakedAtMin !== undefined));
      } }
    ],
    hints: [
      'CLOUD tab → Kubernetes → PROVISION CLUSTER. Then EDITOR → /opt/app/k8s/deployment.yaml:\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: api\n  template:\n    metadata:\n      labels:\n        app: api\n    spec:\n      containers:\n        - name: api\n          image: registry.acme.dev/acme/api:v1\n          ports:\n            - containerPort: 8080\n          readinessProbe:\n            httpGet: { path: /health, port: 8080 }\n          livenessProbe:\n            httpGet: { path: /health, port: 8080 }',
      'k8s/service.yaml:\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  type: LoadBalancer\n  selector:\n    app: api\n  ports:\n    - port: 80\n      targetPort: 8080\nAnd k8s/ingress.yaml:\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: api\nspec:\n  rules:\n    - host: api.{domain}\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: api\n                port: 80\nThen (SSH on web-01, in /opt/app): kubectl apply -f k8s/ — watch pods go Pending → Running → Ready.',
      'Rolling update: kubectl set image deployment/api api=registry.acme.dev/acme/api:v2 then kubectl rollout status deployment/api — old pods retire only when new ones are Ready (zero downtime). Autoscale: kubectl autoscale deployment/api --min=2 --max=6 --cpu-percent=70 — with current traffic it scales out within minutes.'
    ],
    rewards: { cash: 7000, xp: { architecture: 60, docker: 30 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 60, kind: 'traffic_spike' });
      audit(w, 'system', 'game', 'Kubernetes mission started — a traffic spike is coming in ~60 sim minutes. HPA had better be ready.');
    },
    onComplete: (w) => {
      audit(w, 'system', 'game', 'The platform runs itself: rollouts, probes, autoscaling. One existential risk left — the data.');
    }
  },
  // -------------------------------------------------------- 20
  {
    id: 'm20-dr',
    index: 20,
    title: 'Out of region, out of mind',
    phase: 'build',
    story: 'The board\'s final question: "What happens when the database dies?" There are no backups. Nothing. Nada. And a teammate is about to ship a "cleanup" migration with a DROP TABLE in it.',
    objective: 'Enable automated daily backups on the managed database BEFORE disaster strikes. When the data-loss incident fires: restore from your own backup, verify the data, meet RPO ≤ 24h, and file the postmortem.',
    coaching: 'CLOUD → Databases → Backups → ENABLE (daily, 7-day retention; the first snapshot runs immediately). When the incident fires: CLOUD → Databases → RESTORE FROM BACKUP, verify orders rows in the DATABASE tab, then INCIDENTS → postmortem.',
    skills: ['databases', 'observability'],
    requirements: [
      { id: 'backups', label: 'Automated backups enabled with ≥1 snapshot', check: (w) => Boolean(w.db.backups.enabled && w.db.backups.snapshots.length > 0) },
      { id: 'before', label: 'Backups were enabled BEFORE the incident', check: (w) => {
        const inc = w.monitoring.incidents.find((i) => i.id === w.flags.drRestoreIncident);
        const enabledAt = w.db.backups.enabledAtMin;
        return Boolean(inc && enabledAt !== undefined && enabledAt < inc.openedAtMin);
      } },
      { id: 'incident', label: 'The data-loss incident fired', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'data_loss') },
      { id: 'restored', label: 'Database restored from YOUR backup (orders rows back)', check: (w) => Boolean(w.flags.drRestoreDone) && (w.db.tables['orders']?.rowCount ?? 0) >= 900000 },
      { id: 'rpo', label: 'RPO ≤ 24h and the restore drill completed', check: (w) => {
        const rpo = w.flags.drRpoMin;
        return typeof rpo === 'number' && rpo <= 1440 && Boolean(w.flags.drRestoreDone);
      } },
      { id: 'postmortem', label: 'Postmortem filed with ≥3 corrective actions', check: (w) => {
        const inc = w.monitoring.incidents.find((i) => i.id === w.flags.drRestoreIncident);
        return Boolean(inc?.postmortemFiled && inc.corrective.filter((c) => c.done).length >= 3);
      } }
    ],
    hints: [
      'CLOUD tab → Managed databases → Backups: ENABLE. The first snapshot runs immediately — that is your restore point. Do this BEFORE the incident (a backup created after the loss restores nothing).',
      'When the migration hits: orders go to 0, error rate spikes, a SEV1 data-loss incident opens. CLOUD → Databases → RESTORE FROM BACKUP (point-in-time: it uses the latest snapshot from before the incident).',
      'Verify in the DATABASE tab (\\dt or SELECT) that orders rows are back over 1M. Then MONITORING → INCIDENTS → postmortem: tick at least restore/backups/pitr corrective actions. RPO (how much data you lost) must be ≤ 24h — daily snapshots guarantee it.'
    ],
    rewards: { cash: 8000, xp: { databases: 50, architecture: 30 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 90, kind: 'dr_drill' });
      audit(w, 'system', 'game', 'A teammate is preparing a "cleanup" migration. It ships in ~90 sim minutes. Backups first, engineer. Backups first.');
    },
    onComplete: (w) => {
      w.flags.buildPhaseComplete = true;
      audit(w, 'system', 'game', 'BUILD PHASE COMPLETE — 20 missions: from a dead API on one box to a self-healing, backed-up, code-managed platform. OPERATE phase: the world keeps happening.');
    }
  },
  // -------------------------------------------------------- 21
  {
    id: 'm21-team',
    index: 21,
    title: 'The platform team',
    phase: 'operate',
    story: 'Revenue is real now, and you are still a team of one. The pager goes to Jordan when you sleep. It is time to hire — and to build the rotation so the company survives your nights off.',
    objective: 'Open the COMPANY tab: hire at least two engineers, put one on call, and live through an incident that pages them (one is coming — the world does not wait).',
    coaching: 'COMPANY tab → Team: each role has a salary and an effect (seniors calm incident probability, SREs halve customer impact and answer the pager). Then set ON-CALL. An ambient incident is armed ~90 sim minutes from now.',
    skills: ['architecture'],
    requirements: [
      { id: 'hired', label: 'At least two engineers hired', check: (w) => (w.team?.engineers.length ?? 0) >= 2 },
      { id: 'oncall', label: 'Someone is on call', check: (w) => Boolean(w.team?.onCallId) },
      { id: 'paged', label: 'An incident paged the on-call engineer', check: (w) => Boolean(w.flags.onCallPaged) },
      { id: 'handled', label: 'A paged incident was resolved', check: (w) => w.monitoring.incidents.some((i) => i.status === 'resolved' && i.timeline.some((ev) => ev.text.includes('paged'))) }
    ],
    hints: [
      'COMPANY tab → Team → HIRE. A senior calms the platform; an SRE is the on-call hero. Two salaries, two calm nights.',
      'COMPANY tab → On-call: pick an engineer (SRE acknowledges in 40s flat). Without on-call, the pager goes to the founder.',
      'Wait for the ambient incident (~90 sim min from mission start — 16× helps). It resolves itself when the surge ends; your on-call engineer just has to answer the page.'
    ],
    rewards: { cash: 5000, xp: { architecture: 40 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 90, kind: 'ambient_incident' });
      audit(w, 'system', 'game', 'OPERATE phase: hiring open. A traffic incident is armed for ~90 sim minutes — best have someone on call.');
    },
    onComplete: (w) => audit(w, 'system', 'game', 'The team is real. The pager no longer goes to the founder.')
  },
  // -------------------------------------------------------- 22
  {
    id: 'm22-debt',
    index: 22,
    title: 'Paying down the mortgage',
    phase: 'operate',
    story: 'Maya prints the "technical debt ledger": every incident you lived through, the legacy server nobody deleted, the shortcuts that shipped. Debt raises the odds of the NEXT incident. Time to pay some of it back on purpose.',
    objective: 'COMPANY tab → Technical debt: run at least two refactoring projects (delete the legacy server!) and bring the debt below 10 points. Your engineers pay it down slowly — projects pay it down fast.',
    coaching: 'COMPANY tab → Technical debt shows the ledger (how the debt was earned) and the project catalog. START a project: it costs cash and sim time, then removes debt points on completion.',
    skills: ['architecture', 'cicd'],
    requirements: [
      { id: 'ledger', label: 'The debt ledger is open (see what you owe)', check: (w) => w.debt !== undefined },
      { id: 'projects', label: 'Two refactoring projects completed', check: (w) => (w.debt?.projects.filter((p) => p.done).length ?? 0) >= 2 },
      { id: 'legacy-gone', label: 'legacy-server.js deleted for good', check: (w) => !fs.getFile(w.hosts['web-01'].fs, '/opt/app/legacy-server.js') },
      { id: 'low', label: 'Debt below 10 points', check: (w) => (w.debt?.points ?? 99) < 10 }
    ],
    hints: [
      'COMPANY tab → Technical debt → START "Delete the legacy server" ($500, ~2h). It removes the file AND its process for -8 debt.',
      'Start a second project (runbooks or the database audit). Projects complete on their own as sim time passes — 16× speed helps.',
      'Your hires pay down ~0.5-1 debt/day passively. Between two finished projects and the team, the ledger drops below 10.'
    ],
    rewards: { cash: 5000, xp: { architecture: 40, cicd: 20 } },
    onStart: (w) => audit(w, 'maya', 'game', 'Maya: "Every shortcut you took is on this ledger. Debt is incident probability. Pay it down on purpose or it will collect itself."'),
    onComplete: (w) => audit(w, 'system', 'game', 'The ledger is under control. Ambient incident odds drop with it.')
  },
  // -------------------------------------------------------- 23
  {
    id: 'm23-canary',
    index: 23,
    title: 'Canary in the coal mine',
    phase: 'operate',
    story: 'Staging caught the last regression — but QA\'s new one only fails under REAL traffic (a leak e2e cannot see). Shipping it to 100% of users at once would be a very short experiment. Progressive delivery: send 10% first, watch, then decide.',
    objective: 'Switch the pipeline\'s deploy step to strategy: canary. Ship the release: the canary must auto-abort on the error spike (prod untouched). Then re-run the fixed release and let a clean canary promote.',
    coaching: 'EDIT .ci/pipeline.yml — on the deploy step add:\n    uses: sim/deploy\n    with:\n      strategy: canary\n(or a top-level "strategy: canary"). Run the pipeline: 10% canary, 30 sim minutes of observation, auto-abort on error spike, auto-promote when clean. The CI tab shows the live canary.',
    skills: ['cicd'],
    requirements: [
      { id: 'configured', label: 'Pipeline deploys with the canary strategy', check: (w) => Boolean(w.flags.canaryConfigured) },
      { id: 'aborted', label: 'Canary auto-aborted the bad release (production untouched)', check: (w) => {
        if (!w.flags.canaryAutoAbort) return false;
        const started = Number(w.flags.m23StartedAtMin ?? 0);
        return !w.monitoring.incidents.some((i) => i.kind === 'bad_deploy' && i.openedAtMin > started);
      } },
      { id: 'promoted', label: 'A clean canary was promoted to 100%', check: (w) => Boolean(w.flags.canaryPromoted) }
    ],
    hints: [
      'EDIT .ci/pipeline.yml: under the deploy step add two lines:\n      with:\n        strategy: canary\nCommit and run the pipeline in the CI tab.',
      'The canary shows errors after ~5 sim minutes and ABORTS itself around minute 8 — production never sees the bug. Watch the CI tab (or audit feed).',
      'QA ships the fix: RUN PIPELINE again. This canary stays clean; after 30 sim minutes it promotes itself to 100% (you can also PROMOTE NOW from the CI tab).'
    ],
    rewards: { cash: 6000, xp: { cicd: 50 } },
    onStart: (w) => {
      w.flags.canaryRuntimeBug = true;
      w.flags.m23StartedAtMin = w.nowMin;
      audit(w, 'sam (qa)', 'game', 'Canary canary armed: the next release leaks memory under real traffic — staging e2e CANNOT see it. 10% of users will. Ship it carefully.');
    },
    onComplete: (w) => audit(w, 'system', 'game', 'Progressive delivery: bad releases now cost 10% of traffic for 8 minutes instead of 100% for hours.')
  },
  // -------------------------------------------------------- 24
  {
    id: 'm24-slo',
    index: 24,
    title: 'Promises you can keep',
    phase: 'operate',
    story: 'The enterprise customer\'s contract renewal asks one question: "what do you promise?" Not what you hope — what you COMMIT to, in writing, with consequences. Time to define SLOs and live inside an error budget.',
    objective: 'MONITORING tab → SLOs: commit to an availability target and a p95 latency target you can actually keep. Then hold them for one full sim day without exhausting the error budget.',
    coaching: 'MONITORING → SLOs: pick targets (99.0/99.5/99.9 availability; 600/1000ms p95). Ambitious targets = tiny error budgets. Commit, then ship nothing scary and let the budget breathe for a sim day (1440 min).',
    skills: ['observability'],
    requirements: [
      { id: 'committed', label: 'SLOs committed (availability + p95 targets)', check: (w) => Boolean(w.slos?.configured) },
      { id: 'availability', label: 'Availability SLO currently met', check: (w) => sloReport(w).availabilityMet },
      { id: 'p95', label: 'p95 latency SLO currently met', check: (w) => sloReport(w).p95Met },
      { id: 'budget', label: 'Error budget not exhausted', check: (w) => sloReport(w).budgetRemainingPct > 0 },
      { id: 'held', label: 'SLOs held for one full sim day since committing', check: (w) => {
        const s = w.slos;
        if (!s?.setAtMin) return false;
        return w.nowMin - s.setAtMin >= 1440 && sloReport(w).availabilityMet && sloReport(w).budgetRemainingPct > 0;
      } }
    ],
    hints: [
      'MONITORING tab → SLOs panel. Look at the error-budget math BEFORE you commit: 99.9% allows only ~43 bad minutes a month. Your history decides what is honest.',
      '99.5% availability + 1000ms p95 is a defensible first commitment for a company your size. Commit and watch the budget bar.',
      'Now protect it: no risky deploys, keep the canary strategy, let the traffic settle. One sim day at 4× speed ≈ 6 real minutes.'
    ],
    rewards: { cash: 8000, xp: { observability: 50, architecture: 30 } },
    onStart: (w) => audit(w, 'system', 'game', 'Contract renewal in one sim day. What you promise on paper, you must keep in production.'),
    onComplete: (w) => {
      w.flags.operatePhaseComplete = true;
      audit(w, 'system', 'game', 'P2 MILESTONE COMPLETE — 24 missions: a platform, a team, a budget and promises you can keep. The operate economy continues (P3: multi-cloud, challenge mode).');
    }
  },
  // -------------------------------------------------------- 25
  {
    id: 'm25-clouds',
    index: 25,
    title: 'Between two clouds',
    phase: 'ecosystem',
    story: 'Three sales decks land on your desk the same week. Stratus — the incumbent, list price, a rep who golfs. Volt — 28% cheaper, 99.5% SLA, strong opinions. Orbit — 99.99% and invoice stickers on everything. Maya: "You have been on Stratus by default since day one. Default is not a strategy."',
    objective: 'CLOUD tab → Providers: run the cost comparison across every provider region. Then survive what your provider is about to do (~4 sim hours): a region-wide outage you cannot fix. Claim the SLA credit and file the postmortem.',
    coaching: 'CLOUD → Providers shows the tradeoff triangle: price vs reliability vs latency, priced for YOUR stack. The armed outage will take everything down — that is what provider risk costs. When it ends: REQUEST SLA CREDIT, then postmortem like any other incident.',
    skills: ['cloud'],
    requirements: [
      { id: 'compared', label: 'Provider comparison run (price × reliability × latency)', check: (w) => Boolean(w.cloud?.compared) },
      { id: 'outage', label: 'Survived a provider outage (they cannot be fixed, only priced)', check: (w) => (w.cloud?.outagesSeen ?? 0) >= 1 },
      { id: 'credit', label: 'SLA credit claimed from the provider', check: (w) => (w.cloud?.creditsTotal ?? 0) > 0 },
      { id: 'postmortem', label: 'Postmortem filed for the outage', check: (w) => w.monitoring.incidents.some((i) => i.kind === 'provider_outage' && i.postmortemFiled) }
    ],
    hints: [
      'CLOUD tab → Providers → RUN COMPARISON. Read the tradeoffs before touching anything: Volt is 28% cheaper with a 99.5% SLA; Orbit is 99.99% at +30%; regions trade a few % of price for latency.',
      'The outage pins errors at 80% for 15–45 sim minutes and NOTHING you own is broken — check the provider status (the incident tells you), let it ride, watch the uptime dent.',
      'After recovery: CLOUD → Providers → REQUEST SLA CREDIT (providers pay for their own outages — if you ask within a sim day). Then MONITORING → INCIDENTS → postmortem: tick the credit, status-page and migration actions.'
    ],
    rewards: { cash: 6000, xp: { cloud: 40 } },
    onStart: (w) => {
      ensureCloud(w);
      w.scheduledEvents.push({ atMin: w.nowMin + 240, kind: 'provider_outage' });
      audit(w, 'maya', 'game', 'Maya: "Three providers, one spreadsheet. Price, reliability, latency — pick your poison on purpose. Oh, and Stratus us-east-1 has been... flaky lately."');
    },
    onComplete: (w) => audit(w, 'system', 'game', 'The provider market is now a lever, not a landlord. (And the pager knows the difference between your bugs and their outages.)')
  },
  // -------------------------------------------------------- 26
  {
    id: 'm26-migrate',
    index: 26,
    title: 'Moving day',
    phase: 'ecosystem',
    story: 'The board saw the comparison table. Their entire note, verbatim: "why are we paying Stratus rates?" So: migration. The whole stack, to a cheaper footprint, without burning the users you spent 26 missions earning.',
    objective: 'CLOUD → Providers: pick Volt us-central-1 (the cheap row) and START MIGRATION. Your preparations — backups, staging, load balancer — decide the cutover downtime. Land it at ≤15 minutes with a bill that actually dropped.',
    coaching: 'The migration panel shows your planned cutover downtime BEFORE you commit: every preparation from earlier missions (backups −10, staging −10, LB −10, k8s −5) shortens it. Six sim hours of prep run themselves; the cutover is the loud part.',
    skills: ['cloud', 'architecture'],
    requirements: [
      { id: 'migrated', label: 'A migration completed end-to-end', check: (w) => (w.cloud?.migrations.length ?? 0) >= 1 },
      { id: 'rehearsed', label: 'Cutover downtime ≤ 15 minutes (preparations pay off)', check: (w) => (w.cloud?.migrations[0]?.downtimeMin ?? 99) <= 15 },
      { id: 'cheaper', label: 'The monthly bill dropped vs before the migration', check: (w) => {
        const m = w.cloud?.migrations[0];
        return Boolean(m && m.costAfter < m.costBefore);
      } }
    ],
    hints: [
      'Backups + staging + LB (all from earlier missions) cut the cutover from 45 to 15 minutes; the Kubernetes cluster shaves 5 more. The panel computes it live — missing one is the difference between a blip and an outage.',
      'Pick the Volt us-central-1 row → START MIGRATION (~15% of the monthly bill, one time). Prep and replication narrate themselves in the audit feed; the cutover pins errors for the planned minutes.',
      'After the cutover the whole footprint prices at Volt rates (COSTS tab, every line item tagged volt/us-central-1). Reliability is now 99.5% — outages are ~3.6× likelier. Cheaper is a choice with consequences.'
    ],
    rewards: { cash: 6000, xp: { cloud: 50, architecture: 20 } },
    onStart: (w) => audit(w, 'system', 'game', 'The board wants the bill down and the users asleep. Moving day is coming — bring backups, a rehearsal, and a load balancer.'),
    onComplete: (w) => audit(w, 'system', 'game', 'Migration complete with a rehearsed cutover. This is what "cattle, not pets" buys you: the whole zoo moved and the users noticed for minutes.')
  },
  // -------------------------------------------------------- 27
  {
    id: 'm27-products',
    index: 27,
    title: 'The second product',
    phase: 'ecosystem',
    story: 'Jordan walks in with a napkin: "One product is a job. Two products is a company." The platform you built can carry more than one product — and the second one is where margins live.',
    objective: 'COMPANY tab → Products: build and launch two products, including Enterprise Grid (it has gates: written SLOs, happy users, a real team). Get product revenue to 10% of the subscription MRR.',
    coaching: 'Products build themselves over sim hours (they cost cash up front), then bill their share of users monthly. Enterprise Grid refuses to start until the company can honestly support it — SLOs on paper, satisfaction ≥ 4, two engineers.',
    skills: ['architecture'],
    requirements: [
      { id: 'shipped', label: 'Two products launched', check: (w) => ensureProducts(w).products.filter((p) => p.launchedAtMin !== undefined).length >= 2 },
      { id: 'enterprise', label: 'Enterprise Grid launched (the gated tier)', check: (w) => ensureProducts(w).products.some((p) => p.id === 'ent-grid' && p.launchedAtMin !== undefined) },
      { id: 'revenue', label: 'Product MRR ≥ 10% of subscription MRR', check: (w) => productMrrOf(w) >= 0.1 * baseMrrOf(w) }
    ],
    hints: [
      'COMPANY → Products: Insights ($800, ~4h) and ShipLink ($1,600, ~6h) build on their own while time passes — launches add a satisfaction bump, monthly revenue and a little infra cost.',
      'Enterprise Grid is gated on purpose: it needs WRITTEN SLOs (mission 24), satisfaction ≥ 4 and at least two engineers. Enterprise money comes with enterprise promises.',
      'The revenue bar is relative (10% of subscriptions): Insights + Enterprise Grid usually clear it by themselves; ShipLink makes it comfortable. Watch MRR build as users keep growing.'
    ],
    rewards: { cash: 6000, xp: { architecture: 40 } },
    onStart: (w) => audit(w, 'jordan (founder)', 'game', 'Jordan: "The platform can carry more than one product. Ship the second one — and sell the big one to people who read SLAs."'),
    onComplete: (w) => audit(w, 'system', 'game', 'A portfolio, not a product. Every launch bills monthly and the platform barely noticed — that is leverage.')
  },
  // -------------------------------------------------------- 28
  {
    id: 'm28-finops',
    index: 28,
    title: 'Where the money goes',
    phase: 'ecosystem',
    story: 'Maya slides exactly one slide across the table: the cloud bill as a share of revenue, trending the wrong way. "FinOps," she says, like it\'s a personality trait. "Every dollar should have a job. Go find the dollars sleeping on the job."',
    objective: 'COSTS tab → FinOps: set a monthly budget, resolve at least three rightsizing recommendations (the table says exactly what to do), cut the bill 15% below today\'s baseline, then hold the budget for two sim days.',
    coaching: 'The FinOps panel computes recommendations from LIVE utilization — an oversized database, a relic VM, an idle node, uncommitted compute. Each ACT button does the thing. The baseline is captured the moment this mission starts; the daily scoreboard counts days under budget.',
    skills: ['cloud', 'finops'],
    requirements: [
      { id: 'budget', label: 'A monthly infra budget is set', check: (w) => Boolean(w.finops?.budgetMonthly) },
      { id: 'recs', label: 'Three FinOps recommendations resolved', check: (w) => (w.finops?.resolved.length ?? 0) >= 3 },
      { id: 'cheaper', label: 'Bill at least 15% below the FinOps baseline', check: (w) => {
        const f = w.finops;
        return Boolean(f?.baselineMonthly && monthlyInfraCost(w) <= 0.85 * f.baselineMonthly);
      } },
      { id: 'discipline', label: 'Two sim days held under budget', check: (w) => (w.finops?.daysUnderBudget ?? 0) >= 2 }
    ],
    hints: [
      'COSTS → FinOps → SET BUDGET at what the OPTIMIZED bill should be, not what you hope for. The scoreboard counts sim days under/over — set it after the cuts, not before.',
      'The recommendations are a to-do list: decommission vm-02 (Kubernetes serves now), scale the node pool 3→2 (scale the api deployment to ≤2 replicas first — the rec appears when nothing needs 3 nodes), commit 1-year reserved compute (20% off, but only while you stay put).',
      'Three cuts ≈ −30% against the baseline. Then keep it under budget for two sim days — 16× speed makes it a coffee break. Migration to Volt counts too, but you already did that the smart way.'
    ],
    rewards: { cash: 10000, xp: { finops: 50, cloud: 20 } },
    onStart: (w) => {
      setFinopsBaseline(w);
      audit(w, 'maya', 'game', 'Maya: "Baseline captured. Every dollar now has a job description. I\'ll check back when the scoreboard says you mean it."');
    },
    onComplete: (w) => {
      w.flags.ecosystemPhaseComplete = true;
      audit(w, 'system', 'game', 'P3 MILESTONE COMPLETE — 28 missions: a platform, a team, promises, a portfolio, and a bill with a job. P4 unlocked: mission packs, the postmortem tournament, challenge mode (MODES tab).');
    }
  },
  // -------------------------------------------------------- 29
  {
    id: 'm29-packs',
    index: 29,
    title: 'The content engine',
    phase: 'bonus',
    story: 'Maya drops a one-page spec on your desk: "MISSION PACKS v1". The training program, refactored into JSON bundles — installable, swappable, writable by anyone. Screw it on right and content ships like software. First pack off the shelf: THE POSTMORTEM TOURNAMENT. Five rounds. Live incidents. A scoreboard with rivals on it.',
    objective: 'MODES tab → Mission packs: read the format note, activate The Postmortem Tournament, and win Round 1 (a traffic surge is coming — resolve it, postmortem it, stay under 150 minutes MTTR).',
    coaching: 'MODES → MISSION PACKS → ACTIVATE. The pack runs as a bonus track next to the career chain (the dock shows both). Rounds inject real incidents — the scoreboard and rivals update live in MODES.',
    skills: ['observability'],
    requirements: [
      { id: 'activated', label: 'A mission pack activated', check: (w) => Boolean(w.flags.packActivated) },
      { id: 'joined', label: 'Tournament joined (rivals on the board)', check: (w) => w.tournament !== undefined },
      { id: 'round1', label: 'Round 1 won (surge resolved + postmortem + MTTR)', check: (w) => Number(w.flags.packMissionsDone ?? 0) >= 1 }
    ],
    hints: [
      'MODES tab → MISSION PACKS panel → ACTIVATE on "The Postmortem Tournament". It opens after mission 28 — which you just finished.',
      'Round 1 injects a traffic surge ~10 sim minutes in. It self-resolves; your score is the postmortem (≥2 corrective actions) and MTTR ≤ 150.',
      'Watch the MODES tab scoreboard — Cloud Nine, Null Pointers and Ping Payments are playing the same gauntlet, and they do not take coffee breaks.'
    ],
    rewards: { cash: 4000, xp: { observability: 30 } },
    onStart: (w) => audit(w, 'maya', 'game', 'Maya: "Content as software. Activate the tournament pack — and pretend the rivals are watching, because the scoreboard says they are."'),
    onComplete: (w) => audit(w, 'system', 'game', 'The pack format is real: JSON in, missions out. Round 1 down.')
  },
  // -------------------------------------------------------- 30
  {
    id: 'm30-tournament',
    index: 30,
    title: 'The postmortem tournament',
    phase: 'bonus',
    story: 'The bracket narrows. Round of eight: someone ships a broken release while you watch. Semifinal: a region-wide provider outage — same outage for every team, "a level playing field". Final four: they drop your orders table on purpose. The trophy goes to whoever recovers, documents, and gets billed correctly.',
    objective: 'Win the tournament: all five rounds, tournament points ≥ 38, and first place on the scoreboard when the trophy round clears.',
    coaching: 'Each round is faster than the last (MTTR 150 → 90). Rollbacks are one click in CI. Provider credits are one click in CLOUD after the outage ends. The restore is one click in CLOUD → Databases — IF backups were on before the drop.',
    skills: ['observability', 'cicd', 'databases'],
    requirements: [
      { id: 'rounds', label: 'All five rounds won', check: (w) => Number(w.flags.packMissionsDone ?? 0) >= 5 },
      { id: 'points', label: 'Tournament points ≥ 38', check: (w) => (w.tournament?.points ?? 0) >= 38 },
      { id: 'first', label: 'First place on the final scoreboard', check: (w) => Boolean(w.tournament?.finished && w.tournament?.place === 1) }
    ],
    hints: [
      'The rounds chain automatically as you clear them. Bad deploy → CI → ROLLBACK (fast!). Provider outage → ride it, claim the credit, postmortem. Data loss → CLOUD → Databases → RESTORE.',
      'Points: 8 + 10 + 10 + 12 + 6 = 46. The rivals tick upward every few sim minutes — dawdle and Null Pointers will eat your lead.',
      'The trophy round wants a calm board: no open incidents, all rounds done, ≥38 points. Then collect.'
    ],
    rewards: { cash: 6000, xp: { observability: 40, databases: 20, cicd: 20 } },
    onStart: (w) => audit(w, 'system', 'game', 'Tournament continues: rollback round, provider-outage semifinal, and the database drop. Speed and honest postmortems score.'),
    onComplete: (w) => audit(w, 'system', 'game', 'Champion. The trophy is a postmortem template — which is the point.')
  },
  // -------------------------------------------------------- 31
  {
    id: 'm31-challenge',
    index: 31,
    title: 'The constraints game',
    phase: 'bonus',
    story: 'The board discovered gamification. Attached to the annual review: three "challenges" — run the company under a hard constraint and get GRADED. An austerity clause (cut the bill 18%, hold it). A renewal audit (99.5% windowed availability, two days, pop quizzes included). And the auditors\' favorite: they drop your database at an unannounced time and stopwatch the restore.',
    objective: 'MODES tab → Challenges: accept any one challenge and PASS it. Read the rule and the live scoreboard before you click accept — the clocks start immediately.',
    coaching: 'Each challenge grades you daily on the constraint (budget cap, windowed availability floor, or RTO after a surprise disaster). Passed challenges pay $5,000 and count on your record; failed ones stay on the scoreboard. At 16× speed two sim days is a coffee break.',
    skills: ['finops', 'observability', 'databases'],
    requirements: [
      { id: 'accepted', label: 'A challenge accepted (the clock ran)', check: (w) => Number(w.flags.challengesStarted ?? 0) >= 1 },
      { id: 'passed', label: 'A challenge PASSED', check: (w) => Number(w.flags.challengesPassed ?? 0) >= 1 }
    ],
    hints: [
      'Start with the austerity clause if the bill has fat left (reserved compute alone is −20%); the renewal audit if your platform is genuinely calm; the RTO one if your backups are on (they are — mission 20).',
      'Watch the live scoreboard in MODES: budget shows bill vs cap; availability shows windowed % and bad minutes; RTO shows the countdown you cannot see (the disaster lands 3–9 sim hours in — keep backups on and react fast).',
      'Failed a challenge? The scar stays but you can re-accept. Each pass pays $5,000.'
    ],
    rewards: { cash: 5000, xp: { finops: 30, observability: 30 } },
    onStart: (w) => audit(w, 'board', 'game', 'The board: "We gamified your KPIs. You\'re welcome." Three challenges are live in the MODES tab — constraints with scoreboards.'),
    onComplete: (w) => audit(w, 'system', 'game', 'Passed under constraint. The scoreboard respects operators who can hold a line, not just cross one.')
  },
  // -------------------------------------------------------- 32
  {
    id: 'm32-access',
    index: 32,
    title: 'Everyone ships',
    phase: 'bonus',
    story: 'Two tickets land the same morning. One, from a power user: "I use a screen reader; your incident banner is a wall of emoji and vibes." Two, from the German enterprise buyer: "Können wir das Dashboard auf Deutsch haben?" Accessibility and localization are not favors. They are the product working for everyone.',
    objective: 'MODES tab → Access & language: turn on at least one accessibility option (high contrast, large text, reduced motion — Alt+1…9,0 switches tabs) and switch the interface language from English. Then ship like it\'s normal, because it is.',
    coaching: 'The toggles apply instantly and persist per browser; tab shortcuts work everywhere. The interface chrome localizes (es/de); the terminal stays POSIX — some traditions are sacred.',
    skills: ['architecture'],
    requirements: [
      { id: 'a11y', label: 'An accessibility option enabled', check: (w) => Boolean(w.flags.a11yUsed) },
      { id: 'locale', label: 'Interface language switched (es or de)', check: (w) => typeof w.flags.locale === 'string' && w.flags.locale !== 'en' }
    ],
    hints: [
      'MODES tab → ACCESS & LANGUAGE: flip any toggle (high contrast is the most visible). Alt+1…9 and Alt+0 switch tabs without the mouse.',
      'Same panel: Sprache / idioma — pick Español or Deutsch. The chrome re-renders immediately; the change is saved to your company file.',
      'Both done? The mission completes on the next heartbeat — the toggles post to the server when you change them.'
    ],
    rewards: { cash: 8000, xp: { architecture: 40 } },
    onStart: (w) => audit(w, 'support', 'game', 'Two tickets: a screen-reader user and a German enterprise account. Everyone ships — or it is not everyone.'),
    onComplete: (w) => {
      w.flags.scalePhaseComplete = true;
      audit(w, 'system', 'game', 'P4 MILESTONE COMPLETE — 32 missions, four phases. You built the platform, ran the company, scaled the ecosystem, and made it work for everyone. SHIP IT. (Sandbox, challenges and packs remain — the world keeps happening.)');
    }
  },
  // -------------------------------------------------------- 33
  {
    id: 'm33-vault',
    index: 33,
    title: 'The keys to the kingdom',
    phase: 'trust',
    story: 'The penetration test lands with a thud. Finding #1, in bold: the production database password lives in a file on disk, and a copy sits in git history from the dark ages. The fix is not a new password — it is a new pattern: a secrets manager that generates, leases and rotates credentials while no human ever sees them.',
    objective: 'Install the vault, store the DB secret, lease DYNAMIC credentials to the app, and rotate with zero downtime. Then a stray file will appear — scan for the leak and rotate the leaked value into oblivion.',
    coaching: 'sudo apt-get install -y vault, then: vault status (initializes), vault put database/api, vault lease database/api (dynamic creds), vault rotate database/api. When the audit feed mentions a stray file: vault scan, then vault rotate again.',
    skills: ['security'],
    requirements: [
      { id: 'vault-installed', label: 'vault installed', check: (w) => w.hosts['web-01'].packages.includes('vault') },
      { id: 'secret-stored', label: 'The DB secret is vault-managed (vault put database/api)', check: (w) => Boolean(w.vault?.enabled && w.vault.secrets['database/api']) },
      { id: 'dynamic-creds', label: 'Dynamic credentials leased — the app authenticates via the vault', check: (w) => Boolean(w.vault?.credsLive) },
      { id: 'rotated', label: 'Secret rotated with zero downtime (DB still healthy)', check: (w) => {
        const s = w.vault?.secrets['database/api'];
        const res = httpRequest(w, 'http://localhost:8080/health');
        return Boolean(s && s.rotations >= 1 && res.ok && res.status === 200);
      } },
      { id: 'leak-cleaned', label: 'Leak found by scan and killed by rotation', check: (w) => Boolean(w.flags.vaultLeakDetected && w.flags.vaultLeakRevoked) }
    ],
    hints: [
      'Install + initialize: sudo apt-get install -y vault && vault status. Then store the secret (value is generated inside the vault, never typed): vault put database/api',
      'Dynamic credentials: vault lease database/api — the app now authenticates with vault-issued creds (TTL 60m, auto-renewed). Then prove rotation is boring: vault rotate database/api — the database accepts the new pair mid-flight.',
      'A stray file will appear in the audit feed (~40 sim minutes — 16× helps). Run: vault scan — it finds live secret material outside the vault. Kill it: vault rotate database/api. The leaked value now authenticates nothing.'
    ],
    rewards: { cash: 6000, xp: { security: 60 } },
    onStart: (w) => {
      w.scheduledEvents.push({ atMin: w.nowMin + 40, kind: 'secret_leak' });
      audit(w, 'maya', 'game', 'Maya: "Pen-test finding #1: the DB password is a FILE. Patterns, not values — vault, dynamic creds, rotation. Oh, and interns back up things they shouldn\'t."');
    },
    onComplete: (w) => audit(w, 'system', 'game', 'Secrets are infrastructure now: generated, leased, rotated — and leaks die in one command.')
  },
  // -------------------------------------------------------- 34
  {
    id: 'm34-zerotrust',
    index: 34,
    title: 'Nobody gets root',
    phase: 'trust',
    story: 'The enterprise contract comes with a security questionnaire. Question 7: "list every identity that may talk to your database, and prove nothing else can." You currently have no answer — the network is a suburb where every service can visit every other service.',
    objective: 'Install the service mesh and enforce STRICT mTLS (every service gets a cryptographic identity). Add default-deny NetworkPolicies to the cluster with exactly one allowance: api → db on 5432. And the api Deployment must run non-root.',
    coaching: 'CLOUD tab → Service mesh: INSTALL, then ENFORCE STRICT mTLS. Then (web-01) write /opt/app/k8s/netpol.yaml with a default-deny policy and an allow rule, kubectl apply -f k8s/. For non-root: add securityContext runAsNonRoot to the deployment manifest and re-apply.',
    skills: ['security', 'architecture'],
    requirements: [
      { id: 'mesh', label: 'Service mesh installed (identities issued)', check: (w) => Boolean(w.zeroTrust?.meshInstalled) },
      { id: 'strict', label: 'mTLS STRICT enforced (plaintext refused)', check: (w) => Boolean(w.zeroTrust?.mtlsStrict) },
      { id: 'identities', label: 'Every production service has an identity', check: (w) => {
        const ids = w.zeroTrust?.identities ?? [];
        return ids.includes('api') && ids.includes('db');
      } },
      { id: 'netpol-deny', label: 'Default-deny NetworkPolicy applied', check: (w) => Object.values(w.k8s?.networkPolicies ?? {}).some((p) => p.defaultDeny) },
      { id: 'netpol-allow', label: 'One allowance: api → db on 5432 (and nothing else)', check: (w) => Object.values(w.k8s?.networkPolicies ?? {}).some((p) => p.allows.some((a) => a.fromSelector.includes('api') && a.port === 5432)) },
      { id: 'non-root', label: 'api Deployment sets securityContext.runAsNonRoot', check: (w) => w.k8s?.deployments['api']?.runAsNonRoot === true }
    ],
    hints: [
      'CLOUD tab → SERVICE MESH → INSTALL (identities for api, db, lb, nginx), then ENFORCE STRICT mTLS. Permissive mode is a migration window, not a posture.',
      'EDITOR → /opt/app/k8s/netpol.yaml (two documents, one file):\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\nspec:\n  podSelector: {}\n  policyTypes:\n    - Ingress\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-api-to-db\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app: api\n      ports:\n        - port: 5432\nThen: kubectl apply -f k8s/ and kubectl get netpol',
      'Least privilege for the workload itself: EDITOR → k8s/deployment.yaml, inside the api container add:\n          securityContext:\n            runAsNonRoot: true\nRe-apply with kubectl apply -f k8s/. Verify: kubectl describe deployment api (Security: runAsNonRoot=yes).'
    ],
    rewards: { cash: 7000, xp: { security: 50, architecture: 30 } },
    onStart: (w) => audit(w, 'enterprise buyer', 'game', 'Security questionnaire, question 7: "list every identity that may talk to your database, and prove nothing else can." Answer it with architecture, not adjectives.'),
    onComplete: (w) => audit(w, 'system', 'game', 'Zero trust: every connection now has a name, a certificate and a reason. The questionnaire answer is one sentence long.')
  },
  // -------------------------------------------------------- 35
  {
    id: 'm35-supplychain',
    index: 35,
    title: 'Chain of custody',
    phase: 'trust',
    story: 'An acquirer\'s intern with a clipboard asks the question you cannot answer yet: "prove that the image running in production is the image your pipeline built." You cannot. Anything could have pushed that tag. Time for signatures, SBOMs, and an admission policy with teeth.',
    objective: 'Sign the production image with cosign and attach an SBOM. Apply an admission Policy that BLOCKS unsigned images — prove it by trying to roll out the unsigned :v3 first (watch it bounce). Then ship :v3 signed, and make CI sign automatically.',
    coaching: 'sudo apt-get install -y cosign. Build + push :v3 (edit the pipeline tag or docker build/push by hand). Try kubectl set image → DENIED (that is the proof). Then: cosign sign registry.acme.dev/acme/api:v3, cosign attest --type sbom registry.acme.dev/acme/api:v3, and roll out again. Finally add a cosign sign step to the pipeline.',
    skills: ['security', 'cicd'],
    requirements: [
      { id: 'policy', label: 'Admission policy active: unsigned images rejected', check: (w) => w.k8s?.admissionPolicy?.rule === 'signed-images' },
      { id: 'gate-proven', label: 'The gate proved itself: an unsigned rollout was DENIED', check: (w) => Boolean(w.flags.admissionBlocked) },
      { id: 'signed', label: 'The running production image is signed', check: (w) => {
        const img = w.ci.deployments.find((d) => d.active)?.image;
        return Boolean(img && imageSigned(w, img));
      } },
      { id: 'sbom', label: 'The running image carries an SBOM attestation', check: (w) => {
        const img = w.ci.deployments.find((d) => d.active)?.image;
        const reg = w.registry.find((i) => i.repoTags.includes(img ?? ''));
        return Boolean(reg?.sbom);
      } },
      { id: 'ci-signs', label: 'CI signs what it ships (cosign step in the pipeline)', check: (w) => {
        const p = loadPipeline(w, '/opt/app', '.ci/pipeline.yml');
        return p.valid && p.steps.some((s) => /^cosign\s+sign/.test(s.run ?? '') || (/sign/i.test(s.name) && /cosign/.test(s.run ?? '')));
      } }
    ],
    hints: [
      'The policy is a manifest (EDITOR → /opt/app/k8s/policy.yaml):\napiVersion: policy.shipit.dev/v1\nkind: Policy\nmetadata:\n  name: require-signed-images\nspec:\n  requireSignedImages: true\nkubectl apply -f k8s/ — then kubectl get policy',
      'Prove the gate: build + push the next release unsigned (docker build -t registry.acme.dev/acme/api:v3 . && docker push registry.acme.dev/acme/api:v3), then kubectl set image deployment/api api=registry.acme.dev/acme/api:v3 — DENIED by the admission webhook. That rejection is the whole point.',
      'Now ship it properly: cosign sign registry.acme.dev/acme/api:v3 && cosign attest --type sbom registry.acme.dev/acme/api:v3 — then the rollout goes through. Last: make CI do this forever — add after the push step:\n  - name: sign\n    run: cosign sign registry.acme.dev/acme/api:v3\ncommit + run the pipeline.'
    ],
    rewards: { cash: 7000, xp: { security: 50, cicd: 30 } },
    onStart: (w) => audit(w, 'acquirer intern', 'game', 'Due diligence, supply chain section: "prove the running image is the image you built." Signatures or it did not happen.'),
    onComplete: (w) => audit(w, 'system', 'game', 'Chain of custody closed: unsigned code physically cannot reach the cluster, and CI signs everything it ships.')
  },
  // -------------------------------------------------------- 36
  {
    id: 'm36-audit',
    index: 36,
    title: 'The auditor cometh',
    phase: 'trust',
    story: 'The enterprise deal needs a real audit. The auditor arrives with a lanyard, a template, and zero sympathy. The good news: you built evidence-generating systems for 35 missions. The bad news: nobody ever reviewed access, and the audit trail can theoretically be edited.',
    objective: 'COMPANY tab → COMPLIANCE: run the access review (revoke the contractor\'s sudo), ship the audit log to an append-only store, fix every finding, and collect an evidence bundle for the auditors.',
    coaching: 'COMPANY → COMPLIANCE shows live findings — each maps to a real fix (INCIDENTS postmortems, cosign, vault). Revoke the contractor, enable the append-only audit store, then COLLECT EVIDENCE. Zero findings = a clean data room.',
    skills: ['security', 'architecture'],
    requirements: [
      { id: 'access-review', label: 'Access review done: the contractor has no sudo', check: (w) => !w.hosts['web-01'].users['contractor']?.sudo },
      { id: 'audit-immutable', label: 'Audit log ships to an append-only store', check: (w) => Boolean(w.compliance?.auditImmutable) },
      { id: 'evidence', label: 'Evidence bundle collected (artifacts, not assertions)', check: (w) => (w.compliance?.bundles.length ?? 0) >= 1 },
      { id: 'findings-clean', label: 'Zero open audit findings', check: (w) => complianceFindings(w).length === 0 }
    ],
    hints: [
      'COMPANY tab → COMPLIANCE → Access review: the "contractor" account still has sudo on web-01 (from the migration era). REVOKE it.',
      'Same panel: ENABLE APPEND-ONLY AUDIT STORE — the trail becomes evidence-grade (WORM). Then look at the findings list: each one names its fix; most are things earlier missions already taught you.',
      'When the findings list is empty: COLLECT EVIDENCE BUNDLE. It snapshots backups, SLOs, vault rotation, image signing, netpol, mTLS and postmortems — the auditor leaves with artifacts, not promises.'
    ],
    rewards: { cash: 8000, xp: { security: 40, architecture: 40 } },
    onStart: (w) => {
      const web = w.hosts['web-01'];
      web.users['contractor'] = { name: 'contractor', uid: 1400, sudo: true, groups: ['contractor', 'sudo'] };
      audit(w, 'auditor', 'game', 'AUDIT OPENED. Finding #1 already written down: "a contractor account with sudo outlived its project." The lanyard sees everything.');
    },
    onComplete: (w) => {
      w.flags.trustPhaseComplete = true;
      audit(w, 'system', 'game', 'P5a MILESTONE COMPLETE — the security arc: secrets, identity, supply chain, evidence. The company can now PROVE it is trustworthy, which is worth more than being trustworthy.');
    }
  },
  // -------------------------------------------------------- 37
  {
    id: 'm37-portal',
    index: 37,
    title: 'Golden paths',
    phase: 'platform',
    story: 'You are the bottleneck. Fourteen deploy tickets deep, every one a human asking you for permission to ship. The platform you built is GOOD — so good that developers should be able to walk the golden path themselves: one click, all guardrails inherited.',
    objective: 'Launch the internal developer portal (PORTAL tab), publish the web-service golden path, and let developers ship without tickets — until the deploy-ticket queue hits zero.',
    coaching: 'PORTAL tab → LAUNCH PORTAL, then PUBLISH the web-service golden path. Watch the activity feed: every ~20 sim minutes a developer ships something themselves (16× speed helps). The ticket queue drains as they do.',
    skills: ['architecture', 'cicd'],
    requirements: [
      { id: 'portal-enabled', label: 'The developer portal is live', check: (w) => Boolean(w.portal?.enabled) },
      { id: 'template-published', label: 'A golden path is published (self-service with guardrails)', check: (w) => Boolean(w.portal?.templates.some((t) => t.published)) },
      { id: 'dev-deploys', label: 'At least three developers shipped via the golden path', check: (w) => (w.portal?.devDeploys ?? 0) >= 3 },
      { id: 'queue-zero', label: 'The deploy-ticket queue is empty', check: (w) => (w.portal?.ticketQueue ?? 99) === 0 }
    ],
    hints: [
      'PORTAL tab (sidebar) → LAUNCH PORTAL. The portal wraps YOUR pipeline: tests, scans, signing, deploy — one paved road.',
      'PUBLISH the "Web service" golden path. Published = self-service for every developer; the guardrails (signing, probes, alerts) are inherited, not optional.',
      'Now get out of the way: at 16× speed, a developer ships via the portal every ~20 sim minutes and the ticket queue drains one ticket per ship. Watch the feed — priya, jaime, sam and friends do not need you anymore. That is the point.'
    ],
    rewards: { cash: 8000, xp: { architecture: 50, cicd: 30 } },
    onStart: (w) => audit(w, 'jordan (founder)', 'game', 'Jordan: "Fourteen open deploy tickets. YOU are the ticket queue. Launch the portal — I want developers shipping while you sleep."'),
    onComplete: (w) => audit(w, 'system', 'game', 'Golden paths: the platform team ships the platform, developers ship the product. The ticket queue is a museum exhibit.')
  },
  // -------------------------------------------------------- 38
  {
    id: 'm38-previews',
    index: 38,
    title: 'Every PR gets a stage',
    phase: 'platform',
    story: 'Product review meetings are 40 minutes of "works on my laptop" and "I think that\'s the old build". Every pull request deserves its own stage: an ephemeral environment that exists exactly as long as the review does, then destroys itself.',
    objective: 'Add a preview step to the pipeline. Run it twice (two "PRs") — each run must spin up its own ephemeral environment with a URL. Verify one with curl, and prove they are ephemeral: let one auto-destroy.',
    coaching: 'EDIT .ci/pipeline.yml — add after the push step:\n  - name: preview\n    uses: sim/preview\nCommit, then RUN PIPELINE twice. Each run gets pr-N.preview.{domain}. curl one. Wait 120 sim minutes and watch the first one destroy itself (16×).',
    skills: ['cicd'],
    requirements: [
      { id: 'preview-step', label: 'Pipeline has a preview step (committed)', check: (w) => {
        if (!w.git['/opt/app']) return false;
        const p = loadPipeline(w, '/opt/app', '.ci/pipeline.yml');
        return p.valid && hasPreviewStep(p);
      } },
      { id: 'previews-created', label: 'Two distinct preview environments spun up (one per run)', check: (w) => Number(w.flags.previewCounter ?? 0) >= 2 },
      { id: 'preview-serves', label: 'A live preview answers on its own URL', check: (w) => (w.ci.previews ?? []).some((p) => {
        const res = httpRequest(w, `http://${p.url}/health`);
        return res.ok && res.status === 200;
      }) },
      { id: 'ephemeral', label: 'Ephemerality proven: a preview auto-destroyed on schedule', check: (w) => Number(w.flags.previewsDestroyed ?? 0) >= 1 }
    ],
    hints: [
      'EDITOR → .ci/pipeline.yml, add after push:\n  - name: preview\n    uses: sim/preview\nThen commit (git add .ci/pipeline.yml && git commit -m "preview envs").',
      'CI tab → RUN PIPELINE. The run spins up pr-1.preview.{domain} with the image it just built. Run it AGAIN for a second PR: pr-2 gets its own isolated environment.',
      'curl http://pr-1.preview.{domain}/health works from the laptop — that is a full environment per PR. Now prove ephemerality: let pr-1 age (it self-destructs 120 sim minutes after birth), then RUN PIPELINE again so a fresh pr-2 is live while the old one is gone. Ephemeral is a promise, and the platform keeps it.'
    ],
    rewards: { cash: 7000, xp: { cicd: 60 } },
    onStart: (w) => audit(w, 'sam (qa)', 'game', 'Sam: "Review meetings would be shorter if every PR had a URL. Not a shared staging URL. ITS OWN."'),
    onComplete: (w) => audit(w, 'system', 'game', 'Every pull request gets a stage, every stage evaporates on schedule. "Works on my laptop" is dead.')
  },
  // -------------------------------------------------------- 39
  {
    id: 'm39-tracing',
    index: 39,
    title: 'Follow the trace',
    phase: 'platform',
    story: 'p95 latency is creeping up and everyone has a theory: the app, the network, the database, Mercury in retrograde. Averages cannot settle this — traces can. Turn on distributed tracing, follow one request across lb → api → db, and fix what the spans actually blame.',
    objective: 'Enable tracing (MONITORING → TRACING), let it sample, and ANALYZE — identify the true bottleneck. It will be the database: fix connection churn with a pooler (pgbouncer), then wire an SLO-aware alert on the db latency metric.',
    coaching: 'MONITORING → TRACING: ENABLE TRACING, wait for ≥10 traces, hit ANALYZE. The db span will dominate (connection churn under load). DATABASE tab → ENABLE PGBOUNCER. Then MONITORING → alert rules → new rule: db_p95_ms > 900.',
    skills: ['observability', 'databases'],
    requirements: [
      { id: 'tracing-on', label: 'Distributed tracing enabled', check: (w) => Boolean(w.flags.tracingEnabled) },
      { id: 'spans', label: 'At least 10 traces sampled', check: (w) => (w.traces?.length ?? 0) >= 10 },
      { id: 'bottleneck', label: 'Bottleneck identified by trace analysis (the db, of course)', check: (w) => Boolean(w.flags.traceBottleneckFound) },
      { id: 'pooler', label: 'Connection pooler enabled (pgbouncer) — the fix the trace pointed at', check: (w) => Boolean(w.db.pooler) },
      { id: 'latency-alert', label: 'SLO-aware alert on db_p95_ms', check: (w) => w.monitoring.alertRules.some((r) => r.metric === 'db_p95_ms' && r.threshold <= 1200) }
    ],
    hints: [
      'MONITORING tab → TRACING panel → ENABLE TRACING. Every 5 sim minutes one request gets sampled end-to-end: lb → api → db, one span per hop.',
      'Once ≥10 traces exist: ANALYZE. The attribution table shows the db span owning 40%+ of request latency — connection churn, not application code. The fix: DATABASE tab → ENABLE PGBOUNCER (connection pooler in front of Postgres).',
      'Watch the next traces: db spans shrink once the pooler fronts the database. Then make latency page someone BEFORE users notice: MONITORING → alert rules → db_p95_ms, op >, threshold 900.'
    ],
    rewards: { cash: 8000, xp: { observability: 60, databases: 20 } },
    onStart: (w) => audit(w, 'maya', 'game', 'Maya: "p95 is up 40% and everyone blames their favorite subsystem. Stop theorizing — trace one request and read the spans."'),
    onComplete: (w) => audit(w, 'system', 'game', 'The trace settled it: the database connection churn was the latency, the pooler was the fix, and the alert now watches the metric that mattered.')
  },
  // -------------------------------------------------------- 40
  {
    id: 'm40-acquisition',
    index: 40,
    title: 'The acquisition',
    phase: 'platform',
    story: 'The letter of intent is on the table. The acquirers will run due diligence across everything you built — security posture, reliability promises, unit economics, the team, the portfolio — and then the announcement will try to kill your platform with a wave of new users. Pass all five, sign, and survive the wave.',
    objective: 'COMPANY tab → ACQUISITION: open the data room, turn every due-diligence pillar green, accept the term sheet — then hold the platform together through the announcement traffic (a scale event is armed the moment you sign).',
    coaching: 'The data room scores five pillars, each mapped to real state (not vibes): fix red ones by revisiting the systems that own them. After signing: the announcement hits in ~45 sim minutes — keep incidents closed and error rate low through it.',
    skills: ['architecture', 'security', 'finops'],
    requirements: [
      { id: 'data-room', label: 'Data room clean: all five due-diligence pillars green', check: (w) => dueDiligence(w).every((p) => p.pass) },
      { id: 'term-sheet', label: 'Term sheet accepted (the company sold)', check: (w) => Boolean(w.endgame?.termSheetAccepted) },
      { id: 'scale-survived', label: 'The announcement scale event survived (platform held)', check: (w) => Boolean(w.flags.scaleEventSurvived) }
    ],
    hints: [
      'COMPANY tab → ACQUISITION → OPEN DATA ROOM. Five pillars: security & compliance (zero findings), reliability (SLOs + budget), FinOps (budget held), team (≥2 engineers + on-call), portfolio (≥2 products, 10% MRR share). Each red pillar names what it wants.',
      'All green → ACCEPT TERM SHEET. The payout lands in cash and the acquirers announce the deal in ~45 sim minutes — expect a ~2× traffic wave when they do.',
      'Through the announcement: keep incidents closed and error_pct under 2. The check re-runs every 30 sim minutes until the platform proves it holds. Survive it, and the campaign is yours.'
    ],
    rewards: { cash: 25000, xp: { architecture: 80, security: 40, finops: 40 } },
    onStart: (w) => audit(w, 'board', 'game', 'BOARD: "Letter of intent signed by the acquirers. Due diligence opens now — five pillars, all of them real. Make the data room boring."'),
    onComplete: (w) => {
      w.flags.legendMode = true;
      audit(w, 'system', 'game', 'P5 COMPLETE — 40 MISSIONS. ACQUIRED. The platform you built from a dead API on one box carried a company through due diligence and an announcement wave. LEGEND MODE: the world keeps happening — sandbox, challenges and packs are yours.');
    }
  }
];

// Attach free teaching content (file-format lessons) to authoring missions.
for (const m of MISSIONS) {
  const l = LESSONS[m.id];
  if (l) m.lesson = l;
}

/** Lesson with {domain} templates resolved for the view-model. */
export function lessonFilled(l: Lesson, w: World): Lesson {
  const fill = (s: string) => s.replaceAll('{domain}', domain(w));
  return {
    ...l,
    intro: fill(l.intro),
    where: l.where ? fill(l.where) : undefined,
    syntax: l.syntax?.map((r) => ({ term: fill(r.term), text: fill(r.text) })),
    examples: l.examples?.map((e) => ({ label: fill(e.label), code: fill(e.code) })),
    starter: l.starter ? { path: fill(l.starter.path), content: fill(l.starter.content) } : undefined
  };
}
