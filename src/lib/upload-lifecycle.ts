/** Paths only: never persist signed URLs or credentials in the cleanup journal. */
const JOURNAL_KEY = "solosheet-upload-cleanup-v1";
const ACTIVE_TTL = 24 * 60 * 60 * 1000;
type Entry = { path: string; after: number };
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
