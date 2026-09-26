import type { BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { randomUUID } from "node:crypto";
import type { WritePreview } from "./tools";

/** A write waiting for the user, plus the other results from the same model turn. */
export interface PendingWrite {
  toolUseId: string;
  preview: WritePreview;
  /** Tool ids of the model turn, in order, so results go back in the same order. */
  toolUseOrder: string[];
  /** Results already computed for the other tool calls in that turn. */
  otherResults: BetaToolResultBlockParam[];
}

export interface Conversation {
  id: string;
  /** Append-only history in the Messages API shape. */
  messages: BetaMessageParam[];
  pending?: PendingWrite;
  /** True while a model turn is streaming, to refuse overlapping requests. */
  busy: boolean;
  updatedAt: number;
}

/** Storage interface, so the in-memory map can be swapped for Redis or a table later. */
export interface ConversationStore {
  create(): Conversation;
  get(id: string): Conversation | undefined;
  save(conversation: Conversation): void;
}

const MAX_CONVERSATIONS = 500;

class MemoryStore implements ConversationStore {
  private readonly map = new Map<string, Conversation>();

  create(): Conversation {
    const conversation: Conversation = { id: randomUUID(), messages: [], busy: false, updatedAt: Date.now() };
    this.save(conversation);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    return this.map.get(id);
  }

  save(conversation: Conversation): void {
    conversation.updatedAt = Date.now();
    this.map.delete(conversation.id);
    this.map.set(conversation.id, conversation);
    // Map keeps insertion order, so the first key is the least recently saved.
    while (this.map.size > MAX_CONVERSATIONS) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

// On globalThis so Next.js dev reloads keep conversations.
export const store: ConversationStore = ((globalThis as { __aiDbStore?: ConversationStore }).__aiDbStore ??=
  new MemoryStore());
