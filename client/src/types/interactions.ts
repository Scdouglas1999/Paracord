import type { ApplicationCommandType, CommandOptionType } from './commands';
import type { Component } from './components';
import type { Message } from '../types';

export enum InteractionType {
  Ping = 1,
  ApplicationCommand = 2,
  MessageComponent = 3,
  ApplicationCommandAutocomplete = 4,
  ModalSubmit = 5,
}

export enum InteractionCallbackType {
  Pong = 1,
  ChannelMessageWithSource = 4,
  DeferredChannelMessageWithSource = 5,
  DeferredUpdateMessage = 6,
  UpdateMessage = 7,
  ApplicationCommandAutocompleteResult = 8,
  Modal = 9,
}

export interface ResolvedCommandOption {
  name: string;
  type: CommandOptionType;
  value?: unknown;
  options?: ResolvedCommandOption[];
  focused?: boolean;
}

export interface InteractionData {
  id?: string;
  name?: string;
  type?: ApplicationCommandType;
  options?: ResolvedCommandOption[];
  custom_id?: string;
  component_type?: number;
  values?: string[];
  target_id?: string;
  components?: Component[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: InteractionType;
  data?: InteractionData;
  guild_id?: string;
  channel_id?: string;
  member?: { user_id: string; nickname?: string };
  user?: { id: string; username: string };
  token: string;
  version: number;
  message?: Message;
}

export interface InteractionResponse {
  type: InteractionCallbackType;
  data?: InteractionCallbackData;
}

export interface InteractionCallbackData {
  content?: string;
  embeds?: unknown[];
  components?: Component[];
  flags?: number;
  choices?: { name: string; value: unknown }[];
  title?: string;
  custom_id?: string;
}
