// Shell lexer/parser: quotes, pipes, redirects, ';', env-var expansion.
// This parses PLAYER INPUT for the simulated shell — it never touches the host.

export interface Cmd {
  argv: string[];
  stdinFile?: string;
  stdoutFile?: string;
  stderrFile?: string;
  append?: boolean;
}

export interface Pipeline { cmds: Cmd[] }

export interface ParsedLine { pipelines: Pipeline[]; envPre: Record<string, string> }

export function tokenize(line: string): string[] {
  const toks: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  const push = () => { if (has) { toks.push(cur); cur = ''; has = false; } };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch; has = true;
    } else if (ch === ' ' || ch === '\t') {
      push();
    } else if (ch === '|' || ch === ';' || ch === '>' || ch === '<') {
      push();
      // >> handled by peeking
      if (ch === '>' && line[i + 1] === '>') { toks.push('>>'); i++; }
      else toks.push(ch);
    } else {
      cur += ch; has = true;
    }
  }
  push();
  return toks;
}

function expandToken(tok: string, env: Record<string, string>): string {
  return tok.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => env[a ?? b] ?? '');
}

/** Split a line on && and || (quote-aware) for sequential execution. */
export function splitLogical(line: string): { text: string; join: '&&' | '||' | null }[] {
  const segs: { text: string; join: '&&' | '||' | null }[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; i++; continue; }
    if ((ch === '&' && line[i + 1] === '&') || (ch === '|' && line[i + 1] === '|')) {
      const join = ch === '&' ? '&&' : '||';
      segs.push({ text: cur, join: segs.length === 0 ? null : join });
      cur = '';
      i += 2;
      continue;
    }
    cur += ch;
    i++;
  }
  segs.push({ text: cur, join: segs.length === 0 ? null : null });
  return segs.filter((s) => s.text.trim().length > 0);
}

/** Parse one command line into pipelines separated by ';'. */
export function parseLine(line: string, env: Record<string, string>): ParsedLine {
  const toks = tokenize(line);
  const out: ParsedLine = { pipelines: [], envPre: {} };
  let i = 0;
  // leading VAR=val assignments
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i])) {
    const [k, ...rest] = toks[i].split('=');
    out.envPre[k] = expandToken(rest.join('='), env);
    i++;
  }
  while (i < toks.length) {
    // skip stray separators
    while (i < toks.length && (toks[i] === ';' || toks[i] === '|')) i++;
    if (i >= toks.length) break;
    const pipeline: Pipeline = { cmds: [] };
    let cmd: Cmd = { argv: [] };
    let expect = 'argv' as 'argv' | 'stdoutFile' | 'stdinFile' | 'stderrFile';
    let redirect: 'stdoutFile' | 'stderrFile' = 'stdoutFile';
    for (; i < toks.length && toks[i] !== ';'; i++) {
      const t = toks[i];
      if (t === '|') { pipeline.cmds.push(cmd); cmd = { argv: [] }; expect = 'argv'; continue; }
      if (t === '>' || t === '>>') { expect = 'stdoutFile'; cmd.append = t === '>>'; continue; }
      if (t === '2>') { redirect = 'stderrFile'; expect = 'stderrFile'; continue; }
      if (t === '<') { expect = 'stdinFile'; continue; }
      if (expect === 'stdoutFile') { cmd.stdoutFile = t; expect = 'argv'; continue; }
      if (expect === 'stderrFile') { cmd.stderrFile = t; expect = 'argv'; redirect = 'stdoutFile'; continue; }
      if (expect === 'stdinFile') { cmd.stdinFile = t; expect = 'argv'; continue; }
      cmd.argv.push(expandToken(t, env));
    }
    if (cmd.argv.length || cmd.stdoutFile) pipeline.cmds.push(cmd);
    if (pipeline.cmds.length) out.pipelines.push(pipeline);
  }
  return out;
}
