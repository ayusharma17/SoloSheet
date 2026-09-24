import type { Config } from "@netlify/functions";
import { cleanupJobUploads, createWorkerClient } from "./_shared/extraction-runtime";

type ExpiredJob = { requestId: string; fileInputs: Array<{ path: string }> };

export default async function handler() {
  const supabase = createWorkerClient();
  const { data: expired, error: expiryError } = await supabase.rpc("expire_extraction_jobs", { p_limit: 50 });
  if (expiryError) throw new Error("Extraction recovery transaction failed");
  const expiredCount = typeof expired === "object" && expired !== null &&
    "jobs" in expired && Array.isArray(expired.jobs) ? expired.jobs.length : 0;
  const { data, error } = await supabase.rpc("get_pending_extraction_cleanup_jobs", { p_limit: 50 });
  if (error) throw new Error("Extraction cleanup query failed");
  const jobs = typeof data === "object" && data !== null && "jobs" in data && Array.isArray(data.jobs)
    ? data.jobs as ExpiredJob[] : [];
  for (const job of jobs) {
    if (typeof job.requestId !== "string" || !Array.isArray(job.fileInputs)) continue;
    try {
      await cleanupJobUploads(supabase, job.requestId, job.fileInputs);
    } catch {
      console.warn(`[Extraction Recovery] request=${job.requestId} cleanup=pending`);
    }
  }
  console.log(`[Extraction Recovery] expired=${expiredCount} cleanup_attempted=${jobs.length}`);
}

export const config: Config = { schedule: "*/5 * * * *" };
