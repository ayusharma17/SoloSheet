/** Paths only: never persist signed URLs or credentials in the cleanup journal. */
const JOURNAL_KEY = "solosheet-upload-cleanup-v1";
const ACTIVE_TTL = 24 * 60 * 60 * 1000;
type Entry = { path: string; after: number };
export class UploadCleanupJournal {
  constructor(private storage: Pick<Storage, "getItem" | "setItem">, private now = () => Date.now()) {}
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
    const paths = this.read().filter(e => e.after <= this.now() && e.path.split("/")[0] === userId).map(e => e.path);
    if (!paths.length) return;
    try {
      if (await remove(paths)) this.write(this.read().filter(e => !paths.includes(e.path) || e.after > this.now()));
    } catch { /* Keep failures for next mount / online event. */ }
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
