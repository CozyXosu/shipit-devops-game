// Git simulation: real commit DAG, staging area, branches, three-way merge
// with conflict markers, remote push/pull. Worktree = the host's virtual fs.
import { World, GitRepo, GitCommit } from '../types';
import { listDir, readFile, writeFile, rmNode } from './fs';
import { OutLine } from '../types';

const GITIGNORE_DEFAULT = `node_modules/
.env
*.log
dist/
`;

function sha(world: World): string {
  return Math.floor(Math.abs(Math.sin(world.nowMin * 7 + world.audit.length + Math.random()) * 1e9)).toString(16).padStart(8, '0').slice(0, 7);
}

export function getRepo(world: World, path: string): GitRepo | null {
  return world.git[path] ?? null;
}

export function findRepoFor(world: World, cwd: string): GitRepo | null {
  const matches = Object.keys(world.git).filter((p) => cwd === p || cwd.startsWith(p + '/'));
  if (!matches.length) return null;
  return world.git[matches.sort((a, b) => b.length - a.length)[0]];
}

export function relPath(repoPath: string, absPath: string): string {
  return absPath === repoPath ? '.' : absPath.slice(repoPath.length + 1);
}

export function initRepo(world: World, path: string): GitRepo {
  const repo: GitRepo = {
    path,
    head: 'main',
    branches: { main: { commit: '' } },
    commits: {},
    staging: {},
    remotes: {},
    remoteBranches: {},
    merging: null
  };
  world.git[path] = repo;
  return repo;
}

function gitignorePatterns(repo: GitRepo, world: World): string[] {
  const content = readFile(world.hosts[hostOf(world)].fs, repo.path + '/.gitignore') ?? '';
  return content.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

let cachedWorld: World | null = null;
function hostOf(world: World): string {
  cachedWorld = world;
  return 'web-01';
}

export function isIgnored(repo: GitRepo, world: World, relFilePath: string): boolean {
  for (const pat of gitignorePatterns(repo, world)) {
    const p = pat.replace(/\/$/, '');
    if (p === relFilePath) return true;
    if (pat.endsWith('/') && relFilePath.startsWith(p + '/')) return true;
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '($|/)');
      if (re.test(relFilePath)) return true;
    }
  }
  return false;
}

/** Files currently on disk under repo path (relative). Repos live on web-01. */
export function worktreeFiles(world: World, repo: GitRepo): string[] {
  const out: string[] = [];
  const fsRoot = world.hosts['web-01'].fs;
  const walk = (abs: string, rel: string) => {
    const entries = listDir(fsRoot, abs);
    for (const { name, node } of entries ?? []) {
      if (name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (node.type === 'dir') walk(`${abs}/${name}`, r);
      else out.push(r);
    }
  };
  walk(repo.path, '');
  return out;
}

export function commitTree(world: World, repo: GitRepo, c: GitCommit): void {
  const tree: Record<string, string> = {};
  const parentTree = c.parents.length ? { ...repo.commits[c.parents[0]].tree } : {};
  for (const [p, content] of Object.entries(parentTree)) tree[p] = content;
  for (const [p, content] of Object.entries(c.tree)) {
    if (content === null || content === undefined) delete tree[p];
    else tree[p] = content;
  }
  c.tree = tree;
}

export function makeCommit(world: World, repo: GitRepo, message: string, changed: string[]): GitCommit {
  const parent = repo.branches[repo.head]?.commit ?? '';
  const staged: Record<string, string | null> = {};
  for (const [p, c] of Object.entries(repo.staging)) staged[p] = c;
  const c: GitCommit = {
    sha: sha(world),
    message,
    parents: parent ? [parent] : [],
    author: world.session.env.GIT_AUTHOR_NAME ?? 'you',
    email: world.session.env.GIT_AUTHOR_EMAIL ?? 'you@' + world.company.slug + '.dev',
    timeMin: world.nowMin,
    tree: staged as Record<string, string>,
    changed
  };
  commitTree(world, repo, c);
  repo.commits[c.sha] = c;
  repo.branches[repo.head] = { commit: c.sha };
  repo.staging = {};
  return c;
}

export interface StatusInfo {
  branch: string;
  staged: { path: string; kind: 'added' | 'modified' | 'deleted' }[];
  unstaged: { path: string; kind: 'modified' | 'deleted' }[];
  untracked: string[];
  conflicted: string[];
  ahead: number;
  behind: number;
  merging: { from: string; conflicted: string[] } | null;
}

function countAheadBehind(repo: GitRepo): { ahead: number; behind: number } {
  const remoteRef = `origin/${repo.head}`;
  const remoteSha = repo.remoteBranches[remoteRef];
  if (!remoteSha || !repo.branches[repo.head]?.commit) return { ahead: 0, behind: 0 };
  if (!repo.commits[remoteSha]) return { ahead: 0, behind: 1 }; // upstream has commits we have not merged
  const seenLocal = new Set<string>();
  let cur: string | undefined = repo.branches[repo.head].commit;
  let localHasRemote = false;
  while (cur && repo.commits[cur]) {
    if (cur === remoteSha) { localHasRemote = true; break; }
    seenLocal.add(cur);
    cur = repo.commits[cur].parents[0];
  }
  let behind = 0;
  cur = remoteSha;
  while (cur && repo.commits[cur] && !seenLocal.has(cur)) {
    if (cur === repo.branches[repo.head].commit) return { ahead: seenLocal.size, behind };
    behind++;
    cur = repo.commits[cur].parents[0];
    if (behind > 100) break;
  }
  return { ahead: localHasRemote ? seenLocal.size : seenLocal.size, behind };
}

export function status(world: World, repo: GitRepo): StatusInfo {
  const fs = world.hosts['web-01'].fs;
  const headCommit = repo.branches[repo.head]?.commit ? repo.commits[repo.branches[repo.head].commit] : null;
  const headTree: Record<string, string> = headCommit ? headCommit.tree : {};
  const staged: StatusInfo['staged'] = [];
  for (const [p, c] of Object.entries(repo.staging)) {
    if (c === null) staged.push({ path: p, kind: 'deleted' });
    else if (!(p in headTree)) staged.push({ path: p, kind: 'added' });
    else if (headTree[p] !== c) staged.push({ path: p, kind: 'modified' });
  }
  const unstaged: StatusInfo['unstaged'] = [];
  const untracked: string[] = [];
  const diskFiles = worktreeFiles(world, repo);
  for (const rel of diskFiles) {
    if (isIgnored(repo, world, rel)) continue;
    if (repo.staging[rel] !== undefined) continue; // staged version wins for status display
    if (!(rel in headTree)) { untracked.push(rel); continue; }
    const content = readFile(fs, `${repo.path}/${rel}`);
    if (content !== headTree[rel]) unstaged.push({ path: rel, kind: 'modified' });
  }
  for (const p of Object.keys(headTree)) {
    if (!diskFiles.includes(p) && repo.staging[p] === undefined && !isIgnored(repo, world, p)) {
      unstaged.push({ path: p, kind: 'deleted' });
    }
  }
  const { ahead, behind } = countAheadBehind(repo);
  return {
    branch: repo.head,
    staged,
    unstaged,
    untracked,
    conflicted: repo.merging?.conflicted ?? [],
    ahead,
    behind,
    merging: repo.merging ? { from: repo.merging.from, conflicted: repo.merging.conflicted } : null
  };
}

function mergeBase(repo: GitRepo, a: string, b: string): string | null {  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift()!;
    if (ancestors.has(cur) || !repo.commits[cur]) continue;
    ancestors.add(cur);
    queue.push(...repo.commits[cur].parents);
  }
  const queue2 = [b];
  const seen = new Set<string>();
  while (queue2.length) {
    const cur = queue2.shift()!;
    if (seen.has(cur) || !repo.commits[cur]) continue;
    seen.add(cur);
    if (ancestors.has(cur)) return cur;
    queue2.push(...repo.commits[cur].parents);
  }
  return null;
}

export function mergeBranch(world: World, repo: GitRepo, fromBranch: string): { lines: OutLine[]; conflicted: boolean } {
  const lines: OutLine[] = [];
  const ours = repo.branches[repo.head]?.commit;
  const theirs = repo.branches[fromBranch]?.commit ?? repo.remoteBranches[fromBranch];
  if (!theirs) return { lines: [{ text: `merge: ${fromBranch} - not something we can merge`, cls: 'err' }], conflicted: false };
  if (!ours) {
    // fast-forward empty main
    repo.branches[repo.head] = { commit: theirs };
    return { lines: [{ text: `Updating to ${theirs.slice(0, 7)}` }], conflicted: false };
  }
  if (theirs === ours) return { lines: [{ text: 'Already up to date.' }], conflicted: false };
  const base = mergeBase(repo, ours, theirs);
  if (base === theirs) return { lines: [{ text: 'Already up to date.' }], conflicted: false };

  const baseCommit = base ? repo.commits[base] : null;
  const oursCommit = repo.commits[ours];
  const theirsCommit = repo.commits[theirs];
  const fs = world.hosts['web-01'].fs;

  const paths = new Set<string>([...Object.keys(theirsCommit.tree)]);
  if (baseCommit) for (const p of Object.keys(baseCommit.tree)) paths.add(p);
  const conflicted: string[] = [];
  const taken: string[] = [];

  for (const p of paths) {
    const baseC = baseCommit ? baseCommit.tree[p] : undefined;
    const oursC = oursCommit.tree[p];
    const theirsC = theirsCommit.tree[p];
    if (theirsC === oursC) continue;
    if (baseC === oursC) {
      // take theirs
      if (theirsC === undefined) rmNode(fs, `${repo.path}/${p}`);
      else writeFile(fs, `${repo.path}/${p}`, theirsC);
      taken.push(p);
    } else if (baseC !== theirsC) {
      // both changed differently -> conflict
      const oursTxt = oursC ?? '';
      const theirsTxt = theirsC ?? '';
      const marker = `<<<<<<< HEAD\n${oursTxt}\n=======\n${theirsTxt}\n>>>>>>> ${fromBranch}\n`;
      writeFile(fs, `${repo.path}/${p}`, marker);
      conflicted.push(p);
    }
  }

  if (conflicted.length) {
    repo.merging = { into: repo.head, from: fromBranch, conflicted };
    lines.push({ text: `Auto-merging ${conflicted.join(', ')}` });
    lines.push({ text: `CONFLICT (content): Merge conflict in ${conflicted[0]}`, cls: 'err' });
    lines.push({ text: 'Automatic merge failed; fix conflicts and then commit the result.', cls: 'warn' });
    world.audit.push({ t: world.nowMin, actor: 'system', kind: 'git', text: `Merge conflict on ${conflicted.join(', ')}` });
    return { lines, conflicted: true };
  }
  // clean merge: create merge commit
  const allStaged: Record<string, string | null> = {};
  for (const p of taken) {
    const content = readFile(fs, `${repo.path}/${p}`);
    allStaged[p] = content ?? null;
  }
  repo.staging = allStaged;
  const mergeCommit = makeCommit(world, repo, `Merge branch '${fromBranch}' into ${repo.head}`, taken);
  mergeCommit.parents = [ours, theirs];
  lines.push({ text: `Merge made by the 'ort' strategy.`, cls: 'ok' });
  return { lines, conflicted: false };
}

export function completeMergeCommit(world: World, repo: GitRepo): GitCommit {
  const merging = repo.merging!;
  const fromBranch = merging.from;
  const theirs = repo.branches[fromBranch]?.commit ?? repo.remoteBranches[fromBranch] ?? '';
  const ours = repo.branches[repo.head]?.commit ?? '';
  const c = makeCommit(world, repo, `Merge branch '${fromBranch}' into ${repo.head}`, Object.keys(repo.staging));
  c.parents = [ours, theirs].filter(Boolean);
  repo.merging = null;
  return c;
}

// ---------- ref resolution & tree diffs (revert/reset/show/cherry-pick) ----------

/** Resolve HEAD, HEAD~n, branch names, origin/x and (short) shas to a commit. */
export function resolveRef(repo: GitRepo, ref: string | undefined): GitCommit | null {
  if (!ref || ref === 'HEAD') {
    const sha = repo.branches[repo.head]?.commit;
    return sha ? repo.commits[sha] ?? null : null;
  }
  const tilted = /^(.+)~(\d+)$/.exec(ref);
  if (tilted) {
    let c = resolveRef(repo, tilted[1]);
    for (let i = 0; i < Number(tilted[2]) && c; i++) {
      c = c.parents[0] ? repo.commits[c.parents[0]] ?? null : null;
    }
    return c;
  }
  if (repo.branches[ref]) return repo.commits[repo.branches[ref].commit] ?? null;
  const remoteRef = ref.startsWith('origin/') ? ref : `origin/${ref}`;
  if (repo.remoteBranches[remoteRef]) return repo.commits[repo.remoteBranches[remoteRef]] ?? null;
  const sha = Object.keys(repo.commits).find((s) => s.startsWith(ref));
  return sha ? repo.commits[sha] : null;
}

/** Changed paths of a commit vs its first parent. Value = new content, or null when the commit deleted the file. */
export function treeDiff(repo: GitRepo, c: GitCommit): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const parent = c.parents[0] ? repo.commits[c.parents[0]] : null;
  const paths = new Set<string>([...Object.keys(c.tree), ...(parent ? Object.keys(parent.tree) : [])]);
  for (const p of paths) {
    const a = c.tree[p];
    const b = parent ? parent.tree[p] : undefined;
    if (a !== b) out[p] = a ?? null;
  }
  return out;
}

/** Is `sha` an ancestor of (or equal to) branch head? */
export function isAncestor(repo: GitRepo, sha: string, ofBranch: string): boolean {
  let cur: string | undefined = repo.branches[ofBranch]?.commit;
  let guard = 0;
  while (cur && repo.commits[cur] && guard++ < 500) {
    if (cur === sha) return true;
    cur = repo.commits[cur].parents[0];
  }
  return false;
}

export function logLines(repo: GitRepo, oneline: boolean, max = 12): OutLine[] {  const lines: OutLine[] = [];
  let cur = repo.branches[repo.head]?.commit;
  let n = 0;
  while (cur && repo.commits[cur] && n < max) {
    const c = repo.commits[cur];
    if (oneline) lines.push({ text: `${c.sha.slice(0, 7)} ${c.message}${c.parents.length > 1 ? ' (merge)' : ''}` });
    else {
      lines.push({ text: `commit ${c.sha}` });
      lines.push({ text: `Author: ${c.author} <${c.email}>`, cls: 'dim' });
      lines.push({ text: `Date:   day ${Math.floor(c.timeMin / 1440) + 1}`, cls: 'dim' });
      lines.push({ text: `    ${c.message}` });
      lines.push({ text: '' });
    }
    cur = c.parents[0];
    n++;
  }
  return lines;
}

export { GITIGNORE_DEFAULT };
