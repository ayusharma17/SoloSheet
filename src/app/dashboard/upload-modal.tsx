"use client";

import { useState, useCallback, useRef } from "react";
import {
  X,
  Upload,
  FileText,
  Trash2,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  credits: number;
}

interface UploadedFile {
  file: File;
  id: string;
}

const ALLOWED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MAX_DIRECTIVE_LENGTH = 500;

export default function UploadModal({
  isOpen,
  onClose,
  onSuccess,
  credits,
}: UploadModalProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [courseName, setCourseName] = useState("");
  const [targetPages, setTargetPages] = useState(1);
  const [directive, setDirective] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((newFiles: FileList | File[]) => {
    const validFiles: UploadedFile[] = [];
    for (const file of Array.from(newFiles)) {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (ALLOWED_EXTENSIONS.includes(ext)) {
        validFiles.push({ file, id: crypto.randomUUID() });
      }
    }
    setFiles((prev) => [...prev, ...validFiles]);
    setError("");
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const adjustTargetPages = (change: number) => {
    setTargetPages((prev) => Math.max(1, prev + change));
  };

  const handleSubmit = async () => {
    if (files.length === 0) {
      setError("Please upload at least one file.");
      return;
    }
    if (!courseName.trim()) {
      setError("Please enter a course name.");
      return;
    }

    setIsProcessing(true);
    setError("");
    setProcessingStatus("Uploading files...");

    try {
      const formData = new FormData();
      formData.append("courseName", courseName.trim());
      formData.append("targetPages", targetPages.toString());
      formData.append("userDirective", directive.trim());
      for (const { file } of files) {
        formData.append("files", file);
      }

      setProcessingStatus("Analyzing with Gemini AI...");

      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Extraction failed");
      }

      setProcessingStatus("Done!");
      setSuccess(true);

      // Wait a moment to show success, then close
      setTimeout(() => {
        onSuccess();
        resetState();
      }, 1500);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setIsProcessing(false);
      setProcessingStatus("");
    }
  };

  const resetState = () => {
    setFiles([]);
    setCourseName("");
    setTargetPages(1);
    setDirective("");
    setError("");
    setSuccess(false);
    setIsProcessing(false);
    setProcessingStatus("");
  };

  const handleClose = () => {
    if (!isProcessing) {
      resetState();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto glass-card p-0 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-400" />
              Create Cheat Sheet
            </h2>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Upload materials and let AI extract the essentials
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={isProcessing}
            className="p-2 rounded-lg hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-50 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex gap-4">
            {/* Course Name */}
            <div className="flex-1">
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                Course Name
              </label>
              <input
                type="text"
                value={courseName}
                onChange={(e) => setCourseName(e.target.value)}
                placeholder='e.g. "CS 577 — Algorithms"'
                disabled={isProcessing}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all disabled:opacity-50"
              />
            </div>

            {/* Target Pages */}
            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                Target Pages
              </label>
              <div className="flex items-center h-[50px] bg-white/5 border border-white/10 rounded-xl px-1">
                <button
                  type="button"
                  onClick={() => adjustTargetPages(-1)}
                  disabled={targetPages <= 1 || isProcessing}
                  className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-[var(--text-secondary)]"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <div className="w-16 text-center text-sm font-medium text-[var(--text-primary)]">
                  {targetPages} {targetPages === 1 ? 'page' : 'pages'}
                </div>
                <button
                  type="button"
                  onClick={() => adjustTargetPages(1)}
                  disabled={isProcessing}
                  className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors text-[var(--text-secondary)]"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Drop Zone */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
              Course Materials
            </label>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => !isProcessing && fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
                isDragging
                  ? "border-indigo-500 bg-indigo-500/5"
                  : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]"
              } ${isProcessing ? "opacity-50 pointer-events-none" : ""}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ALLOWED_EXTENSIONS.join(",")}
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
                className="hidden"
              />
              <Upload className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
              <p className="text-sm text-[var(--text-secondary)]">
                <span className="font-medium text-indigo-400">Click to upload</span> or
                drag and drop
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                PDF, PNG, JPEG, WebP, GIF — up to 200MB total
              </p>
            </div>
          </div>

          {/* File List */}
          {files.length > 0 && (
            <div className="space-y-2">
              {files.map(({ file, id }) => (
                <div
                  key={id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5"
                >
                  <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                  <span className="text-sm text-[var(--text-secondary)] truncate flex-1">
                    {file.name}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] flex-shrink-0">
                    {formatSize(file.size)}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-[var(--text-muted)] uppercase flex-shrink-0">
                    {file.name.split(".").pop()}
                  </span>
                  {!isProcessing && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(id);
                      }}
                      className="p-1 rounded hover:bg-white/10 text-[var(--text-muted)] hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* User Directive */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
              Focus Directive{" "}
              <span className="text-[var(--text-muted)] font-normal">(optional)</span>
            </label>
            <textarea
              value={directive}
              onChange={(e) =>
                setDirective(e.target.value.slice(0, MAX_DIRECTIVE_LENGTH))
              }
              placeholder='e.g. "Focus on Fourier Transforms and ignore the intro slides. Prioritize exam-style derivations."'
              rows={3}
              disabled={isProcessing}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all resize-none disabled:opacity-50"
            />
            <p className="text-xs text-[var(--text-muted)] text-right mt-1">
              {directive.length}/{MAX_DIRECTIVE_LENGTH}
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="flex items-center gap-2 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle className="w-5 h-5 text-emerald-400" />
              <p className="text-sm text-emerald-400">
                Extraction complete! Your cheat sheet data is ready.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-white/5">
          <p className="text-xs text-[var(--text-muted)]">
            This will use <span className="text-indigo-400 font-medium">1 credit</span>{" "}
            ({credits} remaining)
          </p>

          <button
            onClick={handleSubmit}
            disabled={isProcessing || files.length === 0 || !courseName.trim()}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-medium text-sm hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed cursor-pointer"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {processingStatus}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Extract & Generate
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
