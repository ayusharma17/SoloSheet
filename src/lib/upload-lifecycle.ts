/** Paths only: never persist signed URLs or credentials in the cleanup journal. */
const JOURNAL_KEY = "solosheet-upload-cleanup-v1";
export const ACTIVE_REQUEST_STORAGE_KEY = "solosheet-active-extraction-v2:";
const ACTIVE_TTL = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_REQUESTS_PER_USER = 8;
const MAX_ACTIVE_REQUESTS_TOTAL = 32;
type Entry = { path: string; after: number };
type ActiveRequestEntry = { userId: string; requestId: string; savedAt: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Persists only an authenticated owner and opaque request ID. Upload URLs,
 * directives, filenames, and other course data must never be stored here.
 */
export class ActiveExtractionStore {
  private storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  private now: () => number;

  constructor(
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">,
    now: () => number = () => Date.now(),
  ) {
    this.storage = storage;
    this.now = now;
  }

  private storageKey(userId: string, requestId: string): string {
    return `${ACTIVE_REQUEST_STORAGE_KEY}${userId}:${requestId}`;
  }

  private read(): ActiveRequestEntry[] {
    const entries: ActiveRequestEntry[] = [];
    const now = this.now();
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (!key?.startsWith(ACTIVE_REQUEST_STORAGE_KEY)) continue;
        const value: unknown = JSON.parse(this.storage.getItem(key) || "null");
        if (typeof value !== "object" || value === null ||
            !("userId" in value) || typeof value.userId !== "string" || !UUID_PATTERN.test(value.userId) ||
            !("requestId" in value) || typeof value.requestId !== "string" || !UUID_PATTERN.test(value.requestId) ||
            !("savedAt" in value) || typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) ||
            value.savedAt > now || value.savedAt + ACTIVE_TTL <= now ||
            key !== this.storageKey(value.userId, value.requestId)) continue;
        entries.push(value as ActiveRequestEntry);
      }
    } catch { /* Treat inaccessible storage as an empty recovery list. */ }
    return entries;
  }

  get(userId: string): string | null {
    return this.getAll(userId)[0] ?? null;
  }

  getAll(userId: string): string[] {
    if (!UUID_PATTERN.test(userId)) return [];
    return this.read()
      .filter(entry => entry.userId === userId)
      .sort((left, right) => right.savedAt - left.savedAt)
      .map(entry => entry.requestId);
  }

  save(userId: string, requestId: string) {
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(requestId)) return;
    try {
      // Each request owns a distinct key, so interleaved writers cannot replace
      // another tab's active request with a stale read/modify/write snapshot.
      this.storage.setItem(
        this.storageKey(userId, requestId),
        JSON.stringify({ userId, requestId, savedAt: this.now() }),
      );
      const entries = this.read().sort((left, right) => right.savedAt - left.savedAt);
      const retainedForUser = new Set(entries
        .filter(entry => entry.userId === userId)
        .slice(0, MAX_ACTIVE_REQUESTS_PER_USER)
        .map(entry => entry.requestId));
      const retainedGlobally = new Set(entries
        .slice(0, MAX_ACTIVE_REQUESTS_TOTAL)
        .map(entry => this.storageKey(entry.userId, entry.requestId)));
      for (const entry of entries) {
        const key = this.storageKey(entry.userId, entry.requestId);
        if ((entry.userId === userId && !retainedForUser.has(entry.requestId)) || !retainedGlobally.has(key)) {
          this.storage.removeItem(key);
        }
      }
    } catch { /* Persistence is a recovery enhancement, not a prerequisite. */ }
  }

  clear(userId: string, requestId?: string) {
    if (!UUID_PATTERN.test(userId)) return;
    try {
      if (requestId !== undefined) {
        if (UUID_PATTERN.test(requestId)) this.storage.removeItem(this.storageKey(userId, requestId));
        return;
      }
      for (const entry of this.read()) {
        if (entry.userId === userId) this.storage.removeItem(this.storageKey(userId, entry.requestId));
      }
    } catch { /* Storage may be unavailable. */ }
  }
}

export function isActiveExtractionStorageKey(key: string | null): boolean {
  return key?.startsWith(ACTIVE_REQUEST_STORAGE_KEY) ?? false;
}

/** Bounded backoff for both healthy jobs and transport failures, with testable jitter. */
export function extractionPollDelay(
  failedAttempts: number,
  nonterminalPolls = 0,
  random: () => number = Math.random,
): number {
  const failures = Number.isSafeInteger(failedAttempts) ? Math.max(0, failedAttempts) : 0;
  const healthy = Number.isSafeInteger(nonterminalPolls) ? Math.max(0, nonterminalPolls) : 0;
  const base = failures > 0
    ? Math.min(10_000, 1_000 * 2 ** Math.min(failures, 4))
    : Math.min(10_000, 1_250 * 1.35 ** Math.min(healthy, 8));
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(Math.min(10_000, base * (0.9 + sample * 0.2)));
}
export class UploadCleanupJournal {
  private storage: Pick<Storage, "getItem" | "setItem">;
  private now: () => number;

  constructor(
    storage: Pick<Storage, "getItem" | "setItem">,
    now: () => number = () => Date.now(),
  ) {
    this.storage = storage;
    this.now = now;
  }
  private read(): Entry[] {
    try {
      const value: unknown = JSON.parse(this.storage.getItem(JOURNAL_KEY) || "[]");
      return Array.isArray(value) ? value.filter((e): e is Entry =>
        typeof e === "object" && e !== null && typeof e.path === "string" &&
        typeof e.after === "number" && Number.isFinite(e.after)) : [];
    } catch { return []; }
  }
  private write(entries: Entry[]) {
    try { this.storage.setItem(JOURNAL_KEY, JSON.stringify(entries)); } catch { /* storage may be unavailable */ }
  }
  track(path: string, active = true) {
    this.write([...this.read().filter(e => e.path !== path), { path, after: this.now() + (active ? ACTIVE_TTL : 0) }]);
  }
  forget(paths: string[]) {
    const removed = new Set(paths);
    this.write(this.read().filter(entry => !removed.has(entry.path)));
  }
  async flush(userId: string, remove: (paths: string[]) => Promise<boolean>) {
    const paths = [...new Set(this.read()
      .filter(e => e.after <= this.now() && e.path.split("/")[0] === userId)
      .map(e => e.path))];
    if (!paths.length) return;
    for (let index = 0; index < paths.length; index += 10) {
      const batch = paths.slice(index, index + 10);
      try {
        if (await remove(batch)) {
          this.write(this.read().filter(e =>
            !batch.includes(e.path) || e.after > this.now()));
        }
      } catch { /* Keep this failed batch for next mount / online event. */ }
    }
  }
}

export type ExtractionPayload = {
  requestId: string; courseName: string; targetPages: number; userDirective: string;
  fileUrls: { url: string; path: string; name: string; type: string; size: number }[];
};
/** Ambiguous transport failures and active operations must preserve the exact attempt. */
export function retryDisposition(status: number, body: unknown): "preserve" | "restart" {
  const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
  if (code === "EXTRACTION_RESTART_REQUIRED") return "restart";
  if (code === "EXTRACTION_PROCESSING" || status >= 500) return "preserve";
  return "restart";
}
