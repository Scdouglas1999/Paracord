import type { Channel } from '../types';

export const VIRTUAL_TEXT_ID = '__virtual_text__';
export const VIRTUAL_VOICE_ID = '__virtual_voice__';

export interface ChannelGroup {
  id: string;
  name: string;
  /** True when this group is auto-generated (no real category channel). */
  isReal: boolean;
  position: number;
  channels: Channel[];
}

/** Check whether a group ID is a virtual (auto-generated) sentinel. */
export function isVirtualGroup(id: string): boolean {
  return id === VIRTUAL_TEXT_ID || id === VIRTUAL_VOICE_ID;
}

/**
 * Build channel groups from a flat channel list.
 *
 * - If the guild has real category channels (type 4): group children by
 *   `parent_id`. Orphaned channels go into an "Uncategorized" group at the top.
 * - If no categories exist: auto-create "Text Channels" and "Voice Channels"
 *   virtual groups.
 */
export function buildChannelGroups(channels: Channel[]): ChannelGroup[] {
  const categories = channels.filter((ch) => ch.type === 4);

  if (categories.length === 0) {
    return buildVirtualGroups(channels);
  }

  return buildRealGroups(channels, categories);
}

function buildVirtualGroups(channels: Channel[]): ChannelGroup[] {
  const textChannels: Channel[] = [];
  const voiceChannels: Channel[] = [];

  for (const ch of channels) {
    if (ch.type === 4) continue;
    if (ch.type === 2 || ch.channel_type === 2) {
      voiceChannels.push(ch);
    } else {
      textChannels.push(ch);
    }
  }

  const sortByPos = (a: Channel, b: Channel) => a.position - b.position;
  textChannels.sort(sortByPos);
  voiceChannels.sort(sortByPos);

  const groups: ChannelGroup[] = [];

  if (textChannels.length > 0) {
    groups.push({
      id: VIRTUAL_TEXT_ID,
      name: 'Text Channels',
      isReal: false,
      position: 0,
      channels: textChannels,
    });
  }

  if (voiceChannels.length > 0) {
    groups.push({
      id: VIRTUAL_VOICE_ID,
      name: 'Voice Channels',
      isReal: false,
      position: 1,
      channels: voiceChannels,
    });
  }

  return groups;
}

function buildRealGroups(channels: Channel[], categories: Channel[]): ChannelGroup[] {
  const catMap = new Map<string, ChannelGroup>();

  const sortedCats = [...categories].sort((a, b) => a.position - b.position);
  for (const cat of sortedCats) {
    catMap.set(cat.id, {
      id: cat.id,
      name: cat.name ?? 'Unknown',
      isReal: true,
      position: cat.position,
      channels: [],
    });
  }

  const uncategorized: ChannelGroup = {
    id: '__uncategorized__',
    name: 'Uncategorized',
    isReal: false,
    position: -1,
    channels: [],
  };

  for (const ch of channels) {
    if (ch.type === 4) continue;
    if (ch.parent_id != null && catMap.has(ch.parent_id)) {
      catMap.get(ch.parent_id)!.channels.push(ch);
    } else {
      uncategorized.channels.push(ch);
    }
  }

  const sortByPos = (a: Channel, b: Channel) => a.position - b.position;

  const groups: ChannelGroup[] = [];

  if (uncategorized.channels.length > 0) {
    uncategorized.channels.sort(sortByPos);
    groups.push(uncategorized);
  }

  for (const cat of sortedCats) {
    const group = catMap.get(cat.id)!;
    group.channels.sort(sortByPos);
    groups.push(group);
  }

  return groups;
}
