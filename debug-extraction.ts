import { createClient } from "@supabase/supabase-js";
import { extractFromMaterials } from "./src/lib/gemini";
import fs from "fs";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const dir = "/Users/ayushsharma/Desktop/CheatSheetProject/Test_Files/639_test";
const filesToUpload = ["lecture2-ml-intro.pdf"];

async function run() {
  console.log("Mocking isolation test...");
  const files = [];

  for (const filename of filesToUpload) {
    const filePath = path.join(dir, filename);
    const buffer = fs.readFileSync(filePath);
    files.push({
      buffer,
      mimeType: "application/pdf",
      name: filename,
    });
    console.log(`Loaded ${filename}`);
  }

  let items;
  console.log("Extracting with Gemini...");
  try {
    items = await extractFromMaterials(files, "Focus on everything");
    console.log(`Extracted ${items?.length} items.`);
  } catch (err) {
    console.error("Gemini Extraction Error:", err);
    return;
  }

  console.log("Inserting to Supabase course_materials...");
  try {
    // We don't have a user context here, but let's try pushing it if RLS allows anon, or it might fail gracefully.
    const { data: material, error: insertError } = await supabase
      .from("course_materials")
      .insert({
        user_id: "7cc81912-78d1-4475-b38d-e6a3943ed2d8", // random mock
        course_name: "Isolation Test",
        target_pages: 1,
        extracted_json: items,
        user_directive: "Focus on everything",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Supabase Insert Error:", insertError);
    } else {
      console.log("Success! Material ID:", material.id);
    }
  } catch (err) {
    console.error("Outer Supabase Error:", err);
  }
}

run();
