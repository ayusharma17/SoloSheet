import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SoloSheet — Exam-Ready Cheat Sheets in Seconds",
  description:
    "Upload your lecture notes and let AI compress them into high-density, print-ready cheat sheets with perfect LaTeX math. Built for students.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased bg-white text-black selection:bg-black selection:text-white`}
      >
        {children}
      </body>
    </html>
  );
}
