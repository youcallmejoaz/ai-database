import { z } from "zod";
import { decideWrite, defaultDeps } from "@/lib/agent";
import { streamAgent } from "@/lib/sse";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  /** The tool call being decided, so a stale button cannot approve a different change. */
  toolUseId: z.string().min(1),
  approve: z.boolean(),
  reason: z.string().max(1_000).optional(),
});

/** Approve or reject the pending write; the agent's follow-up streams back. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversation = store.get(id);
  if (!conversation) return Response.json({ error: "Conversation not found." }, { status: 404 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { toolUseId, approve, reason? }." }, { status: 400 });
  if (conversation.pending?.toolUseId !== parsed.data.toolUseId) {
    return Response.json({ error: "That change is no longer waiting for a decision." }, { status: 409 });
  }

  const { approve, reason } = parsed.data;
  return streamAgent(conversation, request.signal, (emit, signal) =>
    decideWrite(conversation, { approve, reason }, emit, defaultDeps(signal)),
  );
}
