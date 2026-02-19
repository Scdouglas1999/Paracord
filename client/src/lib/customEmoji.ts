import { resolveApiBaseUrl } from './apiBaseUrl';

const CUSTOM_EMOJI_TOKEN_PATTERN = /^<(a?):([A-Za-z0-9_]{1,32}):([0-9]+)>$/;

export interface ParsedCustomEmojiToken {
  raw: string;
  name: string;
  id: string;
  animated: boolean;
}

function normalizedApiBase(): string {
  return resolveApiBaseUrl().replace(/\/+$/, '');
}

export function parseCustomEmojiToken(value: string): ParsedCustomEmojiToken | null {
  const match = CUSTOM_EMOJI_TOKEN_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    raw: match[0],
    animated: match[1] === 'a',
    name: match[2],
    id: match[3],
  };
}

export function formatCustomEmojiToken(name: string, emojiId: string, animated = false): string {
  const safeName = (name.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'emoji').slice(0, 32);
  const safeId = emojiId.trim();
  if (!/^[0-9]+$/.test(safeId)) {
    return `:${safeName}:`;
  }
  return `<${animated ? 'a' : ''}:${safeName}:${safeId}>`;
}

export function buildGuildEmojiImageUrl(guildId: string, emojiId: string): string {
  return `${normalizedApiBase()}/guilds/${encodeURIComponent(guildId)}/emojis/${encodeURIComponent(emojiId)}/image`;
}
