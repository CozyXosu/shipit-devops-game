// Shared UI atoms: sparklines, metric cards, syntax highlighting.
import React from 'react';

export function Spark({ points, color = '#58a6ff', height = 30, width = 120 }: { points: number[]; color?: string; height?: number; width?: number }) {
  if (!points || points.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function metricColor(value: number, warnAt: number, badAt: number, invert = false): string {
  const bad = invert ? value < badAt : value > badAt;
  const warn = invert ? value < warnAt : value > warnAt;
  return bad ? 'bad' : warn ? 'warn' : 'good';
}

export function MetricCard({ label, value, unit, series, warnAt, badAt, invert, color }: {
  label: string; value: number | string; unit?: string; series?: number[];
  warnAt?: number; badAt?: number; invert?: boolean; color?: string;
}) {
  let cls = '';
  if (typeof value === 'number' && warnAt !== undefined && badAt !== undefined) {
    cls = metricColor(value, warnAt, badAt, invert);
  }
  return (
    <div className="metric-card">
      <div className="label">{label}</div>
      <div className={`value ${cls}`}>{typeof value === 'number' ? (Math.round(value * 10) / 10).toLocaleString() : value}{unit ? <small style={{ fontSize: 12, color: 'var(--dim)' }}> {unit}</small> : null}</div>
      {series ? <Spark points={series.slice(-60)} color={color ?? '#58a6ff'} width={150} height={30} /> : null}
    </div>
  );
}

// ---------- tiny syntax highlighter ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlight(code: string, lang: string): string {
  const lines = code.split('\n');
  return lines.map((line) => esc(line)).map((line) => {
    if (lang === 'yaml') return hlYaml(line);
    if (lang === 'dockerfile') return hlDockerfile(line);
    if (lang === 'conf') return hlConf(line);
    if (lang === 'js') return hlJs(line);
    return line;
  }).join('\n');
}

function hlYaml(line: string): string {
  if (/^\s*#/.test(line)) return `<span class="c">${line}</span>`;
  let out = line.replace(/^(\s*-?\s*)([\w.]+)(:)(\s*)(.*)$/, (_m, pre, key, colon, sp, rest) => {
    let r = rest;
    if (rest && !rest.startsWith('#')) {
      r = rest
        .replace(/^"(.*)"$/, '<span class="s">"$1"</span>')
        .replace(/^'(.*)'$/, '<span class="s">\'$1\'</span>');
      if (!r.includes('class=') && /^[\d.]+$/.test(rest)) r = `<span class="n">${rest}</span>`;
    }
    return `${pre}<span class="k">${key}</span>${colon}${sp}${r}`;
  });
  out = out.replace(/(#.*)$/, '<span class="c">$1</span>');
  return out;
}

function hlDockerfile(line: string): string {
  if (/^\s*#/.test(line)) return `<span class="c">${line}</span>`;
  return line.replace(/^(\s*)(FROM|RUN|CMD|COPY|ADD|WORKDIR|ENV|EXPOSE|USER|HEALTHCHECK|ENTRYPOINT|ARG|LABEL)\b(.*)$/i,
    (_m, pre, kw, rest) => `${pre}<span class="k">${kw}</span><span class="dim">${rest}</span>`.replace('class="dim"', 'class="a"'));
}

function hlConf(line: string): string {
  if (/^\s*[#{}]/.test(line.trim()) === false && /\w+\s+\S+;/.test(line)) {
    return line.replace(/^(\s*)(\w[\w-]*)(\s+)/, (_m, pre, kw, sp) => `${pre}<span class="k">${kw}</span>${sp}`);
  }
  if (/^\s*#/.test(line)) return `<span class="c">${line}</span>`;
  return line;
}

function hlJs(line: string): string {
  if (/^\s*(\/\/|\/\*)/.test(line)) return `<span class="c">${line}</span>`;
  return line
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="s">$1</span>')
    .replace(/\b(const|let|var|function|return|require|module|exports|if|else|new|async|await)\b/g, '<span class="k">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="n">$1</span>');
}
