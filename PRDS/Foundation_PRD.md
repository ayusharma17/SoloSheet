# PRD: Foundations & Credit-Gated Infrastructure (Phase 1)

## 1. Introduction

This project is a web-based **AI Cheat Sheet Maker** designed for students. It takes raw course materials (PDFs, slides, notes) and compresses them into high-density, exam-ready cheat sheets. This phase establishes the SaaS skeleton, user authentication, and a credit-based system to control costs.

## 2. Problem Statement

Running large-context AI models like Gemini 1.5/3 Flash costs money. Without a system to identify users and limit their usage, a public web tool could result in uncapped API expenses for the owner.

## 3. Solution/Feature Overview

A Next.js web application integrated with Supabase for authentication and database management. The app will feature a "Credit Guard" that prevents users from triggering AI processes unless they have sufficient credits in their account.

## 4. User Stories

- **US1:** As a student, I want to sign up via Google so I don't have to remember another password.
- **US2:** As a user, I want to see my remaining "Cheat Sheet Credits" on a dashboard.
- **US3:** As the owner, I want to automatically grant 3 free credits to new users so they can test the tool.
- **US4:** As the owner, I want the system to block AI requests if a user has 0 credits.

## 5. Technical Requirements

### **Tech Stack**

- **Frontend:** Next.js 15 (App Router), Tailwind CSS, Lucide Icons.
- **Backend:** Next.js Server Actions or FastAPI (for heavy Python logic in Phase 2).
- **Database/Auth:** Supabase (PostgreSQL).
- **Hosting:** Netlify (Free Tier).

### **Data Model: `profiles` table**

| Field Name   | Type      | Description                                |
| ------------ | --------- | ------------------------------------------ |
| `id`         | uuid (PK) | Links to `auth.users`                      |
| `full_name`  | text      | User's name from OAuth                     |
| `credits`    | integer   | Number of allowed generations (Default: 3) |
| `created_at` | timestamp | Account creation date                      |

## 6. Acceptance Criteria

- New users can successfully sign in using Supabase Google OAuth.
- A `profile` record is automatically created in the database upon the first login.
- The Dashboard displays the current user's `credits` count.
- An "Upload" button is disabled and shows a "0 Credits Remaining" message if the user's credit count is zero.
- The UI is responsive and follows a "Dark Mode" academic aesthetic.

## 7. Constraints

- **Cost Limit:** Must stay within the Supabase and Netlify Free Tiers.
- **Security:** All database writes to the `credits` column must be protected by Row Level Security (RLS) to prevent users from manually increasing their own credits via the browser console.
- **Performance:** Initial page load must be under 2 seconds.
