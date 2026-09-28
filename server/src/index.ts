// SHIP IT server entry: API + static hosting of the built web app.
// All game state lives in the simulation; nothing here executes player input
// on the host OS. State is loaded/mutated/saved per operation through the
// Storage seam (JSON by default, PostgreSQL via SHIPIT_PG_URL).
import express from 'express';
import * as path from 'path';
import * as fslib from 'fs';
import { makeStorage } from './state';
import { createApi } from './api';
import { tick } from './world';
import { evaluateMissions } from './engine';
import { registerPack } from './missions/packs';

const PORT = Number(process.env.PORT ?? 4100);
const DATA_DIR = path.join(process.cwd(), 'data');
const PACKS_DIR = path.join(process.cwd(), 'packs');

/** The built-in tournament pack self-registers on import; load any extra
 *  JSON bundles dropped into packs/ (the mission-pack distribution format). */
function loadPacks(): void {
  if (!fslib.existsSync(PACKS_DIR)) return;
  for (const f of fslib.readdirSync(PACKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fslib.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
      const r = registerPack(json);
      console.log(`packs/${f}: ${r.message}`);
    } catch (e) {
      console.warn(`packs/${f}: failed to load (${String(e)})`);
    }
  }
}

async function main() {
  loadPacks();
  const storage = await makeStorage(DATA_DIR);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApi(storage));

  // static web build
  const webDist = path.join(process.cwd(), 'web', 'dist');
  if (fslib.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.listen(PORT, () => {
    console.log(`SHIP IT server ready → http://localhost:${PORT}`);
  });

  // simulation clock: 1 real second = `speed` sim minutes (pausable).
  // ticks never overlap: storage is async now.
  let ticking = false;
  let lastHardSave = Date.now();
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        for (const g of await storage.list()) {
          const state = await storage.load(g.id);
          if (!state || state.world.flags.paused) continue;
          const speed = Number(state.world.flags.speed ?? 1) || 1;
          tick(state.world, speed);
          evaluateMissions(state);
          await storage.save(state);
        }
        if (Date.now() - lastHardSave > 30000) {
          lastHardSave = Date.now();
          for (const g of await storage.list()) {
            const state = await storage.load(g.id);
            if (state) await storage.save(state);
          }
        }
      } finally {
        ticking = false;
      }
    })();
  }, 1000);
}

void main();
