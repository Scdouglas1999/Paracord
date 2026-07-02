import { create } from 'zustand';
import type { Interaction, InteractionResponse } from '../types/interactions';
import { InteractionCallbackType } from '../types/interactions';

interface InteractionStoreState {
  /** Pending interactions waiting for bot response. */
  pendingInteractions: Map<string, Interaction>;
  /** Interactions in "thinking" state (deferred response). */
  thinkingInteractions: Set<string>;
  /** Add an interaction to the pending set. */
  addPendingInteraction: (interaction: Interaction) => void;
  /** Remove an interaction from the pending set. */
  removePendingInteraction: (interactionId: string) => void;
  /** Handle a bot's response to an interaction. */
  handleInteractionResponse: (interactionId: string, response: InteractionResponse) => void;
}

export const useInteractionStore = create<InteractionStoreState>()((set, get) => ({
  pendingInteractions: new Map(),
  thinkingInteractions: new Set(),

  addPendingInteraction: (interaction: Interaction) => {
    const next = new Map(get().pendingInteractions);
    next.set(interaction.id, interaction);
    set({ pendingInteractions: next });
  },

  removePendingInteraction: (interactionId: string) => {
    const next = new Map(get().pendingInteractions);
    next.delete(interactionId);
    const nextThinking = new Set(get().thinkingInteractions);
    nextThinking.delete(interactionId);
    set({ pendingInteractions: next, thinkingInteractions: nextThinking });
  },

  handleInteractionResponse: (interactionId: string, response: InteractionResponse) => {
    switch (response.type) {
      case InteractionCallbackType.DeferredChannelMessageWithSource:
      case InteractionCallbackType.DeferredUpdateMessage: {
        // Mark as "thinking" — the bot will follow up with an edit
        const nextThinking = new Set(get().thinkingInteractions);
        nextThinking.add(interactionId);
        set({ thinkingInteractions: nextThinking });
        break;
      }
      case InteractionCallbackType.Modal: {
        // Modal display is handled by the gateway event dispatch.
        // Remove from pending since the bot responded.
        const next = new Map(get().pendingInteractions);
        next.delete(interactionId);
        set({ pendingInteractions: next });
        break;
      }
      case InteractionCallbackType.ChannelMessageWithSource:
      case InteractionCallbackType.UpdateMessage:
      default: {
        // Message creation/update is handled server-side via MESSAGE_CREATE/MESSAGE_UPDATE.
        // Clean up both pending and thinking state.
        const next = new Map(get().pendingInteractions);
        next.delete(interactionId);
        const nextThinking = new Set(get().thinkingInteractions);
        nextThinking.delete(interactionId);
        set({ pendingInteractions: next, thinkingInteractions: nextThinking });
        break;
      }
    }
  },
}));
