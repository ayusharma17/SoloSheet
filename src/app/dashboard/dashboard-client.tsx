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
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string;
  };
  credits: number;
  materials: CourseMaterial[];
}

export default function DashboardClient({ user, credits, materials }: DashboardClientProps) {
  const router = useRouter();
  const supabase = createClient();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  const handleUploadSuccess = () => {
    setIsModalOpen(false);
    router.refresh();
  };

  const isOutOfCredits = credits <= 0;
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
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)]">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[var(--background)]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight">
              CheatSheet<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">AI</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Credits Badge */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
              <CreditCard className="w-4 h-4 text-indigo-400" />
              <span className="text-sm font-medium">
                <span className={credits > 0 ? "text-indigo-400" : "text-red-400"}>
                  {credits}
                </span>{" "}
                <span className="text-[var(--text-muted)]">credits</span>
              </span>
            </div>

            {/* User Info */}
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                <Image
                  src={user.avatarUrl}
                  alt={user.fullName}
                  width={32}
                  height={32}
                  className="rounded-full ring-2 ring-white/10"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-medium text-white">
                  {user.fullName.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="hidden md:block text-sm font-medium text-[var(--text-secondary)]">
                {user.fullName}
              </span>
            </div>

            {/* Sign Out */}
            <button
              onClick={handleSignOut}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-white/5 transition-all duration-200 cursor-pointer"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Welcome Section */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Welcome back, {user.fullName.split(" ")[0]} 👋
          </h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Ready to create your next exam cheat sheet?
          </p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Credits Card */}
          <div className="glass-card p-6 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-[var(--text-secondary)]">
                  Available Credits
                </span>
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-indigo-400" />
                </div>
              </div>
              <div className="flex items-baseline gap-1">
                <span className={`text-4xl font-bold tabular-nums ${credits > 0 ? "credit-glow" : "text-red-400"}`}>
                  {credits}
                </span>
                <span className="text-sm text-[var(--text-muted)]">remaining</span>
              </div>
              <div className="mt-3 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-1000"
                  style={{ width: `${Math.min((credits / 3) * 100, 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Sheets Created Card */}
          <div className="glass-card p-6 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-teal-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-[var(--text-secondary)]">
                  Sheets Created
                </span>
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-emerald-400" />
                </div>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold tabular-nums">{sheetsCreated}</span>
                <span className="text-sm text-[var(--text-muted)]">total</span>
              </div>
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                {sheetsCreated === 0
                  ? "Create your first cheat sheet ↗"
                  : `${sheetsCreated} extraction${sheetsCreated > 1 ? "s" : ""} completed`}
              </p>
            </div>
          </div>

          {/* Recent Activity Card */}
          <div className="glass-card p-6 relative overflow-hidden group sm:col-span-2 lg:col-span-1">
            <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-orange-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-[var(--text-secondary)]">
                  Last Activity
                </span>
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-amber-400" />
                </div>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-medium text-[var(--text-muted)]">
                  {lastActivity ?? "No activity yet"}
                </span>
              </div>
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                {lastActivity
                  ? materials[0].course_name
                  : "Your recent cheat sheets will appear here"}
              </p>
            </div>
          </div>
        </div>

        {/* Create Cheat Sheet CTA */}
        <div className="glass-card p-8 relative overflow-hidden">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-purple-500/5 to-pink-500/5" />
          <div className="absolute -right-20 -top-20 w-60 h-60 bg-indigo-500/10 rounded-full blur-3xl" />

          <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <div className="flex-1">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                Create a New Cheat Sheet
              </h2>
              <p className="text-[var(--text-secondary)] mt-2 text-sm max-w-lg">
                Upload your lecture PDFs, slides, or notes and let AI compress them into a
                high-density, print-ready cheat sheet optimized for your exam.
              </p>
            </div>

            <div className="flex-shrink-0 w-full sm:w-auto">
              {isOutOfCredits ? (
                <div className="space-y-2">
                  <button
                    disabled
                    className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-white/5 border border-white/10 text-[var(--text-muted)] cursor-not-allowed"
                  >
                    <Upload className="w-5 h-5" />
                    Upload & Generate
                  </button>
                  <p className="flex items-center gap-1.5 text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5" />
                    0 Credits Remaining
                  </p>
                </div>
              ) : (
                <button
                  onClick={() => setIsModalOpen(true)}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-medium text-sm hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 cursor-pointer"
                >
                  <Upload className="w-5 h-5" />
                  Upload & Generate
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Recent Sheets */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Recent Cheat Sheets</h2>
          {materials.length === 0 ? (
            <div className="glass-card p-12 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                <FileText className="w-8 h-8 text-[var(--text-muted)]" />
              </div>
              <h3 className="font-medium text-[var(--text-secondary)]">No cheat sheets yet</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1 max-w-sm">
                Upload your first set of lecture materials to generate an exam-ready cheat sheet.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {materials.map((mat) => {
                const itemCount = Array.isArray(mat.extracted_json)
                  ? mat.extracted_json.length
                  : 0;
                return (
                  <a
                    key={mat.id}
                    href={`/cheat-sheet/${mat.id}`}
                    className="glass-card p-5 group hover:border-indigo-500/20 transition-all duration-300 cursor-pointer block"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <FileText className="w-5 h-5 text-indigo-400" />
                      </div>
                      <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 font-medium">
                        {itemCount} items
                      </span>
                    </div>
                    <h3 className="font-medium text-sm truncate">{mat.course_name}</h3>
                    {mat.user_directive && (
                      <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">
                        &ldquo;{mat.user_directive}&rdquo;
                      </p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] mt-2">
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
      />
    </div>
  );
}
