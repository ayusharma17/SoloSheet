import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";
import { redirect } from "next/navigation";
import DashboardClient from "./dashboard-client";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", user.id)
    .single();

  // Fetch recent course materials
  const { data: materials } = await supabase
    .from("course_materials")
    .select("id, course_name, created_at, user_directive, extracted_json")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(9);

  return (
    <DashboardClient
      user={{
        id: user.id,
        email: user.email ?? "",
        fullName: user.user_metadata?.full_name ?? user.user_metadata?.name ?? "Student",
        avatarUrl: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? "",
      }}
      credits={profile?.credits ?? 0}
      isAdmin={isAdminUser(user)}
      materials={materials ?? []}
    />
  );
}
