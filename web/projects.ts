// Projects of the workbench: a list of files per project, kept in IndexedDB (database "hla64", store
// "projects"). Without IndexedDB (a private window, blocked site data) projects live in memory for the
// session and `persistent` is false.

export type Mode = 'exe' | 'static' | 'dynamic';
export type Platform = 'mac' | 'win' | 'linux' | 'wasm';

export interface ProjectFile { name: string; text: string }

export interface Project {
  id: string;
  name: string;
  platform: Platform;
  mode: Mode;
  main: string;             // the file the build starts from (it includes the others)
  files: ProjectFile[];
  open: string;             // the file in the editor
  example?: string;         // built from this example (it can be reset to the original)
  args?: Record<string, string>;   // command line arguments for a run, per main file
  updated: number;
}

const DB = 'hla64', STORE = 'projects';
let dbp: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, Project>();
export let persistent = true;

function open(): Promise<IDBDatabase | null> {
  return (dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { persistent = false; resolve(null); };
      req.onblocked = () => { persistent = false; resolve(null); };
    } catch {
      persistent = false;
      resolve(null);
    }
  }));
}

function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const r = f(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
}

const copy = (p: Project): Project => ({ ...p, files: p.files.map((f) => ({ ...f })), ...(p.args ? { args: { ...p.args } } : {}) });

export async function listProjects(platform: Platform): Promise<Project[]> {
  const all = (await tx<Project[]>('readonly', (s) => s.getAll())) ?? [...memory.values()];
  return all.filter((p) => p.platform === platform).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(id: string): Promise<Project | null> {
  const p = (await tx<Project | undefined>('readonly', (s) => s.get(id))) ?? memory.get(id);
  return p ? copy(p) : null;
}

export async function saveProject(p: Project): Promise<void> {
  p.updated = Date.now();
  memory.set(p.id, copy(p));
  await tx('readwrite', (s) => s.put(copy(p)));
}

export async function deleteProject(id: string): Promise<void> {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

export const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** a file name that is not taken yet: util.hla, util-2.hla, ... */
export function freeName(p: Project, wanted: string): string {
  if (!p.files.some((f) => f.name === wanted)) return wanted;
  const dot = wanted.lastIndexOf('.');
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted, ext = dot > 0 ? wanted.slice(dot) : '';
  for (let i = 2; ; i++) if (!p.files.some((f) => f.name === `${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}
