"use client";

import ContentRenderer from "@/components/content-renderer";
import type { ReactNode } from "react";

type ExtractionItem = {
  priority: number;
  topic?: string;
  category?: string;
  content: string;
  shorthand: string;
};

type LayoutParams = {
  fontSizePt: number;
  columns: number;
  useShorthandForLowPriority: boolean;
  cutoffPriority: number;
};

/**
 * SheetPage renders the physical 8.5x11 cheat sheet page(s).
 * Uses CSS multi-column layout for maximum density.
 * All styles are inline so they survive the print pipeline.
 */
export default function SheetPage({
  items,
  params,
  courseName,
  columnItems,
  guide,
}: {
  items: ExtractionItem[];
  params: LayoutParams;
  courseName: string;
  columnItems?: number[][];
  guide?: ReactNode;
}) {
  const fontSizePx = params.fontSizePt * (96 / 72); // pt → px conversion
  const lineHeight = 1.2;

  return (
    <div
      className="sheet-page bg-white text-black print:shadow-none relative"
      style={{
        width: "8.5in",
        height: "11in",
        minHeight: "11in",
        padding: "0.15in 0.2in",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        fontSize: `${fontSizePx}px`,
        lineHeight: lineHeight,
        fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Tiny header at the top of the sheet */}
      <div
        style={{
          columnSpan: "all" as const,
          textAlign: "center",
          fontSize: `${Math.max(fontSizePx * 0.9, 7)}px`,
          color: "#666",
          marginBottom: "0.15in",
          fontWeight: 600,
          borderBottom: "1px solid #eee",
          paddingBottom: "4px",
          breakInside: "avoid",
          breakAfter: "avoid",
        }}
      >
        {courseName.toUpperCase()} — CHEAT SHEET
      </div>

      <div className="sheet-columns" style={{ display: "grid", gridTemplateColumns: `repeat(${params.columns}, minmax(0, 1fr))`, gap: "0.15in", flex: 1, minHeight: 0 }}>
      {(columnItems ?? [items.map((_, index) => index).concat(guide ? [items.length] : [])]).map((indices, columnIndex) => (
        <div className="sheet-column" key={columnIndex} style={{ minWidth: 0 }}>
      {indices.map((idx) => {
        if (idx === items.length) return <div className="sheet-item" data-item-index={idx} key="guide">{guide}</div>;
        const item = items[idx];
        // Use shorthand for lower-priority items when the flag is set
        const useShorthand =
          params.useShorthandForLowPriority &&
          item.priority < 8 &&
          item.shorthand &&
          item.shorthand.trim().length > 0;

        const displayContent = useShorthand ? item.shorthand : item.content;

        return (
          <div
            key={idx}
            className="sheet-item"
            data-item-index={idx}
            style={{
              overflowWrap: "anywhere",
              breakInside: "avoid" as const,
              pageBreakInside: "avoid" as const,
              marginBottom: "3px",
              padding: "2px 0",
              borderBottom: "0.3px solid #eee",
            }}
          >
            {/* Topic header */}
            <div
              style={{
                fontWeight: 700,
                fontSize: `${fontSizePx}px`,
                color: "#1a1a1a",
                display: "flex",
                alignItems: "baseline",
                gap: "4px",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: `${Math.max(fontSizePx * 0.6, 5)}px`,
                  height: `${Math.max(fontSizePx * 0.6, 5)}px`,
                  borderRadius: "50%",
                  backgroundColor: getPriorityColor(item.priority),
                  flexShrink: 0,
                  marginTop: "2px",
                }}
              />
              <span>{item.topic || item.category || item.content.slice(0, 40)}</span>
            </div>

            {/* Content */}
            <div
              style={{
                fontSize: `${fontSizePx * 0.95}px`,
                color: "#333",
                paddingLeft: `${Math.max(fontSizePx * 0.6, 5) + 4}px`,
              }}
            >
              <ContentRenderer text={displayContent} />
            </div>
          </div>
        );
      })}
        </div>
      ))}
      </div>
    </div>
  );
}

/** Returns a small colored dot based on priority level */
function getPriorityColor(priority: number): string {
  if (priority >= 9) return "#ef4444"; // red — critical
  if (priority >= 7) return "#f97316"; // orange — high
  if (priority >= 5) return "#3b82f6"; // blue — medium
  return "#94a3b8"; // slate — low
}
