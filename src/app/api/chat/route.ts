import { z } from "zod";
import { defaultDeps, sendUserMessage } from "@/lib/agent";
import { streamAgent } from "@/lib/sse";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(10_000),
});

/** Send a user message; the reply streams back as Server-Sent Events. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { message, conversationId? }." }, { status: 400 });

  const { conversationId, message } = parsed.data;
  const conversation = conversationId ? store.get(conversationId) : store.create();
  if (!conversation) {
    return Response.json({ error: "Conversation not found (the server may have restarted). Start a new chat." }, { status: 404 });
  }
  return streamAgent(conversation, request.signal, (emit, signal) =>
    sendUserMessage(conversation, message, emit, defaultDeps(signal)),
  );
}
