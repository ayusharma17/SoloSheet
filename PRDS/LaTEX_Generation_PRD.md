# PRD: Phase 3 — Adaptive Layout Engine & Navigation Guide

## 1. Introduction

This module is the "Typesetter." It transforms the structured JSON from Phase 2 into a high-density, multi-column PDF. It includes a feedback loop that adjusts formatting dynamically to hit a user-defined page count and generates a secondary "Navigation Guide" to help the user locate information under pressure.

## 2. Problem Statement

Fixed-size layouts either waste space or cut off important content. For a printed exam cheat sheet, the goal is **100% surface area utilization**. Additionally, ultra-dense sheets are difficult to read in a time-crunch without a map or "index" of where topics are located.

## 3. Solution/Feature Overview

A typesetting pipeline using a **"Fill-First, Squeeze-Second"** rendering strategy.

1. **Input:** User selects **any page count** (1, 2, 3, …) via a number input.
2. **The Fill-First Strategy:** The engine always includes **all extracted items** first. It then adjusts formatting (font size, columns, shorthand mode) to make the content fill the requested page count as densely as possible. Content is only dropped if the user has more content than can physically fit at the minimum font size.
3. **The Navigation Guide:** A separate document (not counted against the page limit) that acts as a "Heat Map" of the cheat sheet. The user can optionally toggle **"Include Guide in Pages"** to squeeze the guide into the cheat sheet page count itself.

## 4. User Stories

- **US1:** As a student, I want to input **any specific page count** (1, 2, 3, etc.) so I stay compliant with my professor's rules.
- **US2:** As a student, I want the engine to **fill every page** with as much extracted content as possible — I paid for this extraction and I want every fact on the sheet.
- **US3:** As a student, I want the Navigation Guide to be a **separate download** by default, but optionally included inside my page limit if I choose.

## 5. Technical Requirements

### **The "Fill & Squeeze" Logic**

- **Engine**: Client-side CSS multi-column layout with browser Print-to-PDF.
- **Variable Parameters**:
  - **Font Size**: Step-down logic ($9pt \rightarrow 8.5pt \rightarrow 8pt \dots \rightarrow 6pt$).
  - **Columns**: 3 to 4 columns.
  - **Margins**: $0.1in$ to $0.25in$.
  - **Shorthand Mode**: Toggle the `shorthand` strings from Phase 2 to save space.

- **The Content Fill Algorithm**:
  1. **Always start with all items**, sorted by priority (highest first).
  2. Render at the largest comfortable font size (9pt, 3 cols).
  3. If content **overflows** the page count → squeeze (shrink font, add cols, enable shorthand).
  4. If content **underflows** (pages aren't full) → this is acceptable; leave remaining space empty since all unique information is already included.
  5. Only drop items (lowest priority first) as a **last resort** when content physically cannot fit at minimum parameters.

### **The Navigation Guide**

- **Default behavior**: Rendered as a **separate page** appended _after_ the cheat sheet pages. It does **not** count against the user's page limit.
- **Optional toggle**: "Include Guide in Pages" — when enabled, the Navigation Guide is squeezed into the page limit, reducing space available for cheat sheet content.
- **Content**:
  - **The Legend**: Shorthand symbol key (e.g., $\therefore$ = therefore).
  - **Priority Indicators**: Color-coded dot key.
  - **Quick-Access Tips**: Based on the `user_directive` from Phase 2.

## 6. Acceptance Criteria

- The user can select **any integer page count** ≥ 1.
- The engine always includes **all extracted items** unless physically impossible at 6pt.
- The Navigation Guide does **not** count toward pages by default.
- Toggling "Include Guide" re-runs the squeeze loop to fit both content + guide within the page limit.
- All LaTeX math remains mathematically valid and rendered at at least $6pt$ font.

## 7. Constraints

- **Math Safety**: The "Squeeze" logic must never truncate a LaTeX equation. It can only shrink it.
- **Readability**: No font can be smaller than $6pt$ (unreadable for most human eyes).
