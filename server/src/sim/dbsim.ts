// Managed Postgres simulation: SQL subset (SELECT/JOIN/WHERE/ORDER/LIMIT,
// INSERT/UPDATE/DELETE, CREATE INDEX, EXPLAIN) with a planner whose output
// (and whose effect on live DB CPU) changes when indexes appear.
import { World } from '../types';
import { hashStr } from './docker';

export interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  error?: string;
  notice?: string;
  explain?: string[];
  commandTag?: string;
}

const EMAILS = ['lin', 'kaia', 'marcus', 'sofia', 'jules', 'amara', 'petra', 'noah', 'iris', 'tomas'];
const PLANS = ['free', 'starter', 'pro', 'enterprise'];
const STATUSES = ['pending', 'paid', 'paid', 'paid', 'failed', 'refunded'];

function emailFor(i: number): string {
  return `${EMAILS[i % EMAILS.length]}.${(i * 7 + 3) % 97}@example.com`;
}
function createdAtFor(i: number, dayBase: number): string {
  const day = dayBase + Math.floor(i / 731);
  const min = (i * 17) % 1440;
  return `2026-09-${String(((day - 1) % 28) + 1).padStart(2, '0')} ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function seedTables(world: World): void {
  world.db.tables = {
    users: {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'text' },
        { name: 'plan', type: 'text' },
        { name: 'created_at', type: 'timestamp' }
      ],
      rowCount: 41250,
      indexes: [{ name: 'users_pkey', columns: ['id'] }, { name: 'users_email_key', columns: ['email'] }]
    },
    orders: {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'status', type: 'text' },
        { name: 'total_cents', type: 'integer' },
        { name: 'created_at', type: 'timestamp' }
      ],
      rowCount: 1048576,
      indexes: [{ name: 'orders_pkey', columns: ['id'] }]
    }
  };
}

function rowFor(world: World, table: string, i: number): (string | number)[] {
  if (table === 'users') {
    return [i, emailFor(i), PLANS[i % PLANS.length], createdAtFor(i, 1)];
  }
  const status = STATUSES[hashStr('o' + i).charCodeAt(0) % STATUSES.length];
  return [i, i % 41250, status, 499 + (i % 80) * 100, createdAtFor(i, 5)];
}

interface SelectPlan {
  columns: string[] | '*';
  table: string;
  join?: { table: string; onLeft: string; onRight: string };
  where?: { col: string; op: string; val: string | number }[];
  orderBy?: string;
  limit?: number;
}

function parseSelect(sql: string): SelectPlan | { error: string } {
  const m = /^select\s+(.+?)\s+from\s+([a-z_]+)(.*)$/is.exec(sql.trim());
  if (!m) return { error: 'unsupported SELECT form' };
  const cols = /^\*$/.test(m[1].trim()) ? '*' : m[1].split(',').map((c) => c.trim());
  const rest = m[3];
  const plan: SelectPlan = { columns: cols, table: m[2].toLowerCase() };
  const joinM = /\s+join\s+([a-z_]+)\s+on\s+([a-z_.]+)\s*=\s*([a-z_.]+)/i.exec(rest);
  if (joinM) plan.join = { table: joinM[1].toLowerCase(), onLeft: joinM[2], onRight: joinM[3] };
  const whereM = /\s+where\s+(.+?)(\s+order\s+by|\s+limit|$)/is.exec(rest);
  if (whereM) {
    plan.where = [];
    for (const clause of whereM[1].split(/\s+and\s+/i)) {
      const cm = /^\s*([a-z_.]+)\s*(=|>|<|>=|<=|!=)\s*'?([^']+?)'?\s*$/i.exec(clause);
      if (cm) plan.where.push({ col: cm[1], op: cm[2], val: isNaN(Number(cm[3])) ? cm[3] : Number(cm[3]) });
    }
  }
  const orderM = /\s+order\s+by\s+([a-z_.]+)/i.exec(rest);
  if (orderM) plan.orderBy = orderM[1];
  const limitM = /\s+limit\s+(\d+)/i.exec(rest);
  if (limitM) plan.limit = parseInt(limitM[1], 10);
  return plan;
}

function findIndex(world: World, table: string, col: string) {
  const t = world.db.tables[table];
  if (!t) return null;
  return t.indexes.find((ix) => ix.columns.includes(col)) ?? null;
}

function whereMatches(where: SelectPlan['where'], row: Record<string, string | number>): boolean {
  for (const w of where ?? []) {
    const v = row[w.col.split('.').pop()!];
    const a = typeof v === 'string' ? v : Number(v);
    const b = w.val;
    switch (w.op) {
      case '=': if (a != b) return false; break;
      case '!=': if (a == b) return false; break;
      case '>': if (!(a > b)) return false; break;
      case '<': if (!(a < b)) return false; break;
      case '>=': if (!(a >= b)) return false; break;
      case '<=': if (!(a <= b)) return false; break;
    }
  }
  return true;
}

function sampleRows(world: World, table: string, indexes: number[]): (string | number)[][] {
  return indexes.map((i) => rowFor(world, table, i));
}

export function runSql(world: World, sqlRaw: string): QueryResult {
  const sql = sqlRaw.trim().replace(/;\s*$/, '');
  if (!sql) return { columns: [], rows: [], rowCount: 0, error: 'empty query' };
  if (!world.db.provisioned) {
    return { columns: [], rows: [], rowCount: 0, error: 'connection failed: no managed database provisioned yet (Cloud console → Databases)' };
  }
  const lower = sql.toLowerCase();

  // psql meta-commands
  if (lower.startsWith('\\dt')) {
    const ts = Object.values(world.db.tables);
    return {
      columns: ['table', 'rows', 'indexes'],
      rows: ts.map((t) => [t.name, t.rowCount, t.indexes.length]),
      rowCount: ts.length,
      commandTag: 'SHOW'
    };
  }

  if (lower.startsWith('explain')) {
    const inner = sql.replace(/^explain(\s+analyze)?\s*/i, '');
    const plan = parseSelect(inner);
    if ('error' in plan) return { columns: [], rows: [], rowCount: 0, error: plan.error };
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'db', text: `EXPLAIN ANALYZE on ${plan.table}${plan.where?.length ? ` WHERE ${plan.where[0].col}` : ''}` });
    return explainSelect(world, plan);
  }

  if (lower.startsWith('select')) {
    const plan = parseSelect(sql);
    if ('error' in plan) return { columns: [], rows: [], rowCount: 0, error: plan.error };
    return execSelect(world, plan);
  }

  const createIdx = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(\w+)\s+on\s+([a-z_]+)\s*\(([^)]+)\)/i.exec(sql);
  if (createIdx) {
    const unique = Boolean(createIdx[1]);
    const idxName = createIdx[2];
    const table = createIdx[3].toLowerCase();
    const cols = createIdx[4].split(',').map((c) => c.trim().toLowerCase());
    const t = world.db.tables[table];
    if (!t) return { columns: [], rows: [], rowCount: 0, error: `relation "${table}" does not exist` };
    for (const c of cols) if (!t.columns.some((tc) => tc.name === c)) return { columns: [], rows: [], rowCount: 0, error: `column "${c}" does not exist` };
    if (t.indexes.some((ix) => ix.name === idxName)) return { columns: [], rows: [], rowCount: 0, notice: `notice: relation "${idxName}" already exists, skipping` };
    t.indexes.push({ name: idxName, columns: cols, unique });
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'db', text: `CREATE INDEX ${idxName} ON ${table}(${cols.join(',')})` });
    if (table === 'orders' && cols.includes('status')) {
      world.flags.indexFixApplied = true;
      world.db.seqScansPerSec = 0;
    }
    return { columns: [], rows: [], rowCount: 0, commandTag: 'CREATE INDEX', notice: `Index created. Planner will use it for queries filtering ${cols.join(',')}.` };
  }

  const insertM = /^insert\s+into\s+([a-z_]+)\s*\(([^)]*)\)\s*values\s*\((.*)\)$/i.exec(sql);
  if (insertM) {
    const table = insertM[1].toLowerCase();
    const t = world.db.tables[table];
    if (!t) return { columns: [], rows: [], rowCount: 0, error: `relation "${table}" does not exist` };
    t.rowCount++;
    return { columns: [], rows: [], rowCount: 1, commandTag: 'INSERT 0 1' };
  }

  const updateM = /^update\s+([a-z_]+)\s+set\s+(.+)$/i.exec(sql);
  if (updateM) {
    return { columns: [], rows: [], rowCount: 3, commandTag: 'UPDATE 3' };
  }

  const deleteM = /^delete\s+from\s+([a-z_]+)(\s+where\s+.+)?$/i.exec(sql);
  if (deleteM) {
    return { columns: [], rows: [], rowCount: 2, commandTag: 'DELETE 2' };
  }

  if (lower.startsWith('select') === false && /^(show|begin|commit|vacuum|analyze)/.test(lower)) {
    return { columns: [], rows: [], rowCount: 0, commandTag: 'OK' };
  }

  return { columns: [], rows: [], rowCount: 0, error: `syntax error at or near "${sql.split(/\s+/)[0]}"` };
}

function tableName(colRef: string, plan: SelectPlan): string {
  if (colRef.includes('.')) return colRef.split('.')[0];
  return plan.table;
}

function explainSelect(world: World, plan: SelectPlan): QueryResult {
  const lines: string[] = [];
  const t = world.db.tables[plan.table];
  if (!t) return { columns: [], rows: [], rowCount: 0, error: `relation "${plan.table}" does not exist` };
  const where = plan.where ?? [];
  const filterCol = where.length ? where[0].col.split('.').pop()! : null;
  const joinCol = plan.join ? plan.join.onLeft.split('.').pop()! : null;
  const filterIdx = filterCol ? findIndex(world, plan.table, filterCol) : null;
  const joinIdx = joinCol ? findIndex(world, plan.table, joinCol) : null;
  const idx = filterIdx ?? joinIdx;

  const rowsScanned = where.length && filterCol && !idx ? t.rowCount : Math.max(1, Math.round(t.rowCount / (idx ? 25000 : 1)));
  const cost = idx ? (8 + Math.log2(rowsScanned) * 4).toFixed(2) : (0 + t.rowCount * 0.01).toFixed(2);

  if (idx) {
    lines.push(`Index Scan using ${idx.name} on ${plan.table}  (cost=0.42..${cost} rows=1 width=64) (actual time=0.08..0.11 rows=1 loops=1)`);
    if (filterCol) lines.push(`  Index Cond: (${filterCol} = '${where?.[0].val}')`);
  } else {
    lines.push(`Seq Scan on ${plan.table}  (cost=0.00..${cost} rows=${Math.round(t.rowCount / 8)} width=64) (actual time=0.35..184.77 rows=${Math.round(t.rowCount / 8)} loops=1)`);
    lines.push(`  Filter: (${filterCol ?? joinCol} = '${where?.[0]?.val ?? 'x'}')`);
    lines.push(`  Rows Removed by Filter: ${t.rowCount - Math.round(t.rowCount / 8)}`);
    lines.push(`  ->  full table scan over ${t.rowCount.toLocaleString()} rows — every request reads the whole table`);
  }
  if (plan.join) {
    const jt = world.db.tables[plan.join.table];
    if (jt) {
      const jIdx = findIndex(world, plan.join.table, plan.join.onRight.split('.').pop()!);
      lines.push(
        jIdx
          ? `  ->  Nested Loop: Index Scan using ${jIdx.name} on ${plan.join.table} (cost=0.42..0.65 rows=1)`
          : `  ->  Hash Join: Seq Scan on ${plan.join.table} (cost=0.00..${(jt.rowCount * 0.01).toFixed(2)} rows=${jt.rowCount})`
      );
    }
  }
  lines.push('Planning Time: 0.14 ms');
  lines.push(`Execution Time: ${idx ? '0.1' : (35 + (t.rowCount / 6000)).toFixed(1)} ms`);
  if (!idx && filterCol) {
    lines.push('');
    lines.push(`TIP: a full scan of ${t.rowCount.toLocaleString()} rows happens for every lookup on "${filterCol}". Consider: CREATE INDEX idx_${plan.table}_${filterCol} ON ${plan.table} (${filterCol});`);
  }
  return { columns: ['QUERY PLAN'], rows: lines.map((l) => [l]), rowCount: lines.length, commandTag: 'EXPLAIN' };
}

function execSelect(world: World, plan: SelectPlan): QueryResult {
  const t = world.db.tables[plan.table];
  if (!t) return { columns: [], rows: [], rowCount: 0, error: `relation "${plan.table}" does not exist` };
  const cols = plan.columns === '*' ? t.columns.map((c) => c.name) : (plan.columns as string[]).map((c) => c.split('.').pop()!);
  const where = plan.where ?? [];

  // find up to N matching row indexes deterministically
  const limit = plan.limit ?? 20;
  const out: (string | number)[][] = [];
  const filterCol = where.length ? where[0].col.split('.').pop()! : null;
  const idx = filterCol ? findIndex(world, plan.table, filterCol) : null;
  const step = idx ? 1 : Math.max(1, Math.floor(t.rowCount / 4000));
  for (let i = 0; i < t.rowCount && out.length < limit; i += step) {
    const rowVals = rowFor(world, plan.table, i);
    const rowObj: Record<string, string | number> = {};
    t.columns.forEach((c, j) => { rowObj[c.name] = rowVals[j]; });
    if (whereMatches(where, rowObj)) out.push(rowVals);
  }
  if (plan.join) {
    const jt = world.db.tables[plan.join.table];
    if (jt) {
      for (const r of out) {
        const userId = plan.table === 'orders' ? Number(r[1]) : Number(r[0]);
        const u = rowFor(world, 'users', userId);
        if (cols.some((c) => jt.columns.some((tc) => tc.name === c))) {
          r.push(u[1]);
        }
      }
      if (out.length && cols.includes('email')) { /* appended above */ }
    }
  }
  return { columns: cols, rows: out, rowCount: out.length, commandTag: 'SELECT' };
}

/** Pure db-CPU curve for a plan at a given query rate — shared by the tick loop and the P6a utilization surcharge. */
export function dbCpuFor(plan: string, qps: number, hasIdx: boolean): number {
  const cap = ({ 'db.micro': 1, 'db.small': 1.8, 'db.medium': 3.6 })[plan] ?? 1;
  const seqCost = hasIdx ? 0 : qps * 1.15; // each seq scan is expensive
  return Math.min(99, 4 + (qps * (hasIdx ? 0.35 : 0.12)) / cap + seqCost / cap);
}

/** Model DB CPU for the tick loop. */
export function updateDbCpu(world: World, reqRate: number): void {
  if (!world.db.provisioned) return;
  const qps = reqRate; // ~1 orders query per request
  const hasIdx = Boolean(world.flags.indexFixApplied) || Boolean(findIndex(world, 'orders', 'status'));
  world.db.cpuPct = Math.round(dbCpuFor(world.db.plan, qps, hasIdx) * 10) / 10;
  world.db.seqScansPerSec = hasIdx ? 0 : Math.round(qps);
  world.db.connections = Math.min(97, 4 + Math.round(qps / 8));
}
