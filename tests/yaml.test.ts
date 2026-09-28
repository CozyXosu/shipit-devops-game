import { describe, it, expect } from 'vitest';
import { createWorld } from '../server/src/world';
import { parseYaml } from '../server/src/sim/yaml';

describe('yaml subset parser', () => {
  it('parses pipeline-shaped documents', () => {
    const doc = `name: deploy
on: push
steps:
  - name: checkout
    uses: git/checkout
  - name: test
    run: npm test
env:
  FOO: "bar baz"
`;
    const { value, error } = parseYaml(doc);
    expect(error).toBeUndefined();
    const v = value as { name: string; steps: { name: string; run?: string; uses?: string }[]; env: { FOO: string } };
    expect(v.name).toBe('deploy');
    expect(v.steps.length).toBe(2);
    expect(v.steps[1].run).toBe('npm test');
    expect(v.env.FOO).toBe('bar baz');
  });

  it('comments and blank lines are ignored', () => {
    const { value } = parseYaml('# header\n\nkey: 1  # trailing\n');
    expect((value as { key: number }).key).toBe(1);
  });

  it('scalars: numbers, booleans, quoted strings', () => {
    const { value } = parseYaml('a: 1\nb: true\nc: "42"\nd: plain text\n');
    const v = value as Record<string, unknown>;
    expect(v.a).toBe(1);
    expect(v.b).toBe(true);
    expect(v.c).toBe('42');
    expect(v.d).toBe('plain text');
  });
});
