import { indexedDbFactory } from '../browserStorage';
import { parseAskThreadTurns, type AskAtlasIdentity, type AskThreadView } from './askAtlas';

const DATABASE = 'sourcefor-ask';
const STORE = 'threads';
const MAX_TURNS = 100;

function key(accountId: string, atlas: AskAtlasIdentity): string {
  return JSON.stringify([accountId, atlas.owner, atlas.repo, atlas.commitSha]);
}

const STORAGE_TIMEOUT_MS = 3_000;

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      settled = true;
      clearTimeout(timer);
      reject(new Error('Local Ask storage is unavailable.'));
    };
    const timer = setTimeout(fail, STORAGE_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    const factory = indexedDbFactory();
    if (!factory) { fail(); return; }
    try { request = factory.open(DATABASE, 1); }
    catch { fail(); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = fail;
    request.onblocked = fail;
  });
}

/** Account + immutable atlas identity keep histories apart on shared browsers. */
export async function readLocalAskThread(accountId: string, atlas: AskAtlasIdentity): Promise<AskThreadView | undefined> {
  try {
    const db = await database();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(key(accountId, atlas));
        const timer = setTimeout(() => reject(new Error('Local Ask storage timed out.')), STORAGE_TIMEOUT_MS);
        request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
      });
      if (!value || typeof value !== 'object') return undefined;
      const row = value as Partial<AskThreadView>;
      if (row.owner !== atlas.owner || row.repo !== atlas.repo || row.commitSha !== atlas.commitSha) return undefined;
      return { ...atlas, turns: parseAskThreadTurns(Array.isArray(row.turns) ? row.turns : []).slice(-MAX_TURNS) };
    } finally { db.close(); }
  } catch { return undefined; }
}

export async function writeLocalAskThread(accountId: string, thread: AskThreadView): Promise<boolean> {
  try {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put({ ...thread, turns: thread.turns.slice(-MAX_TURNS) }, key(accountId, thread));
        const timer = setTimeout(() => { transaction.abort(); reject(new Error('Local Ask storage timed out.')); }, STORAGE_TIMEOUT_MS);
        transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
        transaction.onerror = () => { clearTimeout(timer); reject(transaction.error); };
        transaction.onabort = () => { clearTimeout(timer); reject(transaction.error); };
      });
      return true;
    } finally { db.close(); }
  } catch { return false; }
}
