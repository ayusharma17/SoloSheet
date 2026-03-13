import { createClient } from "@/lib/supabase/server";
import { extractFromMaterials } from "@/lib/gemini";
import { NextResponse } from "next/server";
import {
  downloadFileFromStorage,
  isValidSupabaseStorageUrl,
  cleanupUploadedFiles,
} from "@/lib/supabase/storage-helpers";

export const maxDuration = 300; // 5 minutes
export const dynamic = "force-dynamic";

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

    // 3. Parse JSON payload (now lightweight - just URLs, not base64)
    let payload;
    try {
      payload = await request.json();
    } catch (e: any) {
      console.error("JSON PARSE ERROR:", e);
      return NextResponse.json(
        { error: "Failed to parse request body." },
        { status: 400 }
      );
    }
    
    // Input Validation: Strings & Numbers
    const rawCourseName = payload.courseName || "Untitled Course";
    const courseName = rawCourseName.slice(0, 100).trim(); // Max 100 chars
    
    const rawUserDirective = payload.userDirective || "";
    const userDirective = rawUserDirective.slice(0, 1000).trim(); // Max 1000 chars

    let targetPages = parseInt(payload.targetPages || "1", 10);
    // Clamp pages between 1 and 20 to prevent client-side DOS during rendering
    if (isNaN(targetPages)) targetPages = 1;
    targetPages = Math.max(1, Math.min(20, targetPages));

    const fileUrls = payload.fileUrls || [];

    // Input Validation: File Count
    if (fileUrls.length === 0) {
      return NextResponse.json(
        { error: "No files uploaded" },
        { status: 400 }
      );
    }

    if (fileUrls.length > 10) {
      return NextResponse.json(
        { error: "Exceeded maximum of 10 files per extraction." },
        { status: 400 }
      );
    }

    // 4. Validate file URLs and sizes
    let totalSize = 0;
    const filePaths: string[] = []; // Track for cleanup

    for (const fileEntry of fileUrls) {
      // Validate URL is from Supabase Storage
      if (!isValidSupabaseStorageUrl(fileEntry.url)) {
        return NextResponse.json(
          {
            error: `Invalid file URL: ${fileEntry.name}. Files must be uploaded to Supabase Storage.`,
          },
          { status: 400 }
        );
      }

      // Validate MIME type
      if (!ALLOWED_TYPES.has(fileEntry.type)) {
        return NextResponse.json(
          {
            error: `Unsupported file type: ${fileEntry.type}. Allowed: PDF, PNG, JPEG, WebP, GIF`,
          },
          { status: 400 }
        );
      }

      // Validate total size BEFORE downloading
      totalSize += fileEntry.size || 0;
      if (totalSize > MAX_TOTAL_SIZE) {
        return NextResponse.json(
          { error: "Total file size exceeds 200MB limit" },
          { status: 400 }
        );
      }

      // Track storage path for cleanup
      if (fileEntry.path) {
        filePaths.push(fileEntry.path);
      }
    }

    // 5. Download files from Supabase Storage
    const files: { buffer: Buffer; mimeType: string; name: string }[] = [];

    try {
      for (const fileEntry of fileUrls) {
        console.log(`[Extract API] Downloading ${fileEntry.name} from storage...`);
        const { buffer } = await downloadFileFromStorage(
          fileEntry.url,
          "supabase.co" // Validate domain for security
        );

        files.push({
          buffer,
          mimeType: fileEntry.type,
          name: fileEntry.name,
        });
      }
    } catch (downloadError: unknown) {
      const message =
        downloadError instanceof Error
          ? downloadError.message
          : "Failed to download file from storage";
      console.error("[Extract API] Download error:", downloadError);
      return NextResponse.json(
        { error: `Download failed: ${message}` },
        { status: 500 }
      );
    }

    // 6. Call Gemini extraction
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
        // Cleanup files on extraction failure
        if (filePaths.length > 0) {
          await cleanupUploadedFiles(supabase, filePaths);
        }
        return NextResponse.json(
          {
            error:
              "Context Overload: Your files exceed the model's capacity. Try uploading fewer or smaller files.",
          },
          { status: 413 }
        );
      }
      // Cleanup files on extraction failure
      if (filePaths.length > 0) {
        await cleanupUploadedFiles(supabase, filePaths);
      }
      return NextResponse.json(
        { error: `Extraction failed: ${message}` },
        { status: 500 }
      );
    }

    // 7. Save to course_materials
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
      // Cleanup files on save failure
      if (filePaths.length > 0) {
        await cleanupUploadedFiles(supabase, filePaths);
      }
      return NextResponse.json(
        { error: "Failed to save extraction results" },
        { status: 500 }
      );
    }

    // 8. Decrement credits (skip for admins)
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

    // 9. Cleanup uploaded files after successful processing
    if (filePaths.length > 0) {
      await cleanupUploadedFiles(supabase, filePaths);
      console.log(`[Extract API] Cleaned up ${filePaths.length} files from storage`);
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
