"use client";

import Latex from "react-latex-next";

/**
 * Renders a string that may contain inline LaTeX ($...$) or display LaTeX ($$...$$).
 * Falls back to plain text if no LaTeX delimiters are found.
 */
export default function ContentRenderer({ text }: { text: string }) {
  if (!text) return null;

  // react-latex-next handles $...$ and $$...$$ delimiters natively
  return (
    <span className="content-renderer">
      <Latex>{text}</Latex>
    </span>
  );
}
