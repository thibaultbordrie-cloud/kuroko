/**
 * The player's packs and saves live in this browser only (IndexedDB). Nothing is ever sent
 * anywhere. Every call is guarded: a private window or blocked storage just means "nothing kept".
 */
import type { Hero } from "../story/story.js";

const DB = "kuroko";
const VERSION = 1;

export interface StoredPack {
  /** The sealed file's checksum: one pack, one key. */
  readonly id: string;
  readonly title: string;
  readonly age: number;
  readonly themes: readonly string[];
  readonly sealed: string;
  readonly added: number;
  readonly builtin?: boolean;
}

export interface StoredSave {
  readonly pack: string;
  readonly seed: string;
  readonly lines: readonly string[];
  readonly log: readonly (number | readonly string[])[];
  readonly updated: number;
  readonly ended?: string;
  /** The character the player made, when the pack asks for one. */
  readonly hero?: Hero;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("packs")) db.createObjectStore("packs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("saves")) db.createObjectStore("saves", { keyPath: "pack" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = f(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const db = {
  packs: async (): Promise<StoredPack[]> => (await run<StoredPack[]>("packs", "readonly", (s) => s.getAll())) ?? [],
  putPack: async (p: StoredPack): Promise<boolean> => (await run("packs", "readwrite", (s) => s.put(p))) !== null,
  deletePack: async (id: string): Promise<void> => {
    await run("packs", "readwrite", (s) => s.delete(id));
    await run("saves", "readwrite", (s) => s.delete(id));
  },
  save: async (pack: string): Promise<StoredSave | null> => run<StoredSave>("saves", "readonly", (s) => s.get(pack)),
  putSave: async (v: StoredSave): Promise<boolean> => (await run("saves", "readwrite", (s) => s.put(v))) !== null,
  deleteSave: async (pack: string): Promise<void> => {
    await run("saves", "readwrite", (s) => s.delete(pack));
  },
};
