import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import {
  getTopN,
  getRank,
  getNeighbors,
  type LeaderboardScope,
} from "@/lib/gamification/leaderboard";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const scope = (url.searchParams.get("scope") || "global") as LeaderboardScope;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const apiKeyId = url.searchParams.get("apiKeyId");

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json(
      { error: "'limit' must be an integer between 1 and 200" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const entries = await getTopN(scope, limit);
  let myRank: number | null = null;
  let neighbors = null;

  if (apiKeyId) {
    myRank = await getRank(apiKeyId, scope);
    neighbors = await getNeighbors(apiKeyId, scope);
  }

  return NextResponse.json({ entries, myRank, neighbors }, { headers: CORS_HEADERS });
}
