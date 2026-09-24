import { GoogleGenAI, Type } from "@google/genai";

const GOOGLE_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_FALLBACK_MODELS = [DEFAULT_GEMINI_MODEL, "gemini-2.5-flash"] as const;
export const PROVIDER_CALL_TIMEOUT_MS = 150_000;
const MIN_PROVIDER_CALL_TIME_MS = 1_000;

export type ProviderFailureClassification = {
  failureCode: "provider_permanent" | "provider_transient" | "configuration" | "worker_error";
  retryable: boolean;
  /** Whether trying a different configured model can plausibly recover. */
  canFallback: boolean;
};

function errorRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    const record = errorRecord(current);
    if (!record || seen.has(record)) break;
    seen.add(record);
    records.push(record);
    current = record.cause ?? record.error;
  }
  return records;
}

function numericStatus(error: unknown): number | undefined {
  for (const record of errorChain(error)) {
    const candidates = [record.status, record.statusCode, record.code, errorRecord(record.response)?.status];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
    }
  }
  const match = providerErrorText(error).match(/(?:^|\D)([45]\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function providerErrorText(error: unknown): string {
  return errorChain(error)
    .flatMap((record) => [record.name, record.message, record.code])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/** Pure classification used both by the provider loop and its unit tests. */
export function classifyProviderError(error: unknown): ProviderFailureClassification {
  const status = numericStatus(error);
  const text = providerErrorText(error);
  if (status === 401 || status === 403 || /api[_ -]?key|credential|authentication|permission denied/.test(text)) {
    return { failureCode: "configuration", retryable: false, canFallback: false };
  }
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return { failureCode: "provider_transient", retryable: true, canFallback: true };
  }
  if (/timeout|timed out|aborterror|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket hang up|network/.test(text)) {
    return { failureCode: "provider_transient", retryable: true, canFallback: true };
  }
  if (status === 404 && /model|models\//.test(text) && /not found|not supported|unavailable|unknown/.test(text)) {
    return { failureCode: "provider_permanent", retryable: false, canFallback: true };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { failureCode: "provider_permanent", retryable: false, canFallback: false };
  }
  return { failureCode: "worker_error", retryable: false, canFallback: false };
}

/** Common configuration/permanent failures must not be masked by a later transient. */
export function combineProviderFailures(
  failures: readonly ProviderFailureClassification[],
): ProviderFailureClassification {
  if (failures.some((failure) => failure.failureCode === "configuration")) {
    return { failureCode: "configuration", retryable: false, canFallback: false };
  }
  if (failures.some((failure) => failure.failureCode === "provider_permanent" && !failure.canFallback)) {
    return { failureCode: "provider_permanent", retryable: false, canFallback: false };
  }
  if (failures.some((failure) => failure.failureCode === "worker_error")) {
    return { failureCode: "worker_error", retryable: false, canFallback: false };
  }
  if (failures.some((failure) => failure.failureCode === "provider_transient")) {
    return { failureCode: "provider_transient", retryable: true, canFallback: true };
  }
  if (failures.length > 0 && failures.every((failure) => failure.failureCode === "provider_permanent")) {
    return { failureCode: "provider_permanent", retryable: false, canFallback: false };
  }
  return { failureCode: "worker_error", retryable: false, canFallback: false };
}

// ── Types ──────────────────────────────────────────────────
export interface ExtractionItem {
  category: "Formula" | "Definition" | "DiagramRef" | "ExamTrick";
  topic: string;
  content: string;
  shorthand: string;
  priority: number;
}

export interface ExtractionResult {
  items: ExtractionItem[];
  courseName: string;
}

export class ExtractionProviderError extends Error {
  readonly failureCode: "provider_permanent" | "provider_transient" | "configuration" | "worker_error";
  readonly retryable: boolean;
  constructor(
    failureCode: "provider_permanent" | "provider_transient" | "configuration" | "worker_error",
    retryable: boolean,
  ) {
    super("Extraction provider request failed");
    this.name = "ExtractionProviderError";
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

export class ExtractionDeadlineError extends ExtractionProviderError {
  constructor() {
    super("provider_transient", true);
    this.name = "ExtractionDeadlineError";
  }
}

/** Bounds one provider request by both its own cap and the job's absolute deadline. */
export function remainingProviderCallTimeout(deadlineMs: number, now = Date.now()): number {
  if (!Number.isFinite(deadlineMs)) return 0;
  return Math.max(0, Math.min(PROVIDER_CALL_TIMEOUT_MS, Math.floor(deadlineMs - now)));
}

export class ExtractionOutputError extends Error {
  readonly failureCode = "invalid_output" as const;
  readonly retryable = false;
  constructor() {
    super("Extraction provider returned invalid output");
    this.name = "ExtractionOutputError";
  }
}

export function validateExtractionItems(value: unknown): ExtractionItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExtractionOutputError();
  const categories = new Set<ExtractionItem["category"]>(["Formula", "Definition", "DiagramRef", "ExamTrick"]);
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ExtractionOutputError();
    const record = item as Record<string, unknown>;
    if (typeof record.category !== "string" || !categories.has(record.category as ExtractionItem["category"]) ||
        typeof record.topic !== "string" || !record.topic.trim() || record.topic.length > 200 ||
        typeof record.content !== "string" || !record.content.trim() || record.content.length > 20_000 ||
        typeof record.shorthand !== "string" || record.shorthand.length > 5_000 ||
        typeof record.priority !== "number" || !Number.isFinite(record.priority) ||
        record.priority < 1 || record.priority > 10) {
      throw new ExtractionOutputError();
    }
    return {
      category: record.category as ExtractionItem["category"],
      topic: record.topic,
      content: record.content,
      shorthand: record.shorthand,
      priority: Math.round(record.priority),
    };
  });
}

// ── Sanitize user directive ────────────────────────────────
function sanitizeDirective(raw: string): string {
  let clean = raw.slice(0, 500);
  clean = clean.replace(/```/g, "");
  clean = clean.replace(/<[^>]*>/g, "");
  clean = clean.replace(/\{[^}]*\}/g, (match) => {
    if (match.includes('"') || match.includes("'")) return "";
    return match;
  });
  return clean.trim();
}

// ── System prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `You are an Elite Academic Content Extractor specializing in creating ultra-dense, comprehensive exam cheat sheets.

Your #1 goal is EXHAUSTIVE EXTRACTION. You must extract EVERY piece of useful information — not just the "important" ones. A student's grade depends on having every fact on their cheat sheet.

## Extraction Rules:

1. **Be EXHAUSTIVE.** Extract 30-100+ items from typical lecture materials. Every single formula, definition, theorem, lemma, corollary, property, rule, algorithm, data structure, edge case, pitfall, shortcut, mnemonic, and example should be its own separate item.

2. **Break things down.** Do NOT combine multiple concepts into one item. Each formula gets its own item. Each definition gets its own item. Each property of a data structure gets its own item. If a topic has 5 properties, that's 5 separate items.

3. **"topic" must be a short label** (3-6 words max) that names the concept. Example: "Turnaround Time Formula", "SJF Head-of-Line Blocking", "Page Table Entry Bits".

4. **"content" must be complete and self-contained.** Include the full formula, definition, or explanation. ALL math MUST be valid LaTeX wrapped in $...$ (inline) or $$...$$ (display).

5. **"shorthand" must be ultra-condensed** using abbreviations and symbols (∴, ⟹, ∀, ∃, ≈, ∝, etc.). This is for when space is tight.

6. **"priority" (1-10):**
   - 10 = Explicitly mentioned in user directive or exam-critical formulas
   - 8-9 = Core theorems, key formulas, fundamental definitions
   - 5-7 = Important properties, algorithms, examples
   - 3-4 = Supporting details, edge cases, less common facts
   - 1-2 = Background context, historical notes

7. **Categories:**
   - Formula: Any equation, inequality, recurrence, or mathematical relationship
   - Definition: Terminology, concepts, classifications, properties
   - DiagramRef: **CRITICAL — see Diagram Rules below**
   - ExamTrick: Shortcuts, common pitfalls, mnemonics, "gotchas"

## Diagram Extraction Rules (VERY IMPORTANT):

You MUST scan EVERY page for visual content: flowcharts, state diagrams, architecture diagrams, timelines, comparison tables, graphs, plots, trees, memory layouts, stack frames, circuit diagrams, UML, etc.

For EACH diagram or visual found:
- Create a DiagramRef item with a descriptive "topic" (e.g., "MLFQ State Transition Diagram", "Page Table Lookup Flowchart")
- In "content", provide a COMPLETE textual representation. Use one of these formats:
  a) **ASCII art** for simple diagrams:
     \`\`\`
     [Process] → [Ready Queue] → [CPU] → [I/O Wait] → [Ready Queue]
     \`\`\`
  b) **Step-by-step flows** for flowcharts:
     "1. Check TLB → 2. If hit: return PA → 3. If miss: walk page table → 4. Update TLB → 5. Retry"
  c) **Structured lists** for comparison tables:
     "FIFO: Simple, convoy effect | SJF: Optimal avg wait, needs burst prediction | RR: Fair, high context switch overhead"
  d) **Node→Edge descriptions** for state machines:
     "States: New→Ready (admitted), Ready→Running (scheduled), Running→Ready (preempted), Running→Waiting (I/O), Running→Terminated (exit)"
- Include ALL labels, values, annotations, and relationships visible in the diagram
- If a diagram contains formulas or numbers, include them in LaTeX

8. **Never skip content because it seems "obvious."** If it's in the document, extract it. Students need everything.

9. Output ONLY valid JSON, no markdown fences, no explanation.`;

// ── Helper: Extract a single file ──────────────────────────
async function extractSingleFile(
  ai: GoogleGenAI,
  file: { buffer: Buffer; mimeType: string; name: string },
  sanitizedDirective: string,
  index: number,
  total: number,
  requestId?: string,
  assertActive?: () => Promise<void>,
  deadlineMs = Date.now() + PROVIDER_CALL_TIMEOUT_MS,
): Promise<ExtractionItem[]> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [
    {
      inlineData: {
        mimeType: file.mimeType,
        data: file.buffer.toString("base64"),
      },
    },
    {
      text: `User Directive: "${sanitizedDirective}"

IMPORTANT: Extract EVERY piece of academic content from this specific document (${file.name}). Be EXHAUSTIVE.
You MUST extract 40-100+ items from this document alone. Every formula, definition, theorem, property, algorithm, edge case, and trick should be its own entry.

Return a JSON array with this schema:
[
  {
    "category": "Formula" | "Definition" | "DiagramRef" | "ExamTrick",
    "topic": "Short label (3-6 words)",
    "content": "Full content with LaTeX math",
    "shorthand": "Ultra-condensed version using symbols",
    "priority": 1-10
  }
]

Return ONLY the JSON array. No markdown, no explanation. Extract EVERYTHING — do not summarize or skip.`,
    },
  ];

  const primaryModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const modelsToTry = Array.from(new Set([primaryModel, ...GEMINI_FALLBACK_MODELS]));

  let response;
  const failures: ProviderFailureClassification[] = [];
  let success = false;

  for (const model of modelsToTry) {
    let retries = 2;
    let delay = 1500;

    while (retries > 0) {
      await assertActive?.();
      const timeoutMs = remainingProviderCallTimeout(deadlineMs);
      if (timeoutMs < MIN_PROVIDER_CALL_TIME_MS) throw new ExtractionDeadlineError();
      try {
        console.log(`[Gemini Extraction] request=${requestId ?? "untracked"} file=${index}/${total} model=${model} attempt=start`);
        response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            httpOptions: { timeout: timeoutMs },
            abortSignal: AbortSignal.timeout(timeoutMs),
            systemInstruction: SYSTEM_PROMPT,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: {
                    type: Type.STRING,
                    enum: ["Formula", "Definition", "DiagramRef", "ExamTrick"],
                  },
                  topic: { type: Type.STRING },
                  content: { type: Type.STRING },
                  shorthand: { type: Type.STRING },
                  priority: { type: Type.NUMBER },
                },
                required: ["category", "topic", "content", "shorthand", "priority"],
              },
            },
          },
        });
        success = true;
        break;
      } catch (error: unknown) {
        const classification = classifyProviderError(error);
        failures.push(classification);
        console.warn(`[Gemini Extraction] request=${requestId ?? "untracked"} model=${model} status=${numericStatus(error) ?? "unknown"} failure=${classification.failureCode}`);
        retries--;
        if (!classification.retryable) break;
        if (retries > 0) {
          await assertActive?.();
          const remaining = remainingProviderCallTimeout(deadlineMs);
          if (remaining <= delay) throw new ExtractionDeadlineError();
          await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
          delay *= 1.5;
        }
      }
    }

    if (success) break;
    const latestFailure = failures.at(-1);
    if (!latestFailure?.canFallback) break;
    console.warn(`[Gemini Extraction] request=${requestId ?? "untracked"} model=${model} exhausted=true`);
  }

  if (!success) {
    if (!process.env.GOOGLE_API_KEY) throw new ExtractionProviderError("configuration", false);
    const classification = combineProviderFailures(failures);
    throw new ExtractionProviderError(classification.failureCode, classification.retryable);
  }

  const text = response?.text ?? "[]";
  let rawItems: unknown;
  try {
    rawItems = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { rawItems = JSON.parse(match[0]); }
      catch { throw new ExtractionOutputError(); }
    } else {
      throw new ExtractionOutputError();
    }
  }

  return validateExtractionItems(rawItems);
}
// ── Main extraction function ───────────────────────────────
export async function extractFromMaterials(
  files: Iterable<{ buffer: Buffer; mimeType: string; name: string }> |
    AsyncIterable<{ buffer: Buffer; mimeType: string; name: string }>,
  userDirective: string,
  options: {
    requestId?: string;
    onProgress?: () => Promise<void>;
    totalFiles?: number;
    deadlineMs?: number;
  } = {},
): Promise<ExtractionItem[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new ExtractionProviderError("configuration", false);

  // Netlify injects a Google SDK base URL that routes requests through its AI
  // Gateway. SoloSheet supplies its own Google API key, so use Google's API
  // directly instead of mixing Google credentials with gateway authentication.
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { baseUrl: GOOGLE_GEMINI_API_BASE_URL },
  });
  const sanitizedDirective = sanitizeDirective(userDirective);
  const deadlineMs = options.deadlineMs ?? Date.now() + 13 * 60_000;

  let allItems: ExtractionItem[] = [];

  // Process files sequentially to avoid rate limiting and maximize density per file
  let index = 0;
  const totalFiles = options.totalFiles ?? (Array.isArray(files) ? files.length : undefined);
  for await (const file of files) {
    index++;
    await options.onProgress?.();
    console.log(`[Gemini Batch] request=${options.requestId ?? "untracked"} file=${index}/${totalFiles ?? "unknown"} started=true`);
    try {
      const parsedItems = await extractSingleFile(
        ai,
        file,
        sanitizedDirective,
        index,
        totalFiles ?? index,
        options.requestId,
        options.onProgress,
        deadlineMs,
      );
      console.log(`[Gemini Batch] request=${options.requestId ?? "untracked"} file=${index}/${totalFiles ?? "unknown"} items=${parsedItems.length}`);
      allItems = allItems.concat(parsedItems);
    } catch (err) {
      console.error(`[Gemini Batch] request=${options.requestId ?? "untracked"} file=${index}/${totalFiles ?? "unknown"} failed=true`);
      if (err instanceof ExtractionProviderError || err instanceof ExtractionOutputError) throw err;
      throw new ExtractionProviderError("worker_error", false);
    }
  }

  return allItems;
}
