# PRD: High-Density Micro-Typesetting Engine (Phase 2)

## 1. Introduction

This module is the "core" of the application. It takes the structured knowledge extracted from lecture materials and uses algorithmically driven layout logic to fit it onto a physical page limit. The output must be a print-ready PDF optimized for exam use.

## 2. Problem Statement

Standard AI summaries are too "airy" and use too much white space. In an exam, students need every square millimeter. Current tools don't respect physical page boundaries (e.g., "exactly 1 page") or support the specialized math formatting needed for engineering/science exams.

## 3. Solution/Feature Overview

A processing pipeline that converts JSON knowledge into a **multi-column LaTeX template**. The engine uses an iterative "Squeeze & Fit" loop: if the content exceeds the page limit, it automatically applies abbreviations, reduces font size, and tightens margins until the constraint is met.

## 4. User Stories

- **US1:** As a student, I want to set a hard limit (e.g., "1 page front and back") so I don't get disqualified for bringing too much paper.
- **US2:** As a student, I want the most important formulas to be slightly larger or bolded so I can find them in seconds.
- **US3:** As a student, I want complex diagrams from slides to be auto-cropped and shrunk to fit in corners.
- **US4:** As a user, I want a "shorthand" mode that replaces common words with symbols (e.g., "therefore" $\rightarrow$ $\therefore$, "implies" $\rightarrow$ $\implies$).

## 5. Technical Requirements

### **The Layout Logic**

- **Template:** Use LaTeX `extarticle` class (supports 8pt and smaller).
- **Columns:** Dynamic 3-column or 4-column layout using the `multicol` package.
- **Math Rendering:** Native `amsmath` support for high-fidelity equations.
- **Squeeze Pipeline:**

1. **Level 1:** Tighten margins to 0.2 inches.
2. **Level 2:** Reduce font size from 8pt to 7pt or 6.5pt.
3. **Level 3:** Invoke LLM to "Abbreviate/Condense" text blocks while preserving all math.

### **Business Logic: The "Navigation Guide"**

- The system must generate a separate "Table of Contents" page (not part of the cheat sheet) that acts as a map, telling the user which quadrant of the sheet contains which topic.

## 6. Acceptance Criteria

- The engine produces a PDF that is exactly the number of pages specified by the user.
- All math remains valid LaTeX and is legible at the final generated font size.
- No text is cut off by the printer's "non-printable" margin area (0.15-inch buffer).
- Diagrams are automatically resized to a maximum width of 1.5 inches.

## 7. Constraints

- **Non-Negotiable:** Must handle **LaTeX math** without "hallucinating" or breaking syntax during the compression phase.
- **Rendering:** PDF generation must happen in a serverless environment (e.g., using a Lambda layer for TeX Live) to keep costs at zero for the owner.
