// Persistence: JSON snapshot store behind a Storage interface, plus an
// optional PostgreSQL backend (SHIPIT_PG_URL) for hosted/multi-machine play.
// The multi-user schema target lives in db/schema.sql; the PG backend below
// implements the same Storage seam for single-player games.
import * as fslib from 'fs';
import * as path from 'path';
import { GameState } from './types';

export interface Storage {
  list(): Promise<{ id: string; name: string; day: number; updatedAt: number }[]>;
  load(id: string): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/**
 * PostgreSQL snapshot store. Enabled by setting SHIPIT_PG_URL, e.g.
 *   SHIPIT_PG_URL=postgres://user:pass@localhost:5432/shipit npm run start
 * Falls back to JsonStorage when the `pg` driver is unavailable or the
 * connection fails — the game always boots.
 */
export class PgStorage implements Storage {
  constructor(private pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> }) {}

  static async connect(url: string): Promise<PgStorage | null> {
    let pg: any;
    try { pg = require('pg'); } catch { console.error('[storage] pg driver not installed — falling back to JSON'); return null; }
    try {
      const pool = new pg.Pool({ connectionString: url, max: 4 });
      await pool.query(`CREATE TABLE IF NOT EXISTS shipit_games (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        day        INTEGER NOT NULL,
        updated_at BIGINT NOT NULL,
        snapshot   JSONB NOT NULL
      )`);
      return new PgStorage(pool);
    } catch (e) {
      console.error('[storage] PostgreSQL unavailable, falling back to JSON:', (e as Error).message);
      return null;
    }
  }

  async list() {
    const { rows } = await this.pool.query('SELECT id, name, day, updated_at AS "updatedAt" FROM shipit_games ORDER BY updated_at DESC');
    return rows;
  }

  async load(id: string): Promise<GameState | null> {
    const { rows } = await this.pool.query('SELECT snapshot FROM shipit_games WHERE id = $1', [id]);
    return (rows[0]?.snapshot as GameState) ?? null;
  }

  async save(state: GameState): Promise<void> {
    state.updatedAt = Date.now();
    await this.pool.query(
      `INSERT INTO shipit_games (id, name, day, updated_at, snapshot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = $2, day = $3, updated_at = $4, snapshot = $5`,
      [state.id, state.world.company.name, Math.floor(state.world.nowMin / 1440) + 1, state.updatedAt, JSON.stringify(state)]
    );
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM shipit_games WHERE id = $1', [id]);
    return Boolean(rowCount);
  }
}

/** Pick the storage backend: SHIPIT_PG_URL when set and reachable, else JSON. */
export async function makeStorage(dataDir: string): Promise<Storage> {
  const url = process.env.SHIPIT_PG_URL;
  if (url) {
    const pg = await PgStorage.connect(url);
    if (pg) {
      console.log('[storage] PostgreSQL backend active');
      return pg;
    }
  }
  return new JsonStorage(dataDir);
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
  async list() {
    return Object.values(this.readAll()).map((g) => ({
      id: g.id,
      name: g.world.company.name,
      day: Math.floor(g.world.nowMin / 1440) + 1,
      updatedAt: g.updatedAt
    })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async load(id: string): Promise<GameState | null> {
    return this.readAll()[id] ?? null;
  }
  async save(state: GameState): Promise<void> {
    state.updatedAt = Date.now();
    const all = this.readAll();
    all[state.id] = state;
    // atomic-ish swap
    const tmp = this.file + '.tmp';
    fslib.writeFileSync(tmp, JSON.stringify(all));
    fslib.renameSync(tmp, this.file);
  }
  async delete(id: string): Promise<boolean> {
    const all = this.readAll();
    if (!all[id]) return false;
    delete all[id];
    fslib.writeFileSync(this.file, JSON.stringify(all));
    return true;
  }
}
