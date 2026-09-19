import { NextResponse } from "next/server";
import { getTaskManager } from "@/lib/a2a/taskManager";
import { authorizeA2ATaskRoute } from "@/app/api/a2a/_auth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // GHSA-jcm5-6wpp-wjj8: this route had no auth call at all — open regardless
  // of configuration. Another principal's task answers 404, same as a missing
  // one, so an IDOR probe cannot tell the two apart.
  const auth = await authorizeA2ATaskRoute(request);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await params;
    const tm = getTaskManager();
    const task = tm.getTask(id, auth.owner);
    if (!task) {
      return NextResponse.json({ error: `Task not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json(
      {
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : "Failed to load A2A task"
        ),
      },
      { status: 500 }
    );
  }
}
