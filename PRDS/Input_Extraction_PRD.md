# PRD: Phase 2 — Multi-Modal Ingestion & Guided Extraction

## 1. Introduction

This module handles the core "reading" phase of the application. It uses **Gemini 3.1 Flash-Lite** to ingest a massive context of course materials and a specific user directive to produce a structured, ranked knowledge base.

## 2. Problem Statement

Generic summaries often miss specific exam requirements. Users need a way to guide the AI to focus on specific topics, weeks, or "difficulty levels" while ensuring all technical math is preserved in LaTeX.

## 3. Solution/Feature Overview

A hybrid extraction pipeline. The system takes $N$ PDFs/PPTX files + a text prompt (User Directive) and sends them to Gemini 3.1 Flash-Lite. The AI performs a "Two-Pass" analysis: first, identifying all content; second, filtering and ranking that content based on the user's prompt.

## 4. User Stories

- **US1:** As a student, I want to upload my materials and add a note like "Focus on the Fourier Transform and ignore the intro slides".
- **US2:** As a student, I want the AI to look at my handwritten notes (images) and include my "personal tips" in the extraction.
- **US3:** As a student, I want the AI to output "Shorthand" vs. "Full" versions of definitions so I can choose the density level later.

## 5. Technical Requirements

### **The Prompt & File Interface**

- **Input:** `files: Blob[]`, `userDirective: string`.
- **Preprocessing:** Convert PPTX to image/PDF before ingestion to leverage Gemini's native vision capabilities.
- **Model:** `gemini-3.1-flash-lite-preview`.

### **The "Intelligence" Logic (System Prompt)**

> "You are an Elite Academic Editor.
>
> 1. Read the attached course materials.
> 2. Apply the User Directive: '{userDirective}'.
> 3. Extract items into a JSON schema:
>
> - `category`: (Formula, Definition, DiagramRef, ExamTrick).
> - `content`: (Native LaTeX for math).
> - `shorthand`: (Ultra-condensed version for high-density layouts).
> - `priority`: (1-10 based on User Directive + Exam frequency)."

## 6. Acceptance Criteria

- The system accepts a text prompt of up to 500 characters.
- The AI successfully prioritizes topics mentioned in the user prompt over general course content.
- Extracted math equations are correctly wrapped in `$ ... $` or `$$...$$`.
- A new entry is created in the `course_materials` table with the `extracted_json` and the original `user_directive` for future reference.
- Total processing time remains under 45 seconds for moderate datasets (e.g., 200MB total).

## 7. Constraints

- **Token Management:** If the files + prompt exceed 1M tokens, the system must throw a clear "Context Overload" error to the user.
- **Security:** The `userDirective` must be sanitized to prevent prompt injection attacks aimed at the AI.
