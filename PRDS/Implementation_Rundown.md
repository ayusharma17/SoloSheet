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

- **`profiles`:** Matches `auth.users` 1-to-1. Tracks remaining `credits`
  (safe schema default 0; provisioning assigns the initial balance explicitly).
- **`course_materials`:** Stores the generated cheat sheets linked to a user. Contains `course_name`, `extracted_json`, `target_pages`, and `user_directive`.
- **`admin_whitelist`:** The private, canonical list of administrator emails;
  it controls administrator status and is changed only through an audited server workflow.
- **`private_feature_flags`:** Private singleton configuration for prospective
  non-`.edu` trial grants, read and changed only through audited server RPCs.
- **`audit_events`:** An append-only application audit trail for trial grants and sensitive administrator/payment actions.
- **Row Level Security (RLS):** User-owned product data is isolated by authenticated user ID; administrator, audit, hold, and payment tables are inaccessible to ordinary clients.

---

## 4. Authentication & Identity Guard

SoloSheet separates verified account eligibility from promotional-credit policy:

- **Google OAuth:** Users authenticate with a verified Google identity; any
  valid email domain can create an account.
- **Database provisioning:** `handle_new_user` validates the authoritative Auth
  email, always creates an ordinary verified profile, and independently assigns
  a promotional credit according to email class and the private launch flag.
- **Historical recovery:** the callback invokes a self-scoped repair RPC for
  verified identities left without profiles by the former domain restriction;
  repair creates a zero-credit profile and never backfills a promotion.
- **Identity Mapping:** Profiles are keyed by the Supabase Auth user ID. The same Supabase identity retains one profile, but separate Google accounts or institutional aliases are not guessed or merged.

---

## 5. Trial credit controls

New verified `.edu` accounts receive exactly **1 trial credit** in the
profile-creation transaction. New non-`.edu` accounts receive one while the
audited `non_edu_trial_credits_enabled` flag is On and zero while it is Off; in
both cases the account remains usable and purchase-capable. Flag changes affect
only later profile creation. Allowlisted administrators receive no finite
placeholder balance; their unlimited status is resolved from the canonical
database allowlist. The extraction service atomically reserves credits before
provider work, preventing repeated clicks or concurrent requests from spending
the same credit more than once. SoloSheet does not collect or use browser/device
fingerprints. Shared rate limiting is tracked separately as post-MVP reliability work.

---

## 6. Payment & Monetization (Stripe)

The platform operates on a single hook-and-convert business model:

- **Pricing:** Users purchase "top-ups" at a strict rate of **$3.00 for 10 sheets**.
- **Checkout Session:** When a user hits zero credits and clicks "Add Credits", the Next.js API calls Stripe to create a Checkout Session for the pre-defined Price ID. CRITICAL: The API passes the Supabase `user_id` into Stripe's `client_reference_id` parameter.
- **Fulfillment (Webhooks):**
  - A secure endpoint (`/api/webhooks/stripe`) verifies Stripe's signature against the untouched request body before accepting payment or review events.
  - It matches the Checkout Session, authenticated user reference, configured package, amount, currency, and environment to a server-created pending purchase.
  - A service-only database transaction records the unique event and payment identifiers and increments the balance by exactly 10 once, including under retries or concurrent deliveries.
  - Refunds, disputes, and chargebacks preserve the current balance but place the account under an auditable review hold that blocks Checkout and extraction.

---

## 7. Core Feature: PDF/Image Upload & Cheat Sheet Generation

The primary utility of the application resides in a highly focused modal interface:

- **Data Collection:** The user inputs a Class Name, Target Pages (1-20), an optional Focus Directive, and uploads files (PDF, PNG, JPG).
- **Extraction:**
  - The server validates owned storage objects, MIME types, magic bytes, and streamed byte limits before sending supported PDFs/images to Gemini.
  - The text is packaged in a prompt designed to extract highly dense, LaTeX-formatted theorems and concepts while adhering rigidly to the Target Page limit and focusing entirely on the User's Directive.
- **LLM Processing:** The prompt is sent to the Google Gemini API (or equivalent fast, large-context model).
- **Result Output:** The structured JSON response is inserted into the `course_materials` table. The dashboard reads this data and renders the final cheat sheet using a LaTeX-compatible markdown parser.
