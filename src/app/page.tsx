import Link from "next/link";
import { BookOpen, Sparkles, Zap, FileText, ArrowRight, Layers } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)] overflow-hidden">
      {/* Ambient background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-purple-500/8 rounded-full blur-3xl animate-pulse-slow" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-blue-500/8 rounded-full blur-3xl animate-pulse-slow" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-indigo-500/5 rounded-full blur-3xl" />
      </div>

      {/* Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:64px_64px] pointer-events-none" />

      {/* Nav */}
      <nav className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            CheatSheet<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">AI</span>
          </span>
        </div>
        <Link
          href="/login"
          className="px-5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)] transition-all duration-200"
        >
          Sign In
        </Link>
      </nav>

      {/* Hero */}
      <section className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 sm:pt-32 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-xs font-medium text-indigo-400 mb-8 animate-fade-in">
          <Sparkles className="w-3.5 h-3.5" />
          Powered by Gemini AI
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight animate-fade-in">
          Your Notes.{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
            One Page.
          </span>
          <br />
          Exam Ready.
        </h1>

        <p className="mt-6 text-lg sm:text-xl text-[var(--text-secondary)] max-w-2xl mx-auto animate-fade-in">
          Upload your lectures and notes — AI compresses them into a high-density,
          print-ready cheat sheet that fits your exam&apos;s page limit.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in">
          <Link
            href="/login"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-medium hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
          >
            Get Started Free
            <ArrowRight className="w-4 h-4" />
          </Link>
          <span className="text-sm text-[var(--text-muted)]">3 free credits • No card required</span>
        </div>
      </section>

      {/* Feature Cards */}
      <section className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-card p-6 group hover:border-indigo-500/30 transition-all duration-300">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
              <Zap className="w-6 h-6 text-indigo-400" />
            </div>
            <h3 className="font-semibold mb-2">LaTeX-Native Math</h3>
            <p className="text-sm text-[var(--text-muted)] leading-relaxed">
              Equations rendered perfectly with native <code className="text-xs bg-white/5 px-1.5 py-0.5 rounded">amsmath</code> support. No broken formulas.
            </p>
          </div>

          <div className="glass-card p-6 group hover:border-purple-500/30 transition-all duration-300">
            <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
              <Layers className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="font-semibold mb-2">Squeeze & Fit</h3>
            <p className="text-sm text-[var(--text-muted)] leading-relaxed">
              Auto-compresses content to fit your exact page limit. Every millimeter used.
            </p>
          </div>

          <div className="glass-card p-6 group hover:border-pink-500/30 transition-all duration-300">
            <div className="w-12 h-12 rounded-xl bg-pink-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
              <FileText className="w-6 h-6 text-pink-400" />
            </div>
            <h3 className="font-semibold mb-2">Print-Ready PDF</h3>
            <p className="text-sm text-[var(--text-muted)] leading-relaxed">
              Multi-column layout with proper margins. Just hit print and walk into your exam.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5 py-8 text-center text-xs text-[var(--text-muted)]">
        © {new Date().getFullYear()} CheatSheetAI — Built for students, by students.
      </footer>
    </div>
  );
}
