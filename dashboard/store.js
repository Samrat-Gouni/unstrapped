// Local session persistence (IndexedDB) + CSV export. Everything stays in this
// browser; nothing is sent anywhere.

const DB_NAME = "unstrapped";
const STORE = "sessions";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Persist a completed session. Returns the stored record. */
export async function saveSession(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").put(session);
    req.onsuccess = () => resolve(session);
    req.onerror = () => reject(req.error);
  });
}

/** All sessions, newest first. */
export async function listSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readonly").getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Recent daily RMSSD values for the recovery baseline (most-recent-first). */
export async function recentRmssd(limit = 14) {
  const sessions = await listSessions();
  return sessions
    .map((s) => s.summary && s.summary.rmssd)
    .filter((v) => typeof v === "number" && v > 0)
    .slice(0, limit);
}

/** Build a CSV string: one row per beat with any RR intervals expanded. */
export function sessionToCsv(session) {
  const rows = ["timestamp_iso,elapsed_s,heart_rate_bpm,rr_interval_ms"];
  const t0 = session.startedAt;
  for (const s of session.samples) {
    const iso = new Date(s.t).toISOString();
    const elapsed = ((s.t - t0) / 1000).toFixed(1);
    if (s.rr && s.rr.length) {
      for (const rr of s.rr) rows.push(`${iso},${elapsed},${s.hr},${Math.round(rr)}`);
    } else {
      rows.push(`${iso},${elapsed},${s.hr},`);
    }
  }
  return rows.join("\n");
}

/** Trigger a browser download of a session as CSV (user-initiated click). */
export function downloadCsv(session) {
  const blob = new Blob([sessionToCsv(session)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date(session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `whoop-session-${stamp}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
