import { NextResponse } from "next/server";
import { getApiCtx } from "@/lib/data";
import { search } from "@/lib/search";

export const dynamic = "force-dynamic";

/** `GET /api/search?q=` — lo que alimenta la paleta (⌘K). Sólo lee, sólo lo tuyo. */
export async function GET(request: Request) {
  const ctx = await getApiCtx();
  if (!ctx) return NextResponse.json({ ok: false, message: "Tu sesión venció." }, { status: 401 });
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 80);
  const results = await search(ctx, q);
  return NextResponse.json({ ok: true, ...results }, { headers: { "cache-control": "no-store" } });
}
