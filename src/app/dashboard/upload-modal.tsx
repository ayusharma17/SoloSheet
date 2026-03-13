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
import { createClient } from "@/lib/supabase/client";
import {
  uploadCourseFile,
  validateFileForUpload,
  generateUploadSessionId,
} from "@/lib/supabase/storage-helpers";

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  credits: number;
}

interface UploadedFile {
  file: File;
  id: string;
  uploadProgress: number;
  uploadStatus: "pending" | "uploading" | "uploaded" | "failed";
  storageUrl?: string;
  storagePath?: string;
  error?: string;
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

  const handleFiles = useCallback(async (newFiles: FileList | File[]) => {
    const validFiles: UploadedFile[] = [];
    let validationError = "";

    for (const file of Array.from(newFiles)) {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        validationError = `File "${file.name}" has unsupported extension. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`;
        continue;
      }

      // Validate file before adding
      try {
        validateFileForUpload(file);
        validFiles.push({
          file,
          id: crypto.randomUUID(),
          uploadProgress: 0,
          uploadStatus: "pending",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Validation failed";
        validationError = message;
        break;
      }
    }

    if (validationError) {
      setError(validationError);
    } else {
      setFiles((prev) => [...prev, ...validFiles]);
      setError("");
    }
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

    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("You must be logged in to upload files.");
      }

      const sessionId = generateUploadSessionId();

      // Step 1: Upload files to Supabase Storage
      setProcessingStatus("Uploading files to storage...");
      const uploadedFiles: Array<{
        url: string;
        path: string;
        name: string;
        type: string;
        size: number;
      }> = [];

      for (let i = 0; i < files.length; i++) {
        const fileEntry = files[i];

        // Skip if already uploaded
        if (fileEntry.uploadStatus === "uploaded" && fileEntry.storageUrl) {
          uploadedFiles.push({
            url: fileEntry.storageUrl,
            path: fileEntry.storagePath!,
            name: fileEntry.file.name,
            type: fileEntry.file.type,
            size: fileEntry.file.size,
          });
          continue;
        }

        // Update status to uploading
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileEntry.id
              ? { ...f, uploadStatus: "uploading" as const }
              : f
          )
        );

        try {
          setProcessingStatus(`Uploading ${fileEntry.file.name}...`);

          const { url, path } = await uploadCourseFile(
            supabase,
            user.id,
            sessionId,
            fileEntry.file
          );

          // Update file status to uploaded
          setFiles((prev) =>
            prev.map((f) =>
              f.id === fileEntry.id
                ? {
                    ...f,
                    uploadStatus: "uploaded" as const,
                    uploadProgress: 100,
                    storageUrl: url,
                    storagePath: path,
                  }
                : f
            )
          );

          uploadedFiles.push({
            url,
            path,
            name: fileEntry.file.name,
            type: fileEntry.file.type,
            size: fileEntry.file.size,
          });
        } catch (uploadErr: unknown) {
          const uploadMessage =
            uploadErr instanceof Error
              ? uploadErr.message
              : "Upload failed";

          // Mark file as failed
          setFiles((prev) =>
            prev.map((f) =>
              f.id === fileEntry.id
                ? {
                    ...f,
                    uploadStatus: "failed" as const,
                    error: uploadMessage,
                  }
                : f
            )
          );

          throw new Error(`Failed to upload ${fileEntry.file.name}: ${uploadMessage}`);
        }
      }

      // Step 2: Send extraction request with file URLs
      setProcessingStatus("Analyzing with Gemini AI...");

      const payload = {
        courseName: courseName.trim(),
        targetPages,
        userDirective: directive.trim(),
        fileUrls: uploadedFiles,
      };

      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      const message =
        err instanceof Error ? err.message : "Something went wrong";
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
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white border-[3px] border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] p-0 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b-[3px] border-black bg-black text-white">
          <div>
            <h2 className="text-xl font-bold uppercase flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[#e60000]" />
              Create Cheat Sheet
            </h2>
            <p className="text-sm text-neutral-400 mt-1 font-medium">
              Upload materials and let AI extract the essentials
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={isProcessing}
            className="p-2 border-2 border-transparent hover:border-white transition-colors disabled:opacity-50 cursor-pointer text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex gap-4">
            {/* Course Name */}
            <div className="flex-1">
              <label className="block text-sm font-bold uppercase text-black mb-2">
                Course Name
              </label>
              <input
                type="text"
                value={courseName}
                onChange={(e) => setCourseName(e.target.value)}
                placeholder='e.g. "CS 577 — Algorithms"'
                disabled={isProcessing}
                className="w-full px-4 py-3 bg-white border-2 border-black text-black placeholder:text-neutral-400 focus:outline-none focus:ring-0 focus:border-[#e60000] disabled:opacity-50 font-medium rounded-none"
              />
            </div>

            {/* Target Pages */}
            <div>
              <label className="block text-sm font-bold uppercase text-black mb-2 flex items-center h-[20px]">
                Target Pages
              </label>
              <div className="flex items-center h-[52px] bg-white border-2 border-black max-w-[140px]">
                <button
                  type="button"
                  onClick={() => adjustTargetPages(-1)}
                  disabled={targetPages <= 1 || isProcessing}
                  className="w-12 h-full flex items-center justify-center hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-white transition-colors text-black border-r-2 border-black"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <div className="w-14 text-center text-sm font-bold text-black flex items-center justify-center">
                  {targetPages} {targetPages === 1 ? 'PG' : 'PGS'}
                </div>
                <button
                  type="button"
                  onClick={() => adjustTargetPages(1)}
                  disabled={isProcessing}
                  className="w-12 h-full flex items-center justify-center hover:bg-neutral-100 transition-colors text-black border-l-2 border-black"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Drop Zone */}
          <div>
            <label className="block text-sm font-bold uppercase text-black mb-2">
              Course Materials
            </label>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => !isProcessing && fileInputRef.current?.click()}
              className={`relative border-[3px] border-dashed p-8 text-center transition-all cursor-pointer ${
                isDragging
                  ? "border-[#e60000] bg-red-50"
                  : "border-black hover:bg-neutral-50"
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
              <Upload className="w-10 h-10 text-black mx-auto mb-3" />
              <p className="text-sm font-bold uppercase text-black">
                <span className="text-[#e60000] underline">Click to upload</span> or
                drag and drop
              </p>
              <p className="text-xs font-medium text-neutral-500 mt-2 uppercase">
                PDF, PNG, JPEG, WebP, GIF — max 200MB
              </p>
            </div>
          </div>

          {/* File List */}
          {files.length > 0 && (
            <div className="space-y-2">
              {files.map((fileEntry) => (
                <div
                  key={fileEntry.id}
                  className="flex items-center gap-3 px-4 py-3 bg-white border-2 border-black"
                >
                  <FileText className="w-5 h-5 text-black flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-black truncate">
                        {fileEntry.file.name}
                      </span>
                      {fileEntry.uploadStatus === "uploading" && (
                        <Loader2 className="w-3 h-3 text-[#e60000] animate-spin flex-shrink-0" />
                      )}
                      {fileEntry.uploadStatus === "uploaded" && (
                        <CheckCircle className="w-3 h-3 text-green-600 flex-shrink-0" />
                      )}
                      {fileEntry.uploadStatus === "failed" && (
                        <AlertCircle className="w-3 h-3 text-[#e60000] flex-shrink-0" />
                      )}
                    </div>
                    {fileEntry.error && (
                      <p className="text-[10px] font-bold text-[#e60000] mt-1">
                        {fileEntry.error}
                      </p>
                    )}
                  </div>
                  <span className="text-xs font-bold text-neutral-500 flex-shrink-0">
                    {formatSize(fileEntry.file.size)}
                  </span>
                  <span className="text-[10px] font-bold px-2 py-0.5 border border-black text-black uppercase flex-shrink-0">
                    {fileEntry.file.name.split(".").pop()}
                  </span>
                  {!isProcessing && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(fileEntry.id);
                      }}
                      className="p-1 border-2 border-transparent hover:border-black text-black hover:text-[#e60000] transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* User Directive */}
          <div className="mt-6">
            <label className="block text-sm font-bold uppercase text-black mb-2">
              Focus Directive{" "}
              <span className="text-neutral-500 font-medium normal-case">(optional)</span>
            </label>
            <textarea
              value={directive}
              onChange={(e) =>
                setDirective(e.target.value.slice(0, MAX_DIRECTIVE_LENGTH))
              }
              placeholder='e.g. "Focus on Fourier Transforms and ignore the intro slides. Prioritize exam-style derivations."'
              rows={3}
              disabled={isProcessing}
              className="w-full px-4 py-3 bg-white border-2 border-black text-black placeholder:text-neutral-400 focus:outline-none focus:ring-0 focus:border-[#e60000] transition-all resize-none disabled:opacity-50 font-medium rounded-none font-mono text-sm"
            />
            <p className="text-xs font-bold text-neutral-500 text-right mt-2 uppercase">
              {directive.length} / {MAX_DIRECTIVE_LENGTH} CHARS
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border-[3px] border-[#e60000]">
              <AlertCircle className="w-5 h-5 text-[#e60000] mt-0.5 flex-shrink-0" />
              <p className="text-sm font-bold text-[#e60000] uppercase mt-0.5">{error}</p>
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="flex items-start gap-3 p-4 bg-green-50 border-[3px] border-green-600">
              <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm font-bold text-green-600 uppercase mt-0.5">
                Extraction complete! Data is ready.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t-[3px] border-black bg-neutral-50">
          <p className="text-xs font-bold uppercase text-black">
            Cost: <span className="text-[#e60000]">1 credit</span>{" "}
            <span className="text-neutral-500">({credits} left)</span>
          </p>

          <button
            onClick={handleSubmit}
            disabled={isProcessing || files.length === 0 || !courseName.trim()}
            className="flex items-center gap-2 px-8 py-3 bg-black text-white font-bold text-sm uppercase tracking-widest hover:bg-[#e60000] transition-colors disabled:opacity-50 disabled:hover:bg-black cursor-pointer shadow-[4px_4px_0px_0px_rgba(230,0,0,1)] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px]"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {processingStatus}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
