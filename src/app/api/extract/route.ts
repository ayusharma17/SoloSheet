import { createClient } from "@/lib/supabase/server";
import { extractFromMaterials } from "@/lib/gemini";
import { NextResponse } from "next/server";

// Admin emails bypass credit limits (comma-separated in env)
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);

// Allowed MIME types for upload
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200MB

// Simple in-memory rate limiter (User ID -> { count, windowStart })
// Limits to 5 extraction requests per minute per user
const rateLimitWindowMs = 60 * 1000;
const maxRequestsPerWindow = 5;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

export async function POST(request: Request) {
  try {
    // 1. Auth check
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1.5 Rate Limiting Check
    const now = Date.now();
    const userRateData = rateLimitMap.get(user.id) || { count: 0, windowStart: now };
    
    // Reset window if elapsed
    if (now - userRateData.windowStart > rateLimitWindowMs) {
      userRateData.count = 0;
      userRateData.windowStart = now;
    }
    
    if (userRateData.count >= maxRequestsPerWindow) {
      return NextResponse.json(
        { error: "Too many extraction requests. Please wait a minute and try again." },
        { status: 429 }
      );
    }
    
    // Increment rate limit counter
    userRateData.count++;
    rateLimitMap.set(user.id, userRateData);

    // 2. Credit check (admins bypass)
    const isAdmin = ADMIN_EMAILS.has((user.email ?? "").toLowerCase());

    const { data: profile } = await supabase
      .from("profiles")
      .select("credits")
      .eq("id", user.id)
      .single();

    if (!isAdmin && (!profile || profile.credits <= 0)) {
      return NextResponse.json(
        { error: "No credits remaining" },
        { status: 403 }
      );
    }

    // 3. Parse and Validate form data
    const formData = await request.formData();
    
    // Input Validation: Strings & Numbers
    const rawCourseName = (formData.get("courseName") as string) || "Untitled Course";
    const courseName = rawCourseName.slice(0, 100).trim(); // Max 100 chars
    
    const rawUserDirective = (formData.get("userDirective") as string) || "";
    const userDirective = rawUserDirective.slice(0, 1000).trim(); // Max 1000 chars

    let targetPages = parseInt((formData.get("targetPages") as string) || "1", 10);
    // Clamp pages between 1 and 20 to prevent client-side DOS during rendering
    if (isNaN(targetPages)) targetPages = 1;
    targetPages = Math.max(1, Math.min(20, targetPages));

    const fileEntries = formData.getAll("files") as File[];

    // Input Validation: File Count
    if (fileEntries.length === 0) {
      return NextResponse.json(
        { error: "No files uploaded" },
        { status: 400 }
      );
    }
    
    if (fileEntries.length > 10) {
      return NextResponse.json(
        { error: "Exceeded maximum of 10 files per extraction." },
        { status: 400 }
      );
    }

    // 4. Validate files
    let totalSize = 0;
    const files: { buffer: Buffer; mimeType: string; name: string }[] = [];

    for (const file of fileEntries) {
      if (!ALLOWED_TYPES.has(file.type)) {
        return NextResponse.json(
          {
            error: `Unsupported file type: ${file.type}. Allowed: PDF, PNG, JPEG, WebP, GIF`,
          },
          { status: 400 }
        );
      }

      totalSize += file.size;
      if (totalSize > MAX_TOTAL_SIZE) {
        return NextResponse.json(
          { error: "Total file size exceeds 200MB limit" },
          { status: 400 }
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      files.push({
        buffer: Buffer.from(arrayBuffer),
        mimeType: file.type,
        name: file.name,
      });
    }

    // 5. Call Gemini extraction
    let items;
    try {
      items = await extractFromMaterials(files, userDirective);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Extraction failed";
      // Check for token/context overflow
      if (
        message.includes("token") ||
        message.includes("context") ||
        message.includes("too large")
      ) {
        return NextResponse.json(
          {
            error:
              "Context Overload: Your files exceed the model's capacity. Try uploading fewer or smaller files.",
          },
          { status: 413 }
        );
      }
      return NextResponse.json(
        { error: `Extraction failed: ${message}` },
        { status: 500 }
      );
    }

    // 6. Save to course_materials
    const { data: material, error: insertError } = await supabase
      .from("course_materials")
      .insert({
        user_id: user.id,
        course_name: courseName,
        target_pages: targetPages,
        extracted_json: items,
        user_directive: userDirective.slice(0, 500),
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return NextResponse.json(
        { error: "Failed to save extraction results" },
        { status: 500 }
      );
    }

    // 7. Decrement credits (skip for admins)
    if (!isAdmin) {
      const { error: creditError } = await supabase.rpc("decrement_credits", {
        user_id: user.id,
      });

      if (creditError) {
        console.warn("RPC failed, trying direct update:", creditError);
        await supabase
          .from("profiles")
          .update({ credits: (profile?.credits ?? 1) - 1 })
          .eq("id", user.id);
      }
    }

    return NextResponse.json({
      success: true,
      materialId: material.id,
      items,
      remainingCredits: isAdmin ? (profile?.credits ?? 999) : (profile?.credits ?? 1) - 1,
    });
  } catch (err: unknown) {
    console.error("Extract API error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
