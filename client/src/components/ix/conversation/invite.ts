import { inviteApi } from '../../../api/invites';
import { writeClipboardText } from '../../../lib/clipboard';
import { reachNote, resolveShareAddress } from '../../guild/InviteModal';

/**
 * "Bring your people" (docs/index-spec.md §4.13): a link that never expires and
 * works for anyone, copied. An invite you already made that has no end (no age,
 * no use limit) is reused, so pressing the card in two servers' worth of sessions
 * does not pile up invites; the list needs Manage Server, so for anyone else (or
 * when it cannot be read) a new one is made. The link is the one InviteModal
 * builds (`resolveShareAddress`): the address people can actually reach.
 */

interface InviteLike {
  code: string;
  max_age: number | null;
  max_uses: number | null;
  inviter_id: string | null;
}

const neverEnds = (invite: InviteLike) => (invite.max_age ?? 0) === 0 && (invite.max_uses ?? 0) === 0;

/** The code of an endless invite of yours for this server, or null. Never throws. */
export async function findEndlessInvite(guildId: string, userId: string | null): Promise<string | null> {
  try {
    const { data } = await inviteApi.listGuild(guildId);
    const endless = data.filter(neverEnds);
    return (endless.find((invite) => userId !== null && invite.inviter_id === userId) ?? endless[0])?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Make (or find) the endless invite for the channel and copy its link. Resolves
 * with the link. Rejects with a sentence a person can read when there is no link
 * to hand out (the server can only be reached from this computer) or the
 * clipboard refuses.
 */
export async function copyEndlessInvite(input: { guildId: string; channelId: string; userId: string | null }): Promise<string> {
  const { guildId, channelId, userId } = input;
  const code =
    (await findEndlessInvite(guildId, userId)) ??
    (await inviteApi.create(channelId, { max_age: 0, max_uses: 0 })).data.code;
  const share = await resolveShareAddress();
  if (!share.url) throw new Error(reachNote(share.reach, share.asks_router));
  const link = `${share.url}/invite/${code}`;
  await writeClipboardText(link);
  return link;
}
