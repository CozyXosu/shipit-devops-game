// Small YAML subset parser — enough for pipelines, service units and config
// files the game uses. Indentation-based maps, lists of maps, scalars, quotes,
// comments. Produces clear errors (players WILL write broken YAML).
export interface YamlError { line: number; message: string }

export function parseYaml(text: string): { value: unknown; error?: YamlError } {
  const lines = text.split('\n');
  type Item = { indent: number; content: string; line: number };
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^ */)![0].length;
    if (noComment.trim() === '---') continue;
    items.push({ indent, content: noComment.trim(), line: i + 1 });
  }
  let pos = 0;
  function parseBlock(indent: number): unknown {
    if (pos >= items.length) return null;
    const first = items[pos];
    if (first.indent < indent) return null;
    if (first.content.startsWith('- ') || first.content === '-') {
      const list: unknown[] = [];
      while (pos < items.length && items[pos].indent === first.indent && (items[pos].content.startsWith('- ') || items[pos].content === '-')) {
        const it = items[pos];
        const inline = it.content === '-' ? '' : it.content.slice(2);
        if (inline && inline.includes(':') && !isQuoted(inline)) {
          // map starting inline on the "- " line: treat "- k: v" as indent+2 map
          items[pos] = { indent: it.indent + 2, content: inline, line: it.line };
          const sub = parseMap(it.indent + 2);
          list.push(sub);
        } else {
          pos++;
          list.push(parseScalar(inline));
        }
      }
      return list;
    }
    return parseMap(first.indent);
  }
  function parseMap(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (pos < items.length) {
      const it = items[pos];
      if (it.indent > indent) {
        return mapOrError(map, `unexpected indentation at line ${it.line}`);
      }
      if (it.indent < indent) return map;
      if (it.content.startsWith('- ')) return map;
      const cm = /^([^:]+):\s*(.*)$/.exec(it.content);
      if (!cm) return mapOrError(map, `line ${it.line}: expected "key: value"`);
      const key = cm[1].trim().replace(/^["']|["']$/g, '');
      const val = cm[2];
      if (val === '' || val === '|' || val === '>') {
        pos++;
        if (pos < items.length && items[pos].indent > indent) {
          const child = items[pos];
          if (child.content.startsWith('- ') || child.content === '-') {
            map[key] = parseBlock(indent + 1);
          } else {
            map[key] = parseMap(child.indent);
          }
        } else if (val === '|' || val === '>') {
          map[key] = '';
        } else {
          map[key] = null;
        }
      } else {
        map[key] = parseScalar(val);
        pos++;
      }
    }
    return map;
  }
  function mapOrError(map: Record<string, unknown>, msg: string): Record<string, unknown> {
    throw { yamlError: msg };
  }
  try {
    const value = parseBlock(0);
    return { value };
  } catch (e: unknown) {
    const err = e as { yamlError?: string };
    return { value: null, error: { line: 0, message: err.yamlError ?? 'invalid YAML' } };
  }
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}

function isQuoted(s: string): boolean {
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"));
}

function parseScalar(s: string): unknown {
  s = s.trim();
  if (isQuoted(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
