"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Image from "next/image";
import {
  BookOpen,
  CreditCard,
  Upload,
  LogOut,
  Sparkles,
  FileText,
  Clock,
  AlertCircle,
} from "lucide-react";
import UploadModal from "./upload-modal";

interface CourseMaterial {
  id: string;
  course_name: string;
  created_at: string;
  user_directive: string | null;
  extracted_json: unknown;
}

interface DashboardClientProps {
  user: {
    fullName: string;
    avatarUrl: string;
  };
  credits: number;
  isAdmin: boolean;
  isAccountHeld: boolean;
  checkoutStatus: "success" | "canceled" | null;
  materials: CourseMaterial[];
}

export default function DashboardClient({
  user,
  credits,
  isAdmin,
  isAccountHeld,
  checkoutStatus,
  materials,
}: DashboardClientProps) {
  const router = useRouter();
  const supabase = createClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  const handleUploadSuccess = () => {
    setIsModalOpen(false);
    router.refresh();
  };

  const handleCheckout = async () => {
    setCheckoutLoading(true);
    setCheckoutError("");
    try {
      const response = await fetch("/api/stripe/checkout", { method: "POST" });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" ||
          typeof (payload as { url?: unknown }).url !== "string") {
        throw new Error("Checkout unavailable");
      }
      window.location.assign((payload as { url: string }).url);
    } catch {
      setCheckoutError("Checkout is temporarily unavailable. Please try again.");
      setCheckoutLoading(false);
    }
  };

  const isOutOfCredits = !isAdmin && credits <= 0;
  const generationBlocked = isAccountHeld || isOutOfCredits;
  const sheetsCreated = materials.length;
  const lastActivity = materials.length > 0
    ? new Date(materials[0].created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="min-h-screen bg-white text-black selection:bg-black selection:text-white font-sans flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b-[3px] border-black bg-white">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-black flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tighter uppercase">
              Solo<span className="text-[#e60000]">Sheet</span>
            </span>
          </div>

          <div className="flex items-center gap-6">
            {/* Credits Badge */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 border-2 border-black">
              <CreditCard className="w-4 h-4 text-black" />
              <span className="text-xs font-bold uppercase tracking-tight">
                <span className={isAdmin || credits > 0 ? "text-black" : "text-[#e60000]"}>
                  {isAdmin ? "∞" : credits}
                </span>{" "}
                <span className="text-neutral-500">{isAdmin ? "unlimited" : "credits"}</span>
              </span>
            </div>

            {/* User Info */}
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                <Image
                  src={user.avatarUrl}
                  alt={user.fullName}
                  width={34}
                  height={34}
                  className="rounded-none border-2 border-black"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-8 h-8 bg-black flex items-center justify-center text-sm font-bold text-white uppercase">
                  {user.fullName.charAt(0)}
                </div>
              )}
              <span className="hidden md:block text-sm font-bold uppercase tracking-tight">
                {user.fullName}
              </span>
            </div>

            {/* Sign Out */}
            <button
              onClick={handleSignOut}
              className="p-2 border-2 border-transparent hover:border-black transition-colors cursor-pointer"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5 text-black" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-[1400px] mx-auto px-6 py-12 space-y-12 animate-slide-up">
        {/* Welcome Section */}
        <div>
          <h1 className="text-4xl sm:text-5xl font-black uppercase tracking-tighter">
            Welcome, {user.fullName.split(" ")[0]}.
          </h1>
          <p className="text-xl text-neutral-600 font-medium mt-2">
            Control panel. Create and manage your cheat sheets.
          </p>
        </div>

        {checkoutStatus ? (
          <div
            className={`border-[3px] border-black p-4 text-sm font-bold uppercase tracking-wider ${
              checkoutStatus === "success" ? "bg-green-100" : "bg-neutral-100"
            }`}
            role="status"
          >
            {checkoutStatus === "success"
              ? "Payment submitted. Credits appear after Stripe confirms the payment. Refresh if the balance has not updated yet."
              : "Checkout canceled. No credits were added and you were not charged."}
          </div>
        ) : null}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 border-b-[3px] border-black pb-12">
          {/* Credits Card */}
          <div className="swiss-card p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
                  Credits Remaining
                </span>
                <CreditCard className="w-5 h-5 text-black" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-6xl font-black tracking-tighter ${isAdmin || credits > 0 ? "text-black" : "text-[#e60000]"}`}>
                  {isAdmin ? "∞" : credits}
                </span>
              </div>
            </div>
            <div className="mt-6 border-2 border-black h-3 w-full bg-white relative">
              <div
                className="absolute top-0 left-0 h-full bg-[#e60000] transition-all duration-500"
                style={{ width: isAdmin ? "100%" : `${Math.min((credits / 10) * 100, 100)}%` }}
              />
            </div>
          </div>

          {/* Sheets Created Card */}
          <div className="swiss-card p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
                  Sheets Created
                </span>
                <FileText className="w-5 h-5 text-black" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-6xl font-black tracking-tighter text-black">{sheetsCreated}</span>
              </div>
            </div>
            <p className="mt-6 text-xs font-bold uppercase tracking-widest text-neutral-600">
              {sheetsCreated === 0
                ? "Awaiting first extraction"
                : "Extractions completed"}
            </p>
          </div>

          {/* Recent Activity Card */}
          <div className="swiss-card p-6 sm:col-span-2 lg:col-span-1 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">
                  Last Activity
                </span>
                <Clock className="w-5 h-5 text-black" />
              </div>
              <div className="flex items-baseline gap-2 mt-4">
                <span className="text-2xl font-black uppercase tracking-tight text-black line-clamp-2 leading-none">
                  {lastActivity ?? "N/A"}
                </span>
              </div>
            </div>
            <p className="mt-6 text-xs font-bold uppercase tracking-widest text-neutral-600 truncate">
              {lastActivity
                ? materials[0].course_name
                : "No logs available"}
            </p>
          </div>
        </div>

        {/* Create Cheat Sheet CTA */}
        <div className="swiss-card p-10 bg-[#f4f4f5]">
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-8">
            <div className="flex-1">
              <h2 className="text-3xl font-black uppercase tracking-tight flex items-center gap-3">
                <Sparkles className="w-6 h-6 text-[#e60000]" />
                Create New Sheet
              </h2>
              <p className="text-neutral-600 mt-4 text-base font-medium max-w-2xl leading-relaxed">
                Upload lecture PDFs, slides, or raw text. The engine compresses the input material into a high-density, strictly-formatted exam document.
              </p>
            </div>

            <div className="flex-shrink-0 w-full sm:w-auto">
              {generationBlocked ? (
                <div className="space-y-3">
                  <button
                    disabled
                    className="w-full sm:w-auto flex items-center justify-center gap-3 px-8 py-4 bg-neutral-300 border-2 border-neutral-400 text-neutral-500 font-bold uppercase tracking-widest cursor-not-allowed"
                  >
                    <Upload className="w-5 h-5" />
                    Upload & Generate
                  </button>
                  <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#e60000]">
                    <AlertCircle className="w-4 h-4" />
                    {isAccountHeld ? "System Halt: Account Under Review" : "System Halt: 0 Credits"}
                  </p>
                  {isOutOfCredits && !isAccountHeld && (
                    <button
                      type="button"
                      onClick={handleCheckout}
                      disabled={checkoutLoading}
                      className="w-full border-2 border-black bg-black px-5 py-3 text-sm font-bold uppercase tracking-widest text-white hover:bg-[#e60000] disabled:cursor-wait disabled:opacity-60"
                    >
                      {checkoutLoading ? "Opening Checkout…" : "Add 10 Credits — $3"}
                    </button>
                  )}
                  {checkoutError && (
                    <p className="max-w-xs text-xs font-bold text-[#e60000]" role="alert">
                      {checkoutError}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setIsModalOpen(true)}
                  className="w-full sm:w-auto flex items-center justify-center gap-3 px-8 py-4 bg-[#e60000] text-white font-bold uppercase tracking-widest hover:bg-black transition-colors border-2 border-black cursor-pointer shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-1 hover:translate-y-1 active:scale-95 duration-100"
                >
                  <Upload className="w-5 h-5" />
                  Initiate Upload
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Recent Sheets */}
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tight mb-8">Generated Assets</h2>
          {materials.length === 0 ? (
            <div className="border-4 border-dashed border-neutral-300 p-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-neutral-200 flex items-center justify-center mb-6">
                <FileText className="w-8 h-8 text-neutral-400" />
              </div>
              <h3 className="font-black text-xl uppercase tracking-tight text-neutral-400">Database Empty</h3>
              <p className="text-sm font-medium text-neutral-500 mt-2 max-w-sm uppercase tracking-widest">
                Upload materials to populate records.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {materials.map((mat) => {
                const itemCount = Array.isArray(mat.extracted_json)
                  ? mat.extracted_json.length
                  : 0;
                return (
                  <a
                    key={mat.id}
                    href={`/cheat-sheet/${mat.id}`}
                    className="swiss-card p-6 group cursor-pointer block hover:bg-[#f4f4f5]"
                  >
                    <div className="flex items-start justify-between mb-6">
                      <div className="w-12 h-12 bg-black flex items-center justify-center group-hover:bg-[#e60000] transition-colors">
                        <FileText className="w-6 h-6 text-white" />
                      </div>
                      <span className="text-xs font-bold px-2 py-1 border-2 border-black uppercase tracking-tight">
                        {itemCount} blocks
                      </span>
                    </div>
                    <h3 className="font-black text-lg uppercase tracking-tight truncate leading-tight">{mat.course_name}</h3>
                    {mat.user_directive && (
                      <p className="text-sm font-medium text-neutral-600 mt-2 line-clamp-2">
                        {mat.user_directive}
                      </p>
                    )}
                    <p className="text-xs font-bold text-neutral-400 uppercase tracking-widest mt-6">
                      {new Date(mat.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Upload Modal */}
      <UploadModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleUploadSuccess}
        credits={credits}
        isAdmin={isAdmin}
      />
    </div>
  );
}
