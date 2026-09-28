// SHIP IT server entry: API + static hosting of the built web app.
// All game state lives in the simulation; nothing here executes player input
// on the host OS. State is loaded/mutated/saved synchronously per operation.
import express from 'express';
import * as path from 'path';
import * as fslib from 'fs';
import { JsonStorage } from './state';
import { createApi } from './api';
import { tick } from './world';
import { evaluateMissions } from './engine';

const PORT = Number(process.env.PORT ?? 4100);
const DATA_DIR = path.join(process.cwd(), 'data');

const storage = new JsonStorage(DATA_DIR);
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

// simulation clock: 1 real second = `speed` sim minutes (pausable)
let lastHardSave = Date.now();
setInterval(() => {
  for (const g of storage.list()) {
    const state = storage.load(g.id);
    if (!state || state.world.flags.paused) continue;
    const speed = Number(state.world.flags.speed ?? 1) || 1;
    tick(state.world, speed);
    evaluateMissions(state);
    storage.save(state);
  }
  if (Date.now() - lastHardSave > 30000) {
    lastHardSave = Date.now();
    for (const g of storage.list()) {
      const state = storage.load(g.id);
      if (state) storage.save(state);
    }
  }
}, 1000);
