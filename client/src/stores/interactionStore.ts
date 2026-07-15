import { create } from 'zustand';
import type { Component } from '../types/components';
import type { Interaction, InteractionResponse } from '../types/interactions';
import { InteractionCallbackType } from '../types/interactions';

export interface InteractionModalState {
  interactionId: string;
  /** Bot application that opened the modal (needed for ModalSubmit). */
  applicationId?: string;
  title: string;
  customId: string;
  components: Component[];
  channelId?: string;
  guildId?: string;
}

export interface AutocompleteChoice {
  name: string;
  value: string | number;
}

interface InteractionStoreState {
  /** Pending interactions waiting for bot response. */
  pendingInteractions: Map<string, Interaction>;
  /** Interactions in "thinking" state (deferred response). */
  thinkingInteractions: Set<string>;
  /** Modal opened for the invoking user via INTERACTION_CREATE (callback type 9). */
  activeModal: InteractionModalState | null;
  /** Latest APPLICATION_COMMAND_AUTOCOMPLETE_RESULT choices for the slash UI. */
  autocompleteChoices: AutocompleteChoice[];
  /** Interaction id that produced the current autocompleteChoices. */
  autocompleteInteractionId: string | null;
  /** Add an interaction to the pending set. */
  addPendingInteraction: (interaction: Interaction) => void;
  /** Remove an interaction from the pending set. */
  removePendingInteraction: (interactionId: string) => void;
  /** Handle a bot's response to an interaction (REST callback echo or gateway). */
  handleInteractionResponse: (interactionId: string, response: InteractionResponse) => void;
  /** Open a modal from an INTERACTION_CREATE gateway payload. */
  openModal: (modal: InteractionModalState) => void;
  /** Dismiss the active interaction modal. */
  clearModal: () => void;
  /** Clear autocomplete choices (e.g. when leaving option-entry mode). */
  clearAutocompleteChoices: () => void;
  /** True when any pending/thinking interaction targets this channel. */
  isChannelWaiting: (channelId: string) => boolean;
}

function normalizeAutocompleteChoices(
  raw: unknown[] | undefined,
): AutocompleteChoice[] {
  if (!raw?.length) return [];
  const out: AutocompleteChoice[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { name?: unknown; value?: unknown };
    if (typeof rec.name !== 'string') continue;
    if (typeof rec.value === 'string' || typeof rec.value === 'number') {
      out.push({ name: rec.name, value: rec.value });
    }
  }
  return out;
}

export const useInteractionStore = create<InteractionStoreState>()((set, get) => ({
  pendingInteractions: new Map(),
  thinkingInteractions: new Set(),
  activeModal: null,
  autocompleteChoices: [],
  autocompleteInteractionId: null,

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
        const nextThinking = new Set(get().thinkingInteractions);
        nextThinking.add(interactionId);
        set({ thinkingInteractions: nextThinking });
        break;
      }
      case InteractionCallbackType.ApplicationCommandAutocompleteResult: {
        set({
          autocompleteChoices: normalizeAutocompleteChoices(response.data?.choices as unknown[] | undefined),
          autocompleteInteractionId: interactionId,
        });
        // Autocomplete interactions are short-lived; drop pending once choices arrive.
        const next = new Map(get().pendingInteractions);
        next.delete(interactionId);
        set({ pendingInteractions: next });
        break;
      }
      case InteractionCallbackType.Modal: {
        const data = response.data;
        if (data?.title && data.custom_id) {
          const pending = get().pendingInteractions.get(interactionId);
          set({
            activeModal: {
              interactionId,
              applicationId: pending?.application_id,
              title: data.title,
              customId: data.custom_id,
              components: data.components ?? [],
              channelId: pending?.channel_id,
              guildId: pending?.guild_id,
            },
          });
        }
        const next = new Map(get().pendingInteractions);
        next.delete(interactionId);
        const nextThinking = new Set(get().thinkingInteractions);
        nextThinking.delete(interactionId);
        set({ pendingInteractions: next, thinkingInteractions: nextThinking });
        break;
      }
      case InteractionCallbackType.ChannelMessageWithSource:
      case InteractionCallbackType.UpdateMessage:
      default: {
        const next = new Map(get().pendingInteractions);
        next.delete(interactionId);
        const nextThinking = new Set(get().thinkingInteractions);
        nextThinking.delete(interactionId);
        set({ pendingInteractions: next, thinkingInteractions: nextThinking });
        break;
      }
    }
  },

  openModal: (modal) => set({ activeModal: modal }),

  clearModal: () => set({ activeModal: null }),

  clearAutocompleteChoices: () =>
    set({ autocompleteChoices: [], autocompleteInteractionId: null }),

  isChannelWaiting: (channelId: string) => {
    for (const interaction of get().pendingInteractions.values()) {
      if (interaction.channel_id === channelId) return true;
    }
    return false;
  },
}));
