"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "katex/dist/katex.min.css";
import { paginateBlocks } from "@/lib/typesetting/paginate";
import MetaGuide from "@/components/meta-guide";
import SheetPage from "@/components/sheet-page";
import { Download, RefreshCw, ArrowLeft, Minus, Plus, BookOpen } from "lucide-react";

// ── Types ──
type ExtractionItem = {
  priority: number;
  topic?: string;
  category?: string;
  content: string;
  shorthand: string;
};

type Material = {
  id: string;
  course_name: string;
  extracted_json: ExtractionItem[];
  user_directive: string | null;
  target_pages?: number;
  created_at: string;
};

type LayoutParams = {
  fontSizePt: number;
  columns: number;
  useShorthandForLowPriority: boolean;
  cutoffPriority: number;
};

const INITIAL_PARAMS: LayoutParams = {
  fontSizePt: 9,
  columns: 3,
  useShorthandForLowPriority: false,
  cutoffPriority: 1, // include everything
};

export default function TypesetterClient({ material }: { material: Material }) {
  const [targetPages, setTargetPages] = useState<number>(material.target_pages || 1);
  const [includeGuide, setIncludeGuide] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [pages, setPages] = useState<number[][][]>([]);
  const [overflow, setOverflow] = useState(false);
  const guideMeasureRef = useRef<HTMLDivElement>(null);
  const [isSqueezing, setIsSqueezing] = useState(true);
  const [layoutParams, setLayoutParams] = useState<LayoutParams>({ ...INITIAL_PARAMS });
  const [squeezeIteration, setSqueezeIteration] = useState(0);

  const measureRef = useRef<HTMLDivElement>(null);

  // Sort items by priority (highest first)
  const sortedItems = useMemo(() => {
    return [...material.extracted_json].sort((a, b) => b.priority - a.priority);
  }, [material.extracted_json]);

  // Active items based on current cutoff
  const activeItems = useMemo(() => {
    return sortedItems.filter((item) => item.priority >= layoutParams.cutoffPriority);
  }, [sortedItems, layoutParams.cutoffPriority]);

  const droppedCount = sortedItems.length - activeItems.length;

  // Squeeze one step further
  const squeezeOneStep = useCallback((prev: LayoutParams): LayoutParams | null => {
    // Step 1: Shrink font
    if (prev.fontSizePt > 6) return { ...prev, fontSizePt: prev.fontSizePt - 0.5 };
    // Step 2: More columns
    if (prev.columns === 3) return { ...prev, columns: 4 };
    // Step 3: Enable shorthand
    if (!prev.useShorthandForLowPriority) return { ...prev, useShorthandForLowPriority: true };
    // Step 4: Drop lowest priority (last resort)
    if (prev.cutoffPriority < 10) return { ...prev, cutoffPriority: prev.cutoffPriority + 1 };
    return null; // exhausted
  }, []);

  // ── The Squeeze Loop ──
  useEffect(() => {
    if (!isSqueezing) return;

    let cancelled = false;
    let rafId = 0;
    // KaTeX and text font loads can change every block's measured dimensions.
    document.fonts.ready.then(() => {
      if (cancelled) return;
      rafId = requestAnimationFrame(() => {
        const container = measureRef.current;
        const columns = container?.querySelector<HTMLElement>(".sheet-columns");
        if (!container || !columns) return;
        const blocks = Array.from(container.querySelectorAll<HTMLElement>(".sheet-item"));
        const heights = blocks.map((block) => block.getBoundingClientRect().height + parseFloat(getComputedStyle(block).marginBottom || "0"));
        const result = paginateBlocks(heights, columns.getBoundingClientRect().height, layoutParams.columns);
        const wide = blocks.some((block) => block.scrollWidth > block.clientWidth + 1 ||
          Array.from(block.querySelectorAll<HTMLElement>(".katex-html")).some((math) => math.getBoundingClientRect().width > block.clientWidth + 1));
        const guide = guideMeasureRef.current;
        const guideContent = guide?.querySelector<HTMLElement>(".meta-guide");
        const guideOverflow = showGuide && !includeGuide && !!guideContent &&
          (guideContent.scrollHeight > guideContent.clientHeight + 1 || guideContent.scrollWidth > guideContent.clientWidth + 1);
        const exceeds = result.oversized || wide || result.pages.length > targetPages || guideOverflow;
        if (exceeds) {
          const next = squeezeOneStep(layoutParams);
          if (next) {
            setLayoutParams(next);
            setSqueezeIteration((i) => i + 1);
            return;
          }
        }
        setPages(result.pages);
        setOverflow(exceeds);
        setIsSqueezing(false);
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(rafId); };
  }, [isSqueezing, layoutParams, targetPages, squeezeIteration, squeezeOneStep, includeGuide, showGuide]);

  // Reset and re-run squeeze
  const resetSqueeze = useCallback(() => {
    setLayoutParams({ ...INITIAL_PARAMS });
    setSqueezeIteration(0);
    setIsSqueezing(true);
  }, []);

  const adjustPages = (delta: number) => {
    setTargetPages((p) => Math.max(1, p + delta));
    resetSqueeze();
  };

  const toggleGuide = () => {
    setIncludeGuide((v) => !v);
    resetSqueeze();
  };

  const handlePrint = () => { if (!isSqueezing && !overflow) window.print(); };

  // Status text
  const statusText = isSqueezing
    ? `Squeezing… (${layoutParams.fontSizePt}pt, ${layoutParams.columns} cols)`
    : `${overflow ? "⚠ Overflow — increase page limit or shorten content." : "✓ Fits."} ${layoutParams.fontSizePt}pt, ${layoutParams.columns} cols, ${activeItems.length} items${droppedCount > 0 ? ` (${droppedCount} dropped)` : ""}`;

  return (
    <div className="min-h-screen bg-[var(--background)] print:bg-white text-white print:text-black font-sans pb-20 print:pb-0 print:block">

      {/* ── Controls (hidden during print) ── */}
      <div className="sticky top-0 z-50 bg-[var(--background)]/80 backdrop-blur-md border-b border-white/10 p-4 print:hidden">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <a
              href="/dashboard"
              className="p-2 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-all"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-5 h-5" />
            </a>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
                {material.course_name}
              </h1>
              <p className="text-sm text-[var(--text-muted)] flex items-center gap-2">
                {isSqueezing && <RefreshCw className="w-3 h-3 animate-spin" />}
                {statusText}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Page count stepper */}
            <div className="flex items-center gap-1 bg-white/5 p-1 rounded-lg border border-white/10">
              <button
                onClick={() => adjustPages(-1)}
                disabled={isSqueezing || targetPages <= 1}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-white/10 transition-all disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="px-3 py-1 text-sm font-medium tabular-nums min-w-[70px] text-center">
                {targetPages} {targetPages === 1 ? "page" : "pages"}
              </span>
              <button
                onClick={() => adjustPages(1)}
                disabled={isSqueezing}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-white/10 transition-all disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {/* Include Guide toggle */}
            <button
              onClick={toggleGuide}
              disabled={isSqueezing}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all cursor-pointer disabled:opacity-50 ${
                includeGuide
                  ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
                  : "bg-white/5 text-[var(--text-muted)] border-white/10 hover:text-white"
              }`}
              title={includeGuide ? "Guide is included in page count" : "Guide is a separate page (not counted)"}
            >
              <BookOpen className="w-4 h-4" />
              {includeGuide ? "Guide: In pages" : "Guide: Separate"}
            </button>

            <button onClick={() => { setShowGuide((value) => !value); resetSqueeze(); }} disabled={isSqueezing} className="text-sm text-[var(--text-muted)]">
              {showGuide ? "Hide guide" : "Show guide"}
            </button>
            <span className="text-xs text-[var(--text-muted)]">{showGuide && !includeGuide ? `${pages.length} sheet + 1 guide page` : `${pages.length} total pages`}</span>
            {/* Save PDF */}
            <button
              onClick={handlePrint}
              disabled={isSqueezing || overflow}
              className="flex items-center gap-2 px-4 py-2 bg-white text-black font-medium rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Save as PDF
            </button>
          </div>
        </div>
      </div>

      <div className="sheet-canvas flex flex-col items-center gap-8 mt-8 pb-12 print:m-0 print:gap-0 print:pb-0 print:block">
        <div ref={measureRef} className="print:hidden" aria-hidden="true" style={{ position: "absolute", visibility: "hidden", left: "-10000px", top: 0, width: "8.5in" }}>
          <SheetPage items={activeItems} params={layoutParams} courseName={material.course_name}
            guide={showGuide && includeGuide ? <MetaGuide compact courseName={material.course_name} directive={material.user_directive} droppedCount={droppedCount} /> : undefined} />
        </div>
        {pages.map((columnItems, pageIndex) => (
          <div className="physical-page" key={pageIndex}>
            <SheetPage items={activeItems} params={layoutParams} courseName={material.course_name} columnItems={columnItems}
              guide={showGuide && includeGuide ? <MetaGuide compact courseName={material.course_name} directive={material.user_directive} droppedCount={droppedCount} /> : undefined} />
          </div>
        ))}
        {showGuide && !includeGuide && <div ref={guideMeasureRef} className="physical-page">
          <MetaGuide courseName={material.course_name} directive={material.user_directive} droppedCount={droppedCount} />
        </div>}
      </div>
    </div>
  );
}
