// Persistence: JSON snapshot store behind a Storage interface. The Phase-2
// PostgreSQL backend (db/schema.sql) implements the same interface.
import * as fslib from 'fs';
import * as path from 'path';
import { GameState } from './types';

export interface Storage {
  list(): { id: string; name: string; day: number; updatedAt: number }[];
  load(id: string): GameState | null;
  save(state: GameState): void;
  delete(id: string): boolean;
}

export class JsonStorage implements Storage {
  private file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'games.json');
    fslib.mkdirSync(dataDir, { recursive: true });
    if (!fslib.existsSync(this.file)) fslib.writeFileSync(this.file, '{}');
  }
  private readAll(): Record<string, GameState> {
    try { return JSON.parse(fslib.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  list() {
    return Object.values(this.readAll()).map((g) => ({
      id: g.id,
      name: g.world.company.name,
      day: Math.floor(g.world.nowMin / 1440) + 1,
      updatedAt: g.updatedAt
    })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  load(id: string): GameState | null {
    return this.readAll()[id] ?? null;
  }
  save(state: GameState): void {
    state.updatedAt = Date.now();
    const all = this.readAll();
    all[state.id] = state;
    // atomic-ish swap
    const tmp = this.file + '.tmp';
    fslib.writeFileSync(tmp, JSON.stringify(all));
    fslib.renameSync(tmp, this.file);
  }
  delete(id: string): boolean {
    const all = this.readAll();
    if (!all[id]) return false;
    delete all[id];
    fslib.writeFileSync(this.file, JSON.stringify(all));
    return true;
  }
}
