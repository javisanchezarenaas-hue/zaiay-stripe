'use strict';
/** PostgreSQL en producción (DATABASE_URL). DB_DRIVER=sqlite solo para pruebas locales. El SQL funciona igual en ambos. */
let mode = null, pool = null, sdb = null, chain = Promise.resolve();
const toSqlite = sql => sql.replace(/\$(\d+)/g, '?$1');
const isRead = sql => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
function sqliteRun(sql, params = []) {
  const st = sdb.prepare(toSqlite(sql));
  if (isRead(sql)) { const rows = st.all(...params).map(r => ({ ...r })); return { rows, rowCount: rows.length }; }
  const r = st.run(...params); return { rows: [], rowCount: Number(r.changes) };
}
async function init() {
  if (process.env.DB_DRIVER === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite'); sdb = new DatabaseSync(process.env.SQLITE_FILE || ':memory:'); sdb.exec('PRAGMA journal_mode=WAL;'); mode = 'sqlite'; return mode;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta la variable DATABASE_URL (cadena de conexión de PostgreSQL).');
  const { Pool } = require('pg');
  const useSsl = process.env.PGSSL === 'true' || (process.env.PGSSL !== 'false' && /render\.com|neon\.tech|supabase|amazonaws/.test(url));
  pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : undefined, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', e => console.error('[pg]', e.message));
  await pool.query('SELECT 1'); mode = 'pg'; return mode;
}
async function query(sql, params = []) { return mode === 'sqlite' ? sqliteRun(sql, params) : pool.query(sql, params); }
function tx(fn) {
  if (mode === 'sqlite') {
    const run = chain.then(async () => { sdb.exec('BEGIN'); try { const out = await fn(async (s, p) => sqliteRun(s, p || [])); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch (_) {} throw e; } });
    chain = run.catch(() => {}); return run;
  }
  return (async () => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn((s, p) => client.query(s, p || [])); await client.query('COMMIT'); return out; }
    catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
  })();
}
const isUnique = e => !!e && (e.code === '23505' || /UNIQUE constraint failed/i.test(e.message || ''));
module.exports = { init, query, tx, isUnique, driver: () => mode };
