import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";
import { isAccountHeld } from "@/lib/account-holds";
import { redirect } from "next/navigation";
import DashboardClient from "./dashboard-client";

type DashboardPageProps = {
  searchParams: Promise<{
    checkout?: string | string[];
    session_id?: string | string[];
  }>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const checkout = params.checkout;
  const checkoutStatus = checkout === "success" || checkout === "canceled"
    ? checkout
    : null;
  const checkoutSessionId = checkoutStatus === "success" && typeof params.session_id === "string"
    ? params.session_id
    : null;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [profileResult, materialsResult, admin, accountHeld] = await Promise.all([
    supabase.from("profiles").select("credits").eq("id", user.id).single(),
    supabase
      .from("course_materials")
      .select("id, course_name, created_at, user_directive, extracted_json")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(9),
    isAdminUser(user),
    isAccountHeld(user.id),
  ]);
  const credits = !profileResult.error &&
    Number.isInteger(profileResult.data?.credits) &&
    Number(profileResult.data?.credits) >= 0
    ? Number(profileResult.data?.credits)
    : null;

  return (
    <DashboardClient
      user={{
        fullName: user.user_metadata?.full_name ?? user.user_metadata?.name ?? "Student",
        avatarUrl: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? "",
      }}
      credits={credits}
      isAdmin={admin}
      isAccountHeld={accountHeld}
      checkoutStatus={checkoutStatus}
      checkoutSessionId={checkoutSessionId}
      materials={materialsResult.data ?? []}
    />
  );
}
