import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

// Optional compatibility input, never the source of truth for native runs.
export function openLegacy(file) {
  if (!file || !existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    db.prepare('SELECT id,title,directory,parent_id,time_created,time_updated,model FROM session LIMIT 0').all();
    db.prepare('SELECT id,session_id,time_created,data FROM message LIMIT 0').all();
    db.prepare('SELECT id,session_id,message_id,time_created,data FROM part LIMIT 0').all();
    return db;
  } catch (error) {
    db?.close();
    console.warn(JSON.stringify({ event: 'legacy_unavailable', message: error.message }));
    return null;
  }
}

export function maintenance(name, fn) {
  try { return fn(); }
  catch (error) { console.warn(JSON.stringify({ event: 'maintenance_failed', operation: name, message: error.message })); }
}
