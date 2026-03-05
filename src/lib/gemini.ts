import { GoogleGenAI, Type } from "@google/genai";

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
  total: number
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

  const primaryModel = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";
  const fallbackModels = [
    primaryModel,
    "gemini-2.5-flash",
    "gemini-1.5-pro-latest",
    "gemini-1.5-flash-latest",
  ];
  const modelsToTry = Array.from(new Set(fallbackModels));

  let response;
  let lastError: Error | unknown;
  let success = false;

  for (const model of modelsToTry) {
    let retries = 2;
    let delay = 1500;

    while (retries > 0) {
      try {
        console.log(`[Gemini Extraction] File ${index}/${total} (${file.name}): Attempting with model ${model}...`);
        response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
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
        lastError = error;
        const err = error as Error & { status?: number };
        console.warn(`[Gemini Extraction] Model ${model} failed (retries left: ${retries - 1}):`, err.message);
        if (err.status === 400 || err.message?.includes("Invalid argument")) {
          break;
        }
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 1.5;
        }
      }
    }

    if (success) break;
    console.warn(`[Gemini Extraction] Giving up on model ${model}, moving to next fallback...`);
  }

  if (!success) {
    throw lastError || new Error(`All fallback models failed for file ${file.name}.`);
  }

  const text = response?.text ?? "[]";
  let rawItems: Record<string, unknown>[];
  try {
    rawItems = JSON.parse(text);
    if (!Array.isArray(rawItems)) {
      rawItems = (rawItems as { items?: Record<string, unknown>[] }).items || [];
    }
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      rawItems = JSON.parse(match[0]);
    } else {
      throw new Error("Failed to parse extraction response as JSON");
    }
  }

  return rawItems.map((item) => ({
    category: (item.category as "Formula" | "Definition" | "DiagramRef" | "ExamTrick") || "Definition",
    topic: (item.topic as string) || "Untitled",
    content: (item.content as string) || "",
    shorthand: (item.shorthand as string) || "",
    priority: typeof item.priority === "number" ? Math.min(10, Math.max(1, Math.round(item.priority))) : 5,
  }));
}
// ── Main extraction function ───────────────────────────────
export async function extractFromMaterials(
  files: { buffer: Buffer; mimeType: string; name: string }[],
  userDirective: string
): Promise<ExtractionItem[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });
  const sanitizedDirective = sanitizeDirective(userDirective);

  let allItems: ExtractionItem[] = [];

  // Process files sequentially to avoid rate limiting and maximize density per file
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[Gemini Batch] Starting extraction for ${file.name} (${i + 1}/${files.length})`);
    try {
      const parsedItems = await extractSingleFile(ai, file, sanitizedDirective, i + 1, files.length);
      console.log(`[Gemini Batch] Extracted ${parsedItems.length} items from ${file.name}`);
      allItems = allItems.concat(parsedItems);
    } catch (err) {
      console.error(`[Gemini Batch] Failed to extract from ${file.name}:`, err);
      // Throw to abort the whole extraction if one file completely fails, 
      // ensuring the user doesn't lose a credit for a partial sheet.
      throw new Error(`Failed to extract data from ${file.name}. Please try again.`);
    }
  }

  return allItems;
}
