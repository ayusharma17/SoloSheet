"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "katex/dist/katex.min.css";
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

    const rafId = requestAnimationFrame(() => {
      const container = measureRef.current;
      if (!container) {
        setIsSqueezing(false);
        return;
      }

      // 8.5in × 11in at 96 DPI = 816px × 1056px. Gap is 0.15in = 14.4px.
      // A full page step in the horizontal column layout is exactly (816 + 14.4)px = 830.4px.
      const stepWidth = 8.5 * 96 + 0.15 * 96; 
      // Allowed width for `targetPages` is `targetPages * stepWidth` (minus one gap, but we over-estimate slightly to be safe)
      const targetWidth = Math.ceil(targetPages * stepWidth);
      const currentWidth = container.scrollWidth;

      if (currentWidth > targetWidth) {
        const next = squeezeOneStep(layoutParams);
        if (next) {
          setLayoutParams(next);
          setSqueezeIteration((i) => i + 1);
        } else {
          setIsSqueezing(false); // can't squeeze more
        }
      } else {
        setIsSqueezing(false); // fits!
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [isSqueezing, layoutParams, targetPages, squeezeIteration, squeezeOneStep]);

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

  const handlePrint = () => window.print();

  // Status text
  const statusText = isSqueezing
    ? `Squeezing… (${layoutParams.fontSizePt}pt, ${layoutParams.columns} cols)`
    : `✓ ${layoutParams.fontSizePt}pt, ${layoutParams.columns} cols, ${activeItems.length} items${droppedCount > 0 ? ` (${droppedCount} dropped)` : ""}`;

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

            {/* Save PDF */}
            <button
              onClick={handlePrint}
              disabled={isSqueezing}
              className="flex items-center gap-2 px-4 py-2 bg-white text-black font-medium rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Save as PDF
            </button>
          </div>
        </div>
      </div>

      {/* ── Typesetting Canvas ── */}
      <div className="flex flex-col items-center gap-8 mt-8 pb-12 print:m-0 print:gap-0 print:pb-0 print:block">
        
        {/*
          1. Off-screen measuring container (absolute, hidden).
          We use this purely to let the Squeeze Loop measure the scrollWidth.
        */}
        <div 
          ref={measureRef} 
          className="absolute opacity-0 pointer-events-none -z-50"
          style={{ left: "-9999px", top: 0, width: "8.5in" }} // match real container width
        >
          <SheetPage
            items={activeItems}
            params={layoutParams}
            courseName={material.course_name}
          />
        </div>

        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            @page {
              size: 8.5in 11in;
              margin: 0;
            }
            body {
              margin: 0;
              padding: 0;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          }
        `}} />

        {/* 
          2. SCREEN VIEW: Visible Pages (Windowed) 
          We render the exact same SheetPage N times.
          Each wrapper is strict 8.5x11 with overflow hidden.
          Inside, we shift the SheetPage left by (8.5in + 0.15in gap) per page.
        */}
        <div className="print:hidden flex flex-col items-center gap-8">
          {Array.from({ length: targetPages }).map((_, pageIndex) => (
            <div 
              key={pageIndex}
              className="w-[8.5in] h-[11in] bg-white overflow-hidden shadow-2xl relative"
            >
              <div 
                style={{
                  position: "absolute",
                  top: 0,
                  left: `calc(${pageIndex} * (-8.5in - 0.15in))`,
                  width: `${targetPages * 8.65}in`, // Just give it plenty of room to flow
                }}
              >
                <SheetPage
                  items={activeItems}
                  params={layoutParams}
                  courseName={material.course_name}
                />
              </div>
            </div>
          ))}

          {/* Screen-only Navigation Guide */}
          <div className="w-[8.5in] bg-white shadow-2xl">
            <MetaGuide
              courseName={material.course_name}
              directive={material.user_directive}
              droppedCount={droppedCount}
            />
          </div>
        </div>

        {/*
          3. PRINT VIEW: Single continuous sheet
          The browser's native print engine is much better at slicing a tall multi-column container
          than printing overlapping/shifted absolute positioned windows.
        */}
        <div className="hidden print:block w-[8.5in]">
          <SheetPage
            items={activeItems}
            params={layoutParams}
            courseName={material.course_name}
            unboundedHeight={true}
          />
          
          {/* Print-only Navigation Guide. Breaks to new page if not included in the main sheet flow. */}
          <div className={!includeGuide ? "break-before-page" : "mt-4"}>
            <MetaGuide
              courseName={material.course_name}
              directive={material.user_directive}
              droppedCount={droppedCount}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
