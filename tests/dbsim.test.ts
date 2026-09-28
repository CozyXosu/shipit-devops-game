import { describe, it, expect } from 'vitest';
import { createWorld, provisionDb } from '../server/src/world';
import { runSql, updateDbCpu } from '../server/src/sim/dbsim';

describe('postgres simulation: planner + indexes', () => {
  it('EXPLAIN shows Seq Scan before index, Index Scan after', () => {
    const w = createWorld('DbCo', 'you');
    provisionDb(w, 'db.small');
    const before = runSql(w, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'");
    const beforeText = (before.rows.flat() as string[]).join('\n');
    expect(beforeText).toContain('Seq Scan on orders');
    expect(beforeText).toContain('Rows Removed by Filter');

    const created = runSql(w, 'CREATE INDEX idx_orders_status ON orders (status)');
    expect(created.error).toBeUndefined();

    const after = runSql(w, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'");
    const afterText = (after.rows.flat() as string[]).join('\n');
    expect(afterText).toContain('Index Scan using idx_orders_status');
    expect(afterText).not.toContain('Seq Scan on orders');
  });

  it('duplicate CREATE INDEX is a no-op notice', () => {
    const w = createWorld('DbCo', 'you');
    provisionDb(w, 'db.small');
    runSql(w, 'CREATE INDEX idx_orders_status ON orders (status)');
    const again = runSql(w, 'CREATE INDEX idx_orders_status ON orders (status)');
    expect(again.notice).toContain('already exists');
  });

  it('SELECT filters and returns rows', () => {
    const w = createWorld('DbCo', 'you');
    provisionDb(w, 'db.small');
    const r = runSql(w, "SELECT id, email FROM users WHERE plan = 'pro' LIMIT 5");
    expect(r.error).toBeUndefined();
    expect(r.columns).toEqual(['id', 'email']);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(5);
  });

  it('db CPU model: seq scans saturate, index drops it', () => {
    const w = createWorld('DbCo', 'you');
    provisionDb(w, 'db.small');
    updateDbCpu(w, 120);
    expect(w.db.cpuPct).toBeGreaterThan(80);
    runSql(w, 'CREATE INDEX idx_orders_status ON orders (status)');
    updateDbCpu(w, 120);
    expect(w.db.cpuPct).toBeLessThan(50);
    expect(w.db.seqScansPerSec).toBe(0);
  });

  it('rejects SQL when no database provisioned', () => {
    const w = createWorld('DbCo', 'you');
    const r = runSql(w, 'SELECT 1');
    expect(r.error).toContain('no managed database');
  });
});
