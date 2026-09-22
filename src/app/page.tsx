import Link from "next/link";
import { BookOpen, Sparkles, Zap, FileText, ArrowRight, Layers } from "lucide-react";
import { LAUNCH_TRIAL_OFFER } from "@/lib/product-copy";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-black selection:bg-black selection:text-white flex flex-col font-sans">
      {/* Nav */}
      <nav className="w-full border-b-[3px] border-black px-6 h-16 flex items-center justify-between bg-white z-10 sticky top-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-black flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tighter uppercase">
            Solo<span className="text-[#e60000]">Sheet</span>
          </span>
        </div>
        <Link
          href="/login"
          className="px-6 py-1.5 border-2 border-black text-sm font-bold uppercase tracking-tight hover:bg-black hover:text-white transition-colors"
        >
          Sign In
        </Link>
      </nav>

      <main className="flex-1 w-full max-w-[1400px] mx-auto px-6 py-12 md:py-24 grid grid-cols-1 md:grid-cols-12 gap-12">
        {/* Hero Section */}
        <section className="md:col-span-12 lg:col-span-8 flex flex-col justify-center animate-slide-up">
          <div className="inline-flex items-center gap-2 border-2 border-black px-3 py-1 text-xs font-bold uppercase tracking-widest text-[#e60000] w-fit mb-8 decoration-black">
            <Sparkles className="w-3.5 h-3.5" />
            Powered by Gemini AI
          </div>

          <h1 className="text-6xl md:text-8xl lg:text-[100px] font-black tracking-tighter leading-[0.9] uppercase break-words">
            Your Notes.<br />
            <span className="text-[#e60000]">One Page.</span><br />
            Exam Ready.
          </h1>

          <p className="mt-8 text-xl md:text-2xl text-neutral-600 font-medium max-w-2xl leading-snug">
            Upload your lectures and notes. AI compresses them into a high-density,
            print-ready cheat sheet that fits your exam&apos;s page limit.
          </p>

          <div className="mt-12 flex flex-col sm:flex-row items-center gap-6">
            <Link
              href="/login"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-3 px-8 py-4 bg-[#e60000] text-white font-bold text-lg uppercase tracking-tight hover:bg-black transition-colors border-2 border-transparent hover:border-black"
            >
              Get Started Free
              <ArrowRight className="w-5 h-5" />
            </Link>
            <span className="text-sm font-bold uppercase tracking-widest text-neutral-500">
              {LAUNCH_TRIAL_OFFER} <span className="text-black mx-2">•</span> No card required
            </span>
          </div>
        </section>

        {/* Feature Grid */}
        <section className="md:col-span-12 mt-12 md:mt-24 grid grid-cols-1 md:grid-cols-3 gap-8 border-t-[3px] border-black pt-12 animate-slide-up" style={{ animationDelay: "0.2s" }}>
          {/* Feature 1 */}
          <div className="swiss-card p-8 flex flex-col">
            <div className="w-12 h-12 bg-black flex items-center justify-center mb-6">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <h3 className="text-2xl font-black uppercase tracking-tight mb-4">LaTeX-Native Math</h3>
            <p className="text-neutral-700 font-medium leading-relaxed">
              Equations rendered perfectly with native <code className="text-xs bg-neutral-200 text-black px-1.5 py-0.5 font-mono font-bold">amsmath</code> support. No broken formulas.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="swiss-card p-8 flex flex-col">
            <div className="w-12 h-12 bg-[#e60000] flex items-center justify-center mb-6">
              <Layers className="w-6 h-6 text-white" />
            </div>
            <h3 className="text-2xl font-black uppercase tracking-tight mb-4">Squeeze & Fit</h3>
            <p className="text-neutral-700 font-medium leading-relaxed">
              Auto-compresses content to fit your exact page limit. Every millimeter of the page is fully utilized.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="swiss-card p-8 flex flex-col">
            <div className="w-12 h-12 bg-black flex items-center justify-center mb-6">
              <FileText className="w-6 h-6 text-white" />
            </div>
            <h3 className="text-2xl font-black uppercase tracking-tight mb-4">Print-Ready PDF</h3>
            <p className="text-neutral-700 font-medium leading-relaxed">
              Multi-column layout with strict grid alignment. Just hit print and walk into your exam prepared.
            </p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="w-full border-t-[3px] border-black py-8 bg-black text-white px-6 mt-auto">
        <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          <span className="font-bold tracking-widest uppercase text-sm">
            Solo<span className="text-[#e60000]">Sheet</span>
          </span>
          <span className="text-xs font-medium uppercase tracking-widest text-neutral-400">
            © {new Date().getFullYear()} — Built for students
          </span>
        </div>
      </footer>
    </div>
  );
}
