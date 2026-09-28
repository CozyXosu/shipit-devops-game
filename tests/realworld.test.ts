// Every career mission teaches its transferable skill: a real-world mapping
// note is mandatory, and the mapping table must not drift from the mission list.
import { describe, it, expect } from 'vitest';
import { MISSIONS, REAL_WORLD } from '../server/src/missions/missions';

describe('real-world curriculum notes', () => {
  it('every mission has a realWorld note', () => {
    for (const m of MISSIONS) {
      expect(m.realWorld, `${m.id} is missing its realWorld note`).toBeTruthy();
      expect(m.realWorld!.length).toBeGreaterThan(40);
    }
  });

  it('REAL_WORLD has no orphan entries and no unresolved templates', () => {
    const ids = new Set(MISSIONS.map((m) => m.id));
    for (const id of Object.keys(REAL_WORLD)) {
      expect(ids.has(id), `REAL_WORLD key ${id} matches no mission`).toBe(true);
      expect(REAL_WORLD[id]).not.toContain('{company}');
    }
  });
});
