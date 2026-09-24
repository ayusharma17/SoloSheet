import { createClient } from "@/lib/supabase/server";
import { parseExtractionStatus } from "@/lib/extraction-jobs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return NextResponse.json({ error: "Invalid request ID" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("get_extraction_status", { p_request_id: requestId });
  if (error) return NextResponse.json({ error: "Generation status is unavailable." }, { status: 503 });
  try {
    const status = parseExtractionStatus(data);
    if (status.status === "missing") return NextResponse.json({ error: "Generation not found" }, { status: 404 });
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "Generation status is unavailable." }, { status: 503 });
  }
}
