"use client";

/**
 * MetaGuide — The "Navigation Guide" from the PRD.
 * A clean, single-page index/legend that helps the student locate info under time pressure.
 */
export default function MetaGuide({
  courseName,
  directive,
  droppedCount,
}: {
  courseName: string;
  directive: string | null;
  droppedCount: number;
}) {
  return (
    <div
      className="meta-guide bg-white text-black print:shadow-none"
      style={{
        width: "8.5in",
        minHeight: "11in",
        padding: "0.5in 0.6in",
        boxSizing: "border-box",
        fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        fontSize: "10px",
        lineHeight: 1.5,
      }}
    >
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "24px" }}>
        <h2
          style={{
            fontSize: "16px",
            fontWeight: 700,
            color: "#1a1a1a",
            margin: 0,
          }}
        >
          📍 Navigation Guide
        </h2>
        <p style={{ fontSize: "11px", color: "#666", margin: "4px 0 0" }}>
          {courseName}
        </p>
      </div>

      {/* Quick-Access Tips (from user directive) */}
      {directive && directive.trim().length > 0 && (
        <section style={{ marginBottom: "20px" }}>
          <h3 style={sectionHeadingStyle}>🎯 Your Focus Areas</h3>
          <div style={cardStyle}>
            <p style={{ margin: 0, color: "#333" }}>{directive}</p>
          </div>
        </section>
      )}

      {/* Legend — Shorthand Symbols */}
      <section style={{ marginBottom: "20px" }}>
        <h3 style={sectionHeadingStyle}>🔑 Shorthand Legend</h3>
        <div
          style={{
            ...cardStyle,
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "6px 16px",
          }}
        >
          {shorthandLegend.map(([symbol, meaning]) => (
            <div key={symbol} style={{ display: "flex", gap: "6px" }}>
              <span style={{ fontWeight: 700, color: "#4f46e5", minWidth: "24px" }}>{symbol}</span>
              <span style={{ color: "#555" }}>{meaning}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Priority Legend */}
      <section style={{ marginBottom: "20px" }}>
        <h3 style={sectionHeadingStyle}>🔴 Priority Indicators</h3>
        <div style={{ ...cardStyle, display: "flex", gap: "20px", flexWrap: "wrap" }}>
          {[
            { color: "#ef4444", label: "Critical (9-10)" },
            { color: "#f97316", label: "High (7-8)" },
            { color: "#3b82f6", label: "Medium (5-6)" },
            { color: "#94a3b8", label: "Low (1-4)" },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: color,
                }}
              />
              <span style={{ color: "#555" }}>{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Stats */}
      <section style={{ marginBottom: "20px" }}>
        <h3 style={sectionHeadingStyle}>📊 Sheet Statistics</h3>
        <div style={cardStyle}>
          {droppedCount > 0 && (
            <p style={{ margin: "0 0 4px", color: "#b45309" }}>
              ⚠ {droppedCount} lower-priority item{droppedCount !== 1 ? "s" : ""} dropped to fit the page limit.
            </p>
          )}
          <p style={{ margin: 0, color: "#555" }}>
            Items with colored dots indicate their exam importance level.
            Red = must-know, Orange = very likely, Blue = could appear, Gray = supplementary.
          </p>
        </div>
      </section>

      {/* How to Use */}
      <section>
        <h3 style={sectionHeadingStyle}>💡 How to Use This Sheet</h3>
        <div style={cardStyle}>
          <ol style={{ margin: 0, paddingLeft: "18px", color: "#555" }}>
            <li>Scan the <strong>red-dot</strong> items first — these are your highest priority.</li>
            <li>Use the shorthand symbols listed above to decode compressed notation.</li>
            <li>Topics flow <strong>top-to-bottom, left-to-right</strong> across columns.</li>
            <li>If allowed, print double-sided to maximize content.</li>
          </ol>
        </div>
      </section>
    </div>
  );
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: "#1a1a1a",
  marginBottom: "6px",
  borderBottom: "1px solid #e5e7eb",
  paddingBottom: "3px",
};

const cardStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: "6px",
  padding: "10px 14px",
};

const shorthandLegend: [string, string][] = [
  ["∴", "therefore"],
  ["∵", "because"],
  ["→", "implies / maps to"],
  ["↔", "if and only if"],
  ["≈", "approximately"],
  ["∝", "proportional to"],
  ["∀", "for all"],
  ["∃", "there exists"],
  ["∈", "element of"],
  ["⊂", "subset of"],
  ["∪", "union"],
  ["∩", "intersection"],
  ["Δ", "change in"],
  ["∞", "infinity"],
  ["≡", "equivalent / defined as"],
];
