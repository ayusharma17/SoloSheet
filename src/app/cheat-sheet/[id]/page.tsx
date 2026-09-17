import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TypesetterClient from "./typesetter-client";

export default async function CheatSheetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // 1. Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // 2. Fetch the cheat sheet data
  const { data: material, error } = await supabase
    .from("course_materials")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !material) {
    // Basic 404 handling if not found or unauthorized (RLS prevents reading others' sheets)
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">Cheat Sheet Not Found</h1>
          <p className="text-[var(--text-muted)]">It may have been deleted or you don&apos;t have access.</p>
          <a href="/dashboard" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-4">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return <TypesetterClient material={material} />;
}
