import { getApi } from './activeClient';
import { responseContract } from './responseContracts';
import { isGuildEmoji, isGuildEmojiList } from './generated/validators';
import { buildGuildEmojiImageUrl } from '../lib/customEmoji';

const MAX_EMOJI_UPLOAD_BYTES = 256 * 1024;
const VALID_EMOJI_NAME = /^[A-Za-z0-9_]{1,32}$/;
const ALLOWED_EMOJI_TYPES = new Set(['image/png', 'image/gif']);

interface CreateEmojiRequest {
  name: string;
  file: File;
}

function assertValidEmojiName(name: string): string {
  const trimmed = name.trim();
  if (!VALID_EMOJI_NAME.test(trimmed)) {
    throw new Error('Emoji name must be 1-32 characters using letters, numbers, or underscore.');
  }
  return trimmed;
}

function assertValidEmojiFile(file: File): void {
  if (!ALLOWED_EMOJI_TYPES.has(file.type)) {
    throw new Error('Only PNG and GIF emoji uploads are supported.');
  }
  if (file.size <= 0 || file.size > MAX_EMOJI_UPLOAD_BYTES) {
    throw new Error('Emoji uploads must be between 1 byte and 256 KB.');
  }
}

export const emojiApi = {
  listGuild: async (guildId: string) =>
    responseContract(
      getApi().get(`/guilds/${guildId}/emojis`),
      isGuildEmojiList,
      'GuildEmojiList',
    ),

  create: async (guildId: string, data: CreateEmojiRequest) => {
    const name = assertValidEmojiName(data.name);
    assertValidEmojiFile(data.file);
    const formData = new FormData();
    formData.append('name', name);
    formData.append('image', data.file);
    return responseContract(
      // The shared client declares `application/json`, and axios turns a
      // FormData body into `JSON.stringify(formDataToJSON(data))` when that is
      // the declared type — so the image arrived as the JSON object `{}` and
      // the server answered 400 "Missing emoji image". Declaring multipart
      // makes axios hand the body to the transport intact.
      getApi().post(`/guilds/${guildId}/emojis`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
      isGuildEmoji,
      'GuildEmoji',
    );
  },

  update: async (guildId: string, emojiId: string, name: string) =>
    responseContract(
      getApi().patch(`/guilds/${guildId}/emojis/${emojiId}`, {
        name: assertValidEmojiName(name),
      }),
      isGuildEmoji,
      'GuildEmoji',
    ),

  delete: async (guildId: string, emojiId: string) =>
    getApi().delete(`/guilds/${guildId}/emojis/${emojiId}`),

  imageUrl: (guildId: string, emojiId: string) =>
    buildGuildEmojiImageUrl(guildId, emojiId),
};
