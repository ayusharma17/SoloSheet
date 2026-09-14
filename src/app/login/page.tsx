"use client";

import { createClient } from "@/lib/supabase/client";
import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Suspense } from "react";
import { BookOpen, Sparkles, Zap } from "lucide-react";

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const error = searchParams.get("error");
  const supabase = createClient();
  const testAuthEnabled = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_ENABLE_TEST_AUTH === "true";
  const [testEmail, setTestEmail] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [testError, setTestError] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  const handleGoogleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  const handleTestLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTestLoading(true);
    setTestError("");
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: testEmail.trim(),
      password: testPassword,
    });
    if (signInError) {
      setTestError("Test sign-in failed. Check the local test account.");
      setTestLoading(false);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white text-black p-4 selection:bg-black selection:text-white font-sans">
      <div className="swiss-card w-full max-w-md p-8 text-center bg-white animate-slide-up">
        {/* Logo / Branding */}
        <div className="mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-black mb-6">
            <BookOpen className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-black tracking-tighter uppercase mb-2">
            Solo<span className="text-[#e60000]">Sheet</span>
          </h1>
          <p className="text-neutral-600 font-medium text-sm max-w-[250px] mx-auto uppercase tracking-wider">
            Transform notes into exam-ready sheets
          </p>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-3 mb-10">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 border-2 border-black text-xs font-bold uppercase tracking-tight">
            <Sparkles className="w-3.5 h-3.5 text-[#e60000]" />
            AI-Powered
          </span>
          <span className="inline-flex items-center gap-2 px-3 py-1.5 border-2 border-black text-xs font-bold uppercase tracking-tight">
            <Zap className="w-3.5 h-3.5 text-black" />
            LaTeX Engine
          </span>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-6 p-4 border-2 border-[#e60000] bg-red-50 text-[#e60000] text-sm font-bold uppercase tracking-tight text-left">
            Error: Authentication failed. Please try again.
          </div>
        )}

        {/* Google Sign In Button */}
        <button
          onClick={handleGoogleLogin}
          className="w-full flex items-center justify-center gap-4 px-6 py-4 bg-black text-white font-bold text-sm uppercase tracking-widest hover:bg-[#e60000] border-2 border-transparent transition-colors cursor-pointer"
        >
          <svg className="w-5 h-5 bg-white rounded-full p-0.5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </button>

        {testAuthEnabled && (
          <form onSubmit={handleTestLogin} className="mt-8 border-t-2 border-neutral-200 pt-6 text-left">
            <p className="mb-4 text-xs font-bold uppercase tracking-widest text-neutral-500">Local test account</p>
            <label className="block text-xs font-bold uppercase tracking-widest mb-2" htmlFor="test-email">Email</label>
            <input id="test-email" type="email" required value={testEmail} onChange={(event) => setTestEmail(event.target.value)} className="w-full border-2 border-black px-3 py-2 mb-3" autoComplete="username" />
            <label className="block text-xs font-bold uppercase tracking-widest mb-2" htmlFor="test-password">Password</label>
            <input id="test-password" type="password" required value={testPassword} onChange={(event) => setTestPassword(event.target.value)} className="w-full border-2 border-black px-3 py-2 mb-3" autoComplete="current-password" />
            {testError && <p className="mb-3 text-xs font-bold text-[#e60000]">{testError}</p>}
            <button type="submit" disabled={testLoading} className="w-full border-2 border-black px-4 py-3 font-bold uppercase tracking-widest disabled:opacity-50">
              {testLoading ? "Signing in…" : "Sign in to local test account"}
            </button>
          </form>
        )}

        <p className="mt-8 text-xs text-neutral-500 font-bold uppercase tracking-widest">
          By signing in, you agree to our Terms
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin w-8 h-8 border-4 border-black border-t-transparent" />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
