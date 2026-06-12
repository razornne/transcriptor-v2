"use client";

// IndexedDB autosave записи (safety net уровень 3, порт идеи из /app).
// Каждый 5-секундный chunk MediaRecorder'а пишется сюда; сессия удаляется
// ТОЛЬКО после успешной транскрипции. Упал браузер/вкладка/аплоад —
// на следующем входе orphan-сессия предлагается к восстановлению.
//
// СВОЯ база ('ink_recordings'), не 'transcriptor_recordings' старого /app:
// на проде оба приложения живут на одном origin — не трогаем чужую схему.

const DB_NAME = "ink_recordings";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        const st = db.createObjectStore("chunks", { autoIncrement: true });
        st.createIndex("by_session", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode) {
  return db.transaction(stores, mode);
}

function reqAsync<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function idbCreateSession(): Promise<string | null> {
  try {
    const db = await openDb();
    const id = crypto.randomUUID();
    await reqAsync(tx(db, ["sessions"], "readwrite").objectStore("sessions")
      .put({ id, startedAt: Date.now() }));
    return id;
  } catch {
    return null; // private mode / quota — autosave недоступен, запись не ломаем
  }
}

export async function idbAppendChunk(sessionId: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    await reqAsync(tx(db, ["chunks"], "readwrite").objectStore("chunks")
      .put({ sessionId, at: Date.now(), blob }));
  } catch { /* best-effort */ }
}

export async function idbDeleteSession(sessionId: string): Promise<void> {
  try {
    const db = await openDb();
    const t = tx(db, ["sessions", "chunks"], "readwrite");
    t.objectStore("sessions").delete(sessionId);
    const idx = t.objectStore("chunks").index("by_session");
    const keys = await reqAsync(idx.getAllKeys(sessionId));
    for (const k of keys) t.objectStore("chunks").delete(k);
    await new Promise<void>((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch { /* best-effort */ }
}

export type OrphanSession = {
  id: string;
  startedAt: number;
  blob: Blob;
  sizeMb: number;
  approxMinutes: number;
};

export async function idbGetOrphans(): Promise<OrphanSession[]> {
  try {
    const db = await openDb();
    const t = tx(db, ["sessions", "chunks"], "readonly");
    const sessions = (await reqAsync(t.objectStore("sessions").getAll())) as
      { id: string; startedAt: number }[];
    const out: OrphanSession[] = [];
    for (const s of sessions) {
      const rows = (await reqAsync(
        t.objectStore("chunks").index("by_session").getAll(s.id),
      )) as { blob: Blob; at: number }[];
      if (!rows.length) continue;
      rows.sort((a, b) => a.at - b.at);
      const blob = new Blob(rows.map((r) => r.blob), { type: "audio/webm" });
      out.push({
        id: s.id,
        startedAt: s.startedAt,
        blob,
        sizeMb: blob.size / 1048576,
        approxMinutes: Math.max(1, Math.round((rows.length * 5) / 60)),
      });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}
