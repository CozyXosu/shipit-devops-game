import { describe, it, expect } from 'vitest';
import { createWorld } from '../server/src/world';
import { runTerminalInput } from '../server/src/sim/host';
import * as fs from '../server/src/sim/fs';

function game() {
  const world = createWorld('Acme Metrics', 'you');
  return world;
}

const sh = (w: ReturnType<typeof game>, cmd: string) => runTerminalInput(w, cmd).lines.map((l) => l.text).join('\n');

describe('virtual filesystem + shell', () => {
  it('ls/cat/grep with pipes and redirects', () => {
    const w = game();
    // ssh in for a populated fs
    sh(w, 'ssh dev@203.0.113.10');
    sh(w, 'dev');
    expect(sh(w, 'pwd')).toBe('/home/dev');
    expect(sh(w, 'ls')).toContain('notes.txt');
    expect(sh(w, 'cat notes.txt')).toContain('EADDRINUSE');
    expect(sh(w, 'grep -i enospc notes.txt')).toBe(''); // no ENOSPC yet
    expect(sh(w, 'cat notes.txt | grep -c api')).toMatch(/^\d+$/);
    expect(sh(w, 'cat notes.txt | grep -i systemctl')).toContain('systemctl');
    // redirect
    sh(w, 'echo hello > /tmp/x.txt');
    expect(fs.readFile(w.hosts['web-01'].fs, '/tmp/x.txt')).toBe('hello');
    sh(w, 'echo world >> /tmp/x.txt');
    expect(fs.readFile(w.hosts['web-01'].fs, '/tmp/x.txt')).toBe('hello\nworld');
    // pipeline of two commands
    expect(sh(w, 'cat /tmp/x.txt | grep world')).toContain('world');
  });

  it('path resolution: cd, .., absolute', () => {
    const w = game();
    sh(w, 'ssh dev@203.0.113.10');
    sh(w, 'dev');
    expect(sh(w, 'cd /opt/app && pwd')).toBe('/opt/app');
    expect(sh(w, 'cd ../.. && pwd')).toBe('/');
    expect(sh(w, 'ls /opt/app')).toContain('server.js');
  });

  it('df reflects disk; du reports file sizes', () => {
    const w = game();
    sh(w, 'ssh dev@203.0.113.10');
    sh(w, 'dev');
    expect(sh(w, 'df -h')).toMatch(/\/dev\/vda1/);
    expect(sh(w, 'du -sh /var/log')).toMatch(/M\s+\/var\/log/);
  });

  it('chmod validates modes', () => {
    const w = game();
    sh(w, 'ssh dev@203.0.113.10');
    sh(w, 'dev');
    expect(sh(w, 'chmod 640 notes.txt')).toBe('');
    expect(sh(w, 'chmod abc notes.txt')).toContain('invalid mode');
    expect(fs.getNode(w.hosts['web-01'].fs, '/home/dev/notes.txt')?.mode).toBe(0o640);
  });

  it('unknown command returns 127-style message', () => {
    const w = game();
    const out = runTerminalInput(w, 'frobnicate --now');
    expect(out.lines[0].text).toContain('command not found');
    expect(out.code).toBe(127);
  });
});
