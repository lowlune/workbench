import { readFileSync } from 'node:fs';
import os from 'node:os';

// The service's own cgroup v2 limit is at /sys/fs/cgroup plus the path in
// /proc/self/cgroup. At the cgroup root memory.max does not exist, so reading
// the fixed path silently ignores the unit's real limit.
function cgroupAvailableBytes() {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(value => value.startsWith('0::'));
    if (!line) return null;
    const base = `/sys/fs/cgroup${line.slice(3).trim()}`;
    const limit = Number(readFileSync(`${base}/memory.max`, 'utf8'));
    const used = Number(readFileSync(`${base}/memory.current`, 'utf8'));
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return Math.max(0, limit - used);
  } catch { return null; }
}

export function availableBytes() {
  let available = os.freemem();
  try { available = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024 || available; } catch {}
  // Respect the unit's own cgroup v2 limit as well as host memory.
  let cgroup = cgroupAvailableBytes();
  if (cgroup === null) {
    try {
      const limit = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
      const used = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      if (Number.isFinite(limit)) cgroup = Math.max(0, limit - used);
    } catch {}
  }
  if (cgroup === null) {
    const constrained = process.constrainedMemory?.();
    if (Number.isFinite(constrained) && constrained > 0) cgroup = constrained;
  }
  if (cgroup !== null) available = Math.min(available, cgroup);
  return available;
}

export function createScheduler({ store, runs, startRun, maxRuns, freeBytes = availableBytes, reserveMB = 256, perRunMB = 512, stopping = () => false }) {
  let scheduling = false;
  const metrics = { ticks: 0, started: 0, blocked: null, availableMB: 0, reservedMB: 0 };
  function tick() {
    if (scheduling || stopping()) return;
    scheduling = true;
    metrics.ticks++;
    try {
      metrics.blocked = null;
      while (!stopping()) {
        // All resident processes count, including a worker waiting on the user
        // or reporting completion while its process group is still being reaped.
        if (runs.size >= maxRuns()) { metrics.blocked = 'capacity'; break; }
        metrics.availableMB = Math.floor(freeBytes() / 1024 / 1024);
        metrics.reservedMB = [...runs.values()].filter(run => !run.admittedAt || Date.now() - run.admittedAt < 10_000 || run.phase === 'starting').length * perRunMB;
        if (metrics.availableMB < reserveMB + perRunMB + metrics.reservedMB) { metrics.blocked = 'memory'; break; }
        // Filter BEFORE limiting: fifty follow-ups in a busy chat cannot hide
        // a runnable command from a different chat. No directory predicate.
        const command = store.db.prepare(`SELECT c.* FROM commands c JOIN conversations s ON s.id=c.conversation_id
          WHERE c.status='queued' AND s.paused=0
          AND (c.retry_at IS NULL OR c.retry_at<=CAST(strftime('%s','now') AS INTEGER)*1000)
          AND NOT EXISTS (SELECT 1 FROM commands live WHERE live.conversation_id=c.conversation_id
            AND live.status IN ('starting','running','waiting_for_user','waiting_for_permission','interrupting'))
          ORDER BY c.created,c.id`).iterate();
        let next;
        for (const candidate of command) { if (!runs.has(candidate.conversation_id)) { next = candidate; break; } }
        if (!next) break;
        startRun(next); // Must synchronously reserve runs + starting status.
        metrics.started++;
      }
    } catch (error) {
      metrics.blocked = 'error';
      console.error(JSON.stringify({ event: 'scheduler_error', message: error.message }));
    } finally { scheduling = false; }
  }
  return { tick, metrics };
}
