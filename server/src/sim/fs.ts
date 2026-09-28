import { VDir, VFile, VNode } from '../types';

export function newDir(mode = 0o755, owner = 'root'): VDir {
  return { type: 'dir', children: {}, mode, owner, mtime: Date.now() };
}

export function newFile(content = '', mode = 0o644, owner = 'root'): VFile {
  return { type: 'file', content, mode, owner, mtime: Date.now() };
}

/** Normalize a path (absolute or relative to cwd) into a clean absolute path. */
export function resolvePath(cwd: string, p: string): string {
  if (!p || p === '.') p = cwd;
  const abs = p.startsWith('/') ? p : `${cwd}/${p}`;
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function getNode(root: VDir, path: string): VNode | null {
  if (path === '/' || path === '') return root;
  let cur: VNode = root;
  for (const seg of path.split('/').filter(Boolean)) {
    if (cur.type !== 'dir') return null;
    const next: VNode | undefined = cur.children[seg];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export function getDir(root: VDir, path: string): VDir | null {
  const n = getNode(root, path);
  return n && n.type === 'dir' ? n : null;
}

export function getFile(root: VDir, path: string): VFile | null {
  const n = getNode(root, path);
  return n && n.type === 'file' ? n : null;
}

export function readFile(root: VDir, path: string): string | null {
  const f = getFile(root, path);
  return f ? f.content : null;
}

/** Create intermediate directories. Returns the dir or null if a file blocks. */
export function ensureDir(root: VDir, path: string, owner = 'root'): VDir | null {
  let cur = root;
  for (const seg of path.split('/').filter(Boolean)) {
    const next = cur.children[seg];
    if (!next) {
      const d = newDir(0o755, owner);
      cur.children[seg] = d;
      cur = d;
    } else if (next.type === 'dir') {
      cur = next;
    } else {
      return null;
    }
  }
  return cur;
}

export function writeFile(root: VDir, path: string, content: string, owner = 'root', mode = 0o644): { ok: boolean; error?: string } {
  const dirPath = path.slice(0, path.lastIndexOf('/')) || '/';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dir = ensureDir(root, dirPath, owner);
  if (!dir) return { ok: false, error: `${dirPath}: Not a directory` };
  const existing = dir.children[name];
  if (existing && existing.type === 'dir') return { ok: false, error: `${path}: Is a directory` };
  if (existing && existing.type === 'file') {
    existing.content = content;
    existing.mtime = Date.now();
  } else {
    dir.children[name] = newFile(content, mode, owner);
  }
  return { ok: true };
}

export function rmNode(root: VDir, path: string): { ok: boolean; error?: string } {
  if (path === '/') return { ok: false, error: 'cannot remove /' };
  const dirPath = path.slice(0, path.lastIndexOf('/')) || '/';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dir = getDir(root, dirPath);
  if (!dir || !dir.children[name]) return { ok: false, error: `${path}: No such file or directory` };
  delete dir.children[name];
  return { ok: true };
}

export function listDir(root: VDir, path: string): { name: string; node: VNode }[] | null {
  const dir = getDir(root, path);
  if (!dir) return null;
  return Object.entries(dir.children)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, node]) => ({ name, node }));
}

export function nodeSizeMB(node: VNode): number {
  if (node.type === 'file') return node.diskSizeMB ?? Math.max(0.000001, node.content.length / 1_000_000);
  let sum = 0;
  for (const c of Object.values(node.children)) sum += nodeSizeMB(c);
  return sum;
}

export function chmodNode(root: VDir, path: string, mode: number, recursive: boolean): { ok: boolean; error?: string } {
  const node = getNode(root, path);
  if (!node) return { ok: false, error: `${path}: No such file or directory` };
  const apply = (n: VNode) => { n.mode = mode; };
  apply(node);
  if (recursive && node.type === 'dir') walkNodes(node, apply);
  return { ok: true };
}

export function chownNode(root: VDir, path: string, owner: string, recursive: boolean): { ok: boolean; error?: string } {
  const node = getNode(root, path);
  if (!node) return { ok: false, error: `${path}: No such file or directory` };
  const apply = (n: VNode) => { n.owner = owner; };
  apply(node);
  if (recursive && node.type === 'dir') walkNodes(node, apply);
  return { ok: true };
}

export function walkNodes(node: VDir, fn: (n: VNode, path: string) => void, base = ''): void {
  for (const [name, child] of Object.entries(node.children)) {
    const p = `${base}/${name}`;
    fn(child, p);
    if (child.type === 'dir') walkNodes(child, fn, p);
  }
}

export function modeString(node: VNode): string {
  const m = node.mode;
  const bit = (v: number, chars: string) =>
    (v & 4 ? chars[0] : '-') + (v & 2 ? chars[1] : '-') + (v & 1 ? chars[2] : '-');
  const type = node.type === 'dir' ? 'd' : '-';
  return type + bit((m >> 6) & 7, 'rwx') + bit((m >> 3) & 7, 'rwx') + bit(m & 7, 'rwx');
}

export function parseMode(s: string): number | null {
  if (/^[0-7]{3,4}$/.test(s)) return parseInt(s.slice(-3), 8);
  const sym = /^([ugoa]*)([+-=])([rwx]+)$/.exec(s);
  if (!sym) return null;
  return null; // symbolic modes not needed for the slice; numeric supported
}
