import { describe, it, expect } from 'vitest';
import { createWorld } from '../server/src/world';
import { runTerminalInput } from '../server/src/sim/host';
import { status, initRepo } from '../server/src/sim/git';
import * as fs from '../server/src/sim/fs';

function sh(w: ReturnType<typeof createWorld>, cmd: string) {
  return runTerminalInput(w, cmd).lines.map((l) => l.text).join('\n');
}

function inServer(w: ReturnType<typeof createWorld>) {
  sh(w, 'ssh dev@203.0.113.10');
  sh(w, 'dev');
}

describe('git simulation', () => {
  it('init requires identity before commit', () => {
    const w = createWorld('GitCo', 'you');
    inServer(w);
    sh(w, 'cd /opt/app');
    expect(sh(w, 'git init')).toContain('Initialized empty Git repository');
    sh(w, 'git add -A');
    const out = sh(w, 'git commit -m "x"');
    expect(out).toContain('Author identity unknown');
  });

  it('add + commit with .gitignore; status clean', () => {
    const w = createWorld('GitCo', 'you');
    inServer(w);
    sh(w, 'cd /opt/app');
    sh(w, 'git init');
    sh(w, 'git config user.name "Dev"');
    sh(w, 'git config user.email "dev@gitco.dev"');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/.gitignore', 'node_modules/\n.env\n*.log\n');
    sh(w, 'git add -A');
    expect(sh(w, 'git commit -m "initial"')).toContain('initial');
    const repo = w.git['/opt/app']!;
    const s = status(w, repo);
    expect(s.untracked.length).toBe(0);
    expect(s.unstaged.length).toBe(0);
    expect(sh(w, 'git log --oneline')).toContain('initial');
  });

  it('merge conflict appears and is resolvable', () => {
    const w = createWorld('GitCo', 'you');
    inServer(w);
    sh(w, 'cd /opt/app');
    sh(w, 'git init');
    sh(w, 'git config user.name "Dev"');
    sh(w, 'git config user.email "dev@git.dev"');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/.gitignore', '.env\n');
    sh(w, 'git add -A');
    sh(w, 'git commit -m "base"');

    // branch and change config.js
    sh(w, 'git checkout -b feature/x');
    const cfg = fs.readFile(w.hosts['web-01'].fs, '/opt/app/config.js')!;
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/config.js', cfg.replace('apiTimeout: 30', 'apiTimeout: 90'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "timeout 90"');

    // conflicting change on main
    sh(w, 'git checkout main');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/config.js', cfg.replace('apiTimeout: 30', 'apiTimeout: 10'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "timeout 10"');

    // merge feature into main -> conflict
    const mergeOut = sh(w, 'git merge feature/x');
    expect(mergeOut).toContain('CONFLICT');
    const conflicted = fs.readFile(w.hosts['web-01'].fs, '/opt/app/config.js')!;
    expect(conflicted).toContain('<<<<<<<');
    const repo = w.git['/opt/app']!;
    expect(status(w, repo).conflicted).toContain('config.js');

    // resolve
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/config.js', cfg.replace('apiTimeout: 30', 'apiTimeout: 90'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "merge resolved"');
    expect(repo.merging).toBeNull();
    const head = repo.commits[repo.branches['main'].commit];
    expect(head.parents.length).toBe(2);
    expect(status(w, repo).conflicted.length).toBe(0);
  });

  it('push sets remote branch and flag', () => {
    const w = createWorld('GitCo', 'you');
    inServer(w);
    sh(w, 'cd /opt/app');
    sh(w, 'git init');
    sh(w, 'git config user.name "D"');
    sh(w, 'git config user.email "d@x.dev"');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/.gitignore', '.env\n');
    sh(w, 'git add -A');
    sh(w, 'git commit -m "c1"');
    w.git['/opt/app']!.remotes['origin'] = 'git@x.dev:a/b.git';
    sh(w, 'git push origin main');
    const repo = w.git['/opt/app']!;
    expect(repo.remoteBranches['origin/main']).toBeTruthy();
    expect(sh(w, 'git status')).toContain("up to date with 'origin/main'");
  });
});

describe('git advanced commands (revert, fetch, restore, reset, stash, cherry-pick…)', () => {
  function setup(w: ReturnType<typeof createWorld>) {
    inServer(w);
    sh(w, 'cd /opt/app');
    sh(w, 'git init');
    sh(w, 'git config user.name "Dev"');
    sh(w, 'git config user.email "dev@x.dev"');
    fs.writeFile(w.hosts['web-01'].fs, '/opt/app/.gitignore', '.env\n');
    sh(w, 'git add -A');
    sh(w, 'git commit -m "base"');
    return w;
  }
  const readApp = (w: ReturnType<typeof createWorld>, p: string) => fs.readFile(w.hosts['web-01'].fs, `/opt/app/${p}`)!;
  const writeApp = (w: ReturnType<typeof createWorld>, p: string, c: string) => fs.writeFile(w.hosts['web-01'].fs, `/opt/app/${p}`, c, 'dev');

  it('config accepts --global', () => {
    const w = createWorld('GitCo', 'you');
    inServer(w);
    expect(sh(w, 'git config --global user.name "G"')).toBe('');
    expect(w.session.env.GIT_AUTHOR_NAME).toBe('G');
  });

  it('revert undoes the last commit and restores content', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 60'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "raise timeout"');
    expect(readApp(w, 'config.js')).toContain('apiTimeout: 60');
    const out = sh(w, 'git revert HEAD');
    expect(out).toContain('Revert');
    expect(readApp(w, 'config.js')).toContain('apiTimeout: 30');
    expect(sh(w, 'git status')).toContain('working tree clean');
    expect(sh(w, 'git log --oneline')).toContain('Revert "raise timeout"');
    // revert refuses on a dirty tree
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 99'));
    expect(sh(w, 'git revert HEAD')).toContain('would be overwritten');
  });

  it('fetch reports remote movement and status shows behind', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    const repo = w.git['/opt/app']!;
    repo.remotes['origin'] = 'git@x.dev:a/b.git';
    expect(sh(w, 'git fetch origin')).toContain('Fetching origin');
    // simulate upstream moving ahead
    repo.remoteBranches['origin/main'] = 'deadbeef';
    expect(sh(w, 'git fetch origin')).toContain('deadbee');
    expect(sh(w, 'git status')).toContain("behind 'origin/main' by 1 commit");
  });

  it('restore discards unstaged edits; --staged unstages', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 90'));
    expect(sh(w, 'git restore --staged config.js')).toBe('');
    sh(w, 'git add config.js');
    sh(w, 'git restore --staged config.js');
    const repo = w.git['/opt/app']!;
    expect(repo.staging['config.js']).toBeUndefined();
    expect(sh(w, 'git restore config.js')).toBe('');
    expect(readApp(w, 'config.js')).toBe(orig);
    expect(sh(w, 'git status')).toContain('working tree clean');
  });

  it('reset --hard drops staging and restores the tree', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('retryMax: 3', 'retryMax: 99'));
    sh(w, 'git add config.js');
    const out = sh(w, 'git reset --hard');
    expect(out).toContain('HEAD is now at');
    expect(readApp(w, 'config.js')).toBe(orig);
    expect(sh(w, 'git status')).toContain('working tree clean');
  });

  it('branch -d refuses unmerged branches, -D forces', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    sh(w, 'git checkout -b feature');
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 77'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "unmerged work"');
    sh(w, 'git checkout main');
    expect(sh(w, 'git branch -d feature')).toContain('not fully merged');
    expect(sh(w, 'git branch -D feature')).toContain('Deleted branch');
    expect(sh(w, 'git branch')).not.toContain('feature');
  });

  it('cherry-pick copies a commit onto the current branch', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    sh(w, 'git checkout -b feature');
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 55'));
    sh(w, 'git add config.js');
    sh(w, 'git commit -m "timeout 55"');
    const sha = w.git['/opt/app']!.branches['feature'].commit;
    sh(w, 'git checkout main');
    const out = sh(w, `git cherry-pick ${sha}`);
    expect(out).toContain('timeout 55');
    expect(readApp(w, 'config.js')).toContain('apiTimeout: 55');
    expect(sh(w, 'git log --oneline')).toContain('cherry-picked from');
    expect(sh(w, 'git status')).toContain('working tree clean');
  });

  it('stash push/pop round-trips dirty state', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    const orig = readApp(w, 'config.js');
    writeApp(w, 'config.js', orig.replace('apiTimeout: 30', 'apiTimeout: 42'));
    const stashed = sh(w, 'git stash');
    expect(stashed).toContain('Saved working directory');
    expect(readApp(w, 'config.js')).toBe(orig);
    expect(sh(w, 'git status')).toContain('working tree clean');
    expect(sh(w, 'git stash list')).toContain('stash@{0}');
    sh(w, 'git stash pop');
    expect(readApp(w, 'config.js')).toContain('apiTimeout: 42');
    const repo = w.git['/opt/app']!;
    expect(repo.staging['config.js']).toContain('42');
  });

  it('git mv and git rm stage the change', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    expect(sh(w, 'git mv orders.js billing.js')).toBe('');
    expect(readApp(w, 'billing.js')).toBeTruthy();
    const fsNode = fs.getNode(w.hosts['web-01'].fs, '/opt/app/orders.js');
    expect(fsNode).toBeNull();
    sh(w, 'git commit -m "rename orders to billing"');
    expect(sh(w, 'git rm --cached README.md')).toContain("rm 'README.md'");
    const repo = w.git['/opt/app']!;
    expect(repo.staging['README.md']).toBeNull();
    // file still on disk with --cached
    expect(readApp(w, 'README.md')).toBeTruthy();
  });

  it('show and blame render history info; help lists commands', () => {
    const w = createWorld('GitCo', 'you');
    setup(w);
    expect(sh(w, 'git show HEAD')).toContain('Author: Dev');
    expect(sh(w, 'git show HEAD')).toContain('diff --git');
    expect(sh(w, 'git blame config.js')).toMatch(/[0-9a-f]{7} \(Dev\s+day \d+\)\s+\d+\)/);
    expect(sh(w, 'git help')).toContain('revert');
    expect(sh(w, 'git help')).toContain('stash');
  });
});
