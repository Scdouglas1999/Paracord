import { useCallback, useEffect, useState } from 'react';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { guildLandingPath } from '../../../lib/guildNavigation';
import type { ScopedGuild } from '../../../lib/guildScope';
import { isAllowedImageMimeType } from '../../../lib/security';
import { useGuildStore } from '../../../stores/guildStore';

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

/** The code of an invite: a pasted link (`https://paracord.gg/hTKzmak`) or the code itself. */
export function inviteCodeOf(input: string): string {
  const trimmed = input.trim();
  return trimmed.split('/').pop() || trimmed;
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

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getApi()
      .get<GuildTemplate[]>('/templates', { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setAnswer({ attempt, templates: response.data, error: null });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setAnswer({ attempt, templates: [], error: `Failed to load templates: ${extractApiError(err)}` });
        }
      });
    return () => controller.abort();
  }, [enabled, attempt]);

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
        await land(await useGuildStore.getState().acceptInvite(inviteCodeOf(invite), scope));
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
