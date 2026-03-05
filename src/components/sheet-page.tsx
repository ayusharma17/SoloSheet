"use client";

import ContentRenderer from "./content-renderer";

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
  unboundedHeight = false,
}: {
  items: ExtractionItem[];
  params: LayoutParams;
  courseName: string;
  unboundedHeight?: boolean;
}) {
  const fontSizePx = params.fontSizePt * (96 / 72); // pt → px conversion
  const lineHeight = 1.2;

  return (
    <div
      className="sheet-page bg-white text-black print:shadow-none relative"
      style={{
        width: "8.5in",
        height: unboundedHeight ? "auto" : "11in",
        minHeight: "11in",
        padding: "0.15in 0.2in",
        boxSizing: "border-box",
        columnCount: params.columns,
        columnGap: "0.15in",
        columnRule: "0.5px solid #e0e0e0",
        fontSize: `${fontSizePx}px`,
        lineHeight: lineHeight,
        fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        overflow: "visible", // Critical for horizontal pagination
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

      {items.map((item, idx) => {
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
            style={{
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
  );
}

/** Returns a small colored dot based on priority level */
function getPriorityColor(priority: number): string {
  if (priority >= 9) return "#ef4444"; // red — critical
  if (priority >= 7) return "#f97316"; // orange — high
  if (priority >= 5) return "#3b82f6"; // blue — medium
  return "#94a3b8"; // slate — low
}
