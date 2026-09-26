import type { AgentEvent, Emit } from "./agent";
import { friendlyError } from "./agent";
import type { Conversation } from "./store";
import { store } from "./store";

/**
 * Run an agent action for one conversation and stream its events to the
 * browser as Server-Sent Events. Only one action per conversation runs at a
 * time.
 */
export function streamAgent(
  conversation: Conversation,
  signal: AbortSignal,
  action: (emit: Emit, signal: AbortSignal) => Promise<void>,
): Response {
  if (conversation.busy) {
    return Response.json({ error: "This conversation is still working on the previous message." }, { status: 409 });
  }
  conversation.busy = true;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false; // the browser went away
        }
      };
      emit({ type: "conversation", id: conversation.id });
      try {
        await action(emit, signal);
      } catch (err) {
        console.error("[agent]", err);
        emit({ type: "error", message: friendlyError(err) });
        emit({ type: "done" });
      } finally {
        conversation.busy = false;
        store.save(conversation);
        if (open) controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
