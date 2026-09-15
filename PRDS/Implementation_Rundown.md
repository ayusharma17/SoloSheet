# **SoloSheet Implementation Rundown**

This document serves as the master guide for building, deploying, and maintaining the **SoloSheet** platform. It consolidates the architecture, the UI design system, the core features, the anti-abuse mechanisms, and the monetization strategy into a unified implementation roadmap.

---

## 1. Technology Stack & Architecture

- **Frontend Framework:** Next.js (App Router, Server Actions, API Routes)
- **Styling & UI:** Tailwind CSS (customized for "Swiss Minimalist" design tokens)
- **Database & Authentication:** Supabase (PostgreSQL, Row Level Security, Triggers)
- **AI Processing:** Google Gemini API (for extracting and formatting dense cheat sheets)
- **Payments:** Stripe (Checkout Sessions, Webhooks)

---

## 2. User Interface (UI) Design System

The entire platform adheres to a **Swiss Minimalist / Brutalist** aesthetic to stand out and feel highly premium:

- **Colors:** Ultra-high contrast. Backgrounds are solid white (`#FFFFFF`) or off-white. Text is pure black (`#000000`). The core accent color is a striking red (`#E60000`).
- **Typography:** Bold, uppercase, tightly tracked lettering (e.g., `tracking-tighter uppercase`). Heavy emphasis on typographic hierarchy rather than visual fluff.
- **Borders & Shadows:** No `glassmorphism`, blur effects, or translucent panels. All containers use solid, thick black borders (`border-2 border-black` or `border-[3px] border-black`). Shadows are solid, un-blurred block drops (`shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`).
- **Interactions:** Hover states emphasize stark color inversions (white-to-black or black-to-red) or rigid structural translations (`translate-x-[4px] translate-y-[4px]`) representing physical button presses.

---

## 3. Database Schema & RLS (Supabase)

The database focuses on strong isolation and automatic provisioning:

- **`profiles`:** Matches `auth.users` 1-to-1. Tracks remaining `credits` (default 1).
- **`course_materials`:** Stores the generated cheat sheets linked to a user. Contains `course_name`, `extracted_json`, `target_pages`, and `user_directive`.
- **`admin_whitelist`:** A simple lookup table of emails that bypass all domain restrictions and receive an initial balance of 9,999 credits.
- **Row Level Security (RLS):** Policies are strictly defined so users can only `SELECT` and `INSERT` rows where `user_id = auth.uid()`.

---

## 4. Authentication & Identity Guard

SoloSheet enforces an incredibly strict entry gateway designed to force conversion from trial students:

- **Google OAuth ONLY:** Users authenticate specifically via their institutional Google accounts.
- **Domain Whitelist (`.edu` lock):**
  - Configured at the Google Cloud Console level (OAuth Consent Screen restrictions).
  - Backed up by a Supabase SQL Trigger (`handle_new_user`) that verifies the `new.email` ends in `.edu` or is present in the `admin_whitelist`. Any other email throws an exception, preventing profile creation.
- **Alias Resolution:** Since universities often use aliases (`netid@wisc.edu` vs `name@wisc.edu`), Google passes the exact same unique identifier (`sub`) to Supabase regardless of the alias typed. Supabase's built-in OAuth handling treats these as the same user session implicitly.

---

## 5. Trial credit controls

New legitimate `.edu` accounts receive exactly **1 trial credit**. The extraction service atomically reserves that credit before provider work, preventing repeated clicks or concurrent requests from spending it more than once. SoloSheet does not collect or use browser/device fingerprints; `.edu` eligibility and aggregate service limits are the current anti-abuse controls.

---

## 6. Payment & Monetization (Stripe)

The platform operates on a single hook-and-convert business model:

- **Pricing:** Users purchase "top-ups" at a strict rate of **$3.00 for 10 sheets**.
- **Checkout Session:** When a user hits zero credits and clicks "Add Credits", the Next.js API calls Stripe to create a Checkout Session for the pre-defined Price ID. CRITICAL: The API passes the Supabase `user_id` into Stripe's `client_reference_id` parameter.
- **Fulfillment (Webhooks):**
  - A secure endpoint (`/api/webhooks/stripe`) listens for the `checkout.session.completed` event.
  - It extracts the `client_reference_id`.
  - Using the Supabase Service Role Key (to bypass RLS), it calls the `add_credits` SQL RPC method, safely incrementing the user's balance by 10.

---

## 7. Core Feature: PDF/Image Upload & Cheat Sheet Generation

The primary utility of the application resides in a highly focused modal interface:

- **Data Collection:** The user inputs a Class Name, Target Pages (1-5), an optional Focus Directive, and uploads files (PDF, PNG, JPG).
- **Extraction:**
  - Next.js parses the files into base64 or extracts raw text (utilizing `pdf-parse` or similar libraries).
  - The text is packaged in a prompt designed to extract highly dense, LaTeX-formatted theorems and concepts while adhering rigidly to the Target Page limit and focusing entirely on the User's Directive.
- **LLM Processing:** The prompt is sent to the Google Gemini API (or equivalent fast, large-context model).
- **Result Output:** The structured JSON response is inserted into the `course_materials` table. The dashboard reads this data and renders the final cheat sheet using a LaTeX-compatible markdown parser.
