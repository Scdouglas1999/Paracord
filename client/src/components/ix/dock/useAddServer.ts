import { useCallback, useEffect, useState } from 'react';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useServerReady } from '../../../hooks/useServerReady';
import { guildLandingPath } from '../../../lib/guildNavigation';
import type { ScopedGuild } from '../../../lib/guildScope';
import { isAllowedImageMimeType } from '../../../lib/security';
import { parseInviteLink } from '../../../lib/inviteLinks';
import { getServerAccountScope } from '../../../lib/serverIdentity';
import { LOCAL_SERVER_ID, type AccountScope } from '../../../lib/serverScope';
import { useGuildStore } from '../../../stores/guildStore';
import { normalizeServerUrl, resolveDefaultServerTarget, useServerListStore } from '../../../stores/serverListStore';

/**
 * What the Add a server sheet does: make a server, join one with an invite,
 * make one from a template. The sheet draws the layout; the rules live here.
 */

export interface GuildTemplate {
  id: string;
  name: string;
  description: string;
  creator_id: string;
  source_guild_id: string | null;
  template_data: {
    channels: { name: string; type: number; position: number; parent_name: string | null }[];
    roles: { name: string; permissions: string; color: number; position: number }[];
  };
  usage_count: number;
  created_at: string;
}

/** Where an invite points: its code and, when the person pasted a link, the server it names. */
export interface InviteTarget {
  code: string;
  /** The server the link names; null when only a code was pasted (it is for the server in view). */
  serverUrl: string | null;
}

const BARE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read what was pasted into the Join tab: an invite link of any shape
 * `lib/inviteLinks.ts` accepts (including a link to another server), or a bare
 * code. Anything else is null; the sheet says so instead of guessing.
 */
export function inviteTargetOf(input: string): InviteTarget | null {
  const trimmed = input.trim();
  const link = parseInviteLink(trimmed);
  if (link) return { code: link.code, serverUrl: link.serverUrl };
  return BARE_CODE.test(trimmed) ? { code: trimmed, serverUrl: null } : null;
}

/**
 * The account an invite is accepted with. A link to the server in view, or a
 * bare code, uses the account in view; a link to another saved server uses that
 * server's account. A server this app does not know, or one that is not signed
 * in, stops with the reason: joining must not quietly go somewhere else.
 */
export function accountForInvite(target: InviteTarget, inView: AccountScope): AccountScope {
  if (!target.serverUrl) return inView;
  const saved = useServerListStore.getState().getServerByUrl(target.serverUrl);
  let serverId: string | null = saved?.id ?? null;
  if (!serverId) {
    const own = resolveDefaultServerTarget();
    if (own && normalizeServerUrl(own) === normalizeServerUrl(target.serverUrl)) serverId = LOCAL_SERVER_ID;
  }
  const host = new URL(target.serverUrl).host;
  if (!serverId) {
    throw new Error(`This invite is for ${host}, which you have not added yet. Add that server first, then paste the link again.`);
  }
  if (serverId === inView.serverId) return inView;
  const account = getServerAccountScope(serverId);
  if (!account) {
    throw new Error(`This invite is for ${saved?.name ?? host}, which you are not signed in to. Sign in there first, then paste the link again.`);
  }
  return account;
}

/** The suggested name for a new server. */
export function defaultServerName(username: string | null | undefined): string {
  return `${username || 'My'}'s server`;
}

/* ---- Templates ------------------------------------------------------------------ */

export interface TemplateList {
  templates: GuildTemplate[];
  loading: boolean;
  /** "Failed to load templates: …", shown loudly; null when the list is in. */
  error: string | null;
  reload: () => void;
}

/** The instance's templates, fetched while `enabled` and aborted when it stops. */
export function useGuildTemplates(enabled: boolean): TemplateList {
  const [attempt, setAttempt] = useState(0);
  // What the last request said, and which attempt said it: a request is in flight
  // until an answer for the current attempt has come.
  const [answer, setAnswer] = useState<{ attempt: number; templates: GuildTemplate[]; error: string | null } | null>(null);

  // The templates are the selected server's. When it is not connected the answer is the
  // "not connected" line (with Reload), never a throw out of this effect, and the list is
  // asked again by itself when the server comes up.
  const ready = useServerReady();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => getApi().get<GuildTemplate[]>('/templates', { signal: controller.signal }))()
      .then((response) => {
        if (!controller.signal.aborted) setAnswer({ attempt, templates: response.data, error: null });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setAnswer({ attempt, templates: [], error: `Failed to load templates: ${extractApiError(err)}` });
        }
      });
    return () => controller.abort();
  }, [enabled, attempt, ready]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const current = answer?.attempt === attempt ? answer : null;
  return {
    templates: current?.templates ?? answer?.templates ?? NO_TEMPLATES,
    loading: enabled && current === null,
    error: current?.error ?? null,
    reload,
  };
}

const NO_TEMPLATES: GuildTemplate[] = [];

/* ---- The server's picture --------------------------------------------------------- */

export interface ServerIcon {
  /** An object URL for the preview, or null. */
  preview: string | null;
  /** The data URL the server takes, or null. */
  dataUrl: string | null;
  /** A refused file ("Please upload PNG, JPG, GIF, or WEBP."), or null. */
  error: string | null;
  choose: (file: File | undefined) => void;
  clear: () => void;
}

/** The picture a new server is created with. */
export function useServerIcon(): ServerIcon {
  const [preview, setPreview] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const choose = useCallback((file: File | undefined) => {
    if (!file) return;
    if (!isAllowedImageMimeType(file.type)) {
      setError('Please upload PNG, JPG, GIF, or WEBP.');
      return;
    }
    setError(null);
    setPreview(URL.createObjectURL(file));
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setDataUrl(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const clear = useCallback(() => {
    setPreview(null);
    setDataUrl(null);
    setError(null);
  }, []);

  return { preview, dataUrl, error, choose, clear };
}

/* ---- Doing it ----------------------------------------------------------------------- */

export interface AddServerActions {
  loading: boolean;
  /** What went wrong with the last attempt, in the server's words; null before one. */
  error: string | null;
  clearError: () => void;
  /** Make a server (with its picture, if one was chosen). */
  create: (name: string, icon: string | null) => Promise<void>;
  /** Join with an invite link or code. */
  join: (invite: string) => Promise<void>;
  /** Make a server from a template (the template route takes a name and nothing else). */
  fromTemplate: (templateId: string, name: string) => Promise<void>;
}

/**
 * The three ways to get a server. Each one lands on the new server's landing
 * channel: `onDone(path)` is called with its path after the server is in the
 * store, and the caller closes whatever it was and navigates.
 */
export function useAddServerActions(onDone: (path: string) => void): AddServerActions {
  const scope = useCurrentAccountScope();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const land = useCallback(
    async (guild: ScopedGuild) => {
      onDone(await guildLandingPath(guild));
    },
    [onDone],
  );

  const run = useCallback(async (fallback: string, work: () => Promise<void>) => {
    setError(null);
    setLoading(true);
    try {
      await work();
    } catch (err: unknown) {
      setError(extractApiError(err) || fallback);
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (name: string, icon: string | null) => {
      if (!name.trim() || !scope) return;
      await run('Failed to create server', async () => {
        await land(await useGuildStore.getState().createGuild(name.trim(), scope, icon || undefined));
      });
    },
    [land, run, scope],
  );

  const join = useCallback(
    async (invite: string) => {
      if (!invite.trim() || !scope) return;
      await run('Failed to join server', async () => {
        const target = inviteTargetOf(invite);
        if (!target) {
          throw new Error('That is not an invite link or code. Paste the whole link, or just the code at the end of it.');
        }
        await land(await useGuildStore.getState().acceptInvite(target.code, accountForInvite(target, scope)));
      });
    },
    [land, run, scope],
  );

  const fromTemplate = useCallback(
    async (templateId: string, name: string) => {
      if (!templateId || !name.trim() || !scope) return;
      await run('Failed to create server from template', async () => {
        await land(await useGuildStore.getState().applyTemplate(templateId, name.trim(), scope));
      });
    },
    [land, run, scope],
  );

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, clearError, create, join, fromTemplate };
}
