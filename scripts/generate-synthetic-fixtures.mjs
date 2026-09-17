import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "Test_Files/synthetic/solosheet-synthetic-notes.pdf");
const document = await PDFDocument.create();
const regular = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);
const fixedDate = new Date("2026-01-01T00:00:00.000Z");

document.setTitle("SoloSheet Synthetic Study Notes");
document.setAuthor("SoloSheet contributors");
document.setSubject("Self-authored upload fixture for local testing");
document.setCreator("scripts/generate-synthetic-fixtures.mjs");
document.setProducer("pdf-lib");
document.setCreationDate(fixedDate);
document.setModificationDate(fixedDate);

const sections = [
  {
    title: "Discrete Systems: State and Transitions",
    lines: [
      "A state machine is a tuple (S, I, T, s0), where S is a finite state set.",
      "Deterministic transition: each state-input pair has at most one successor.",
      "Invariant proof: establish P(s0), then show P(s) implies P(T(s, i)).",
      "Reachability asks whether a target state occurs on any valid input sequence.",
      "Example: a two-bit counter advances 00 -> 01 -> 10 -> 11 -> 00.",
    ],
  },
  {
    title: "Probability Refresher",
    lines: [
      "Conditional probability: P(A | B) = P(A and B) / P(B), for P(B) > 0.",
      "Bayes rule: P(A | B) = P(B | A) P(A) / P(B).",
      "Linearity: E[X + Y] = E[X] + E[Y], without requiring independence.",
      "Variance: Var(X) = E[X^2] - E[X]^2.",
      "For independent X and Y, Var(X + Y) = Var(X) + Var(Y).",
    ],
  },
  {
    title: "Asymptotic Analysis",
    lines: [
      "Big-O is an eventual upper bound; Big-Omega is an eventual lower bound.",
      "A geometric series 1 + r + ... + r^k equals (r^(k+1) - 1) / (r - 1).",
      "Binary search satisfies T(n) = T(n/2) + O(1), so T(n) = O(log n).",
      "Merge sort satisfies T(n) = 2T(n/2) + O(n), so T(n) = O(n log n).",
      "Always state the input measure and distinguish worst, average, and amortized cost.",
    ],
  },
];

for (const [index, section] of sections.entries()) {
  const page = document.addPage([612, 792]);
  page.drawText("SOLOSHEET SYNTHETIC FIXTURE", {
    x: 54, y: 730, size: 11, font: bold, color: rgb(0.75, 0, 0),
  });
  page.drawText(section.title, { x: 54, y: 690, size: 20, font: bold });
  section.lines.forEach((line, lineIndex) => {
    page.drawText(`- ${line}`, { x: 64, y: 640 - lineIndex * 42, size: 11, font: regular });
  });
  page.drawText(`Self-authored test content - page ${index + 1} of ${sections.length}`, {
    x: 54, y: 40, size: 9, font: regular, color: rgb(0.35, 0.35, 0.35),
  });
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, await document.save({ useObjectStreams: false }));
console.log(`Generated ${output}`);
