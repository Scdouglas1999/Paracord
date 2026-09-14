import { createInviteApi, inviteApi } from '../api/invites';
import { createTemplateApi } from '../api/templates';
import { create } from 'zustand';
import type { Guild, UpdateGuildRequest } from '../types';
import { createGuildApi } from '../api/guilds';
import { extractApiError } from '../api/client';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import { resolveApiBaseUrl } from '../lib/config/apiBaseUrl';
import { LOCAL_SERVER_ID } from '../lib/serverScope';
import { useServerListStore } from './serverListStore';
import { toast } from './toastStore';
import { registerSessionReset } from './sessionReset';
import { registerAccountHistoryReset } from '../lib/databaseHistory';

import type { GuildReference, ScopedGuild } from '../lib/guildScope';
export type { GuildReference, ScopedGuild } from '../lib/guildScope';
interface GuildState {
  guilds: ScopedGuild[];
  selectedGuild: GuildReference | null;
  loading: Record<string, boolean>;
  acceptInvite: (code: string, scope: AccountScope, answers?: Parameters<typeof inviteApi.accept>[1]) => Promise<ScopedGuild>;
  applyTemplate: (id: string, name: string, scope: AccountScope) => Promise<ScopedGuild>;
  joinPublic: (id: string, scope: AccountScope) => Promise<ScopedGuild>;
  fetchGuilds: (scope: AccountScope) => Promise<void>;
  selectGuild: (guild: GuildReference | null) => void;
  createGuild: (name: string, scope: AccountScope, icon?: string) => Promise<ScopedGuild>;
  updateGuild: (id: string, data: UpdateGuildRequest, scope: AccountScope) => Promise<void>;
  deleteGuild: (id: string, scope: AccountScope) => Promise<void>;
  leaveGuild: (id: string, scope: AccountScope) => Promise<void>;
  setGuilds: (guilds: Guild[], scope: AccountScope) => void;
  addGuild: (guild: Guild, scope: AccountScope) => void;
  removeGuild: (id: string, scope: AccountScope) => void;
  updateGuildData: (id: string, data: Partial<Guild>, scope: AccountScope) => void;
  resetAccount: (scope: AccountScope) => void;
  reset: () => void;
}

type GuildMutation = { kind: 'delete' } | { kind: 'put'; guild: Guild } | { kind: 'patch'; guild: Partial<Guild> };
interface GuildRequest { context: OperationContext; promise: Promise<void>; mutations: Map<string, GuildMutation> }
const requests = new Map<string, GuildRequest>();
const operations = new Set<OperationContext>();
const MAX_PENDING_GUILDS = 10_000;

/** Ownership is assigned by the transport, never by fields in its payload. */
export function scopeGuild(guild: Guild, scope: AccountScope): ScopedGuild {
  const server = scope.serverId === LOCAL_SERVER_ID ? undefined : useServerListStore.getState().getServer(scope.serverId);
  const serverUrl = scope.serverId === LOCAL_SERVER_ID ? resolveApiBaseUrl() : server ? `${server.url.replace(/\/+$/, '')}/api/v1` : undefined;
  return { ...guild, scope: { ...scope }, key: entityScopeKey(scope, guild.id), originServerId: scope.serverId, server_url: serverUrl };
}
function record(scope: AccountScope, id: string, mutation: GuildMutation) {
  const request = requests.get(accountScopeKey(scope));
  if (!request) return;
  if (!request.mutations.has(id) && request.mutations.size >= MAX_PENDING_GUILDS) {
    request.context.dispose();
    toast.error('Server activity exceeded this snapshot. Reload your servers to refresh.');
    return;
  }
  const previous = request.mutations.get(id);
  if (mutation.kind === 'patch' && previous) {
    if (previous.kind === 'delete') return;
    request.mutations.set(id, { ...previous, guild: { ...previous.guild, ...mutation.guild } } as GuildMutation);
  } else request.mutations.set(id, mutation);
}
function own(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  operations.add(context);
  context.signal.addEventListener('abort', () => operations.delete(context), { once: true });
  return context;
}

export const useGuildStore = create<GuildState>()((set, get) => ({
  guilds: [], selectedGuild: null, loading: {},
  fetchGuilds: async scope => {
    const key = accountScopeKey(scope);
    const previous = requests.get(key);
    if (previous) return previous.promise;
    let context: OperationContext;
    try { context = own(scope); } catch { return; }
    const request: GuildRequest = { context, promise: Promise.resolve(), mutations: new Map() };
    requests.set(key, request);
    context.signal.addEventListener('abort', () => {
      if (requests.get(key) !== request) return;
      requests.delete(key);
      set(state => ({ loading: { ...state.loading, [key]: false } }));
    }, { once: true });
    set(state => ({ loading: { ...state.loading, [key]: true } }));
    request.promise = (async () => {
      try {
        const { data } = await createGuildApi(() => context.api).getAll();
        context.assertCurrent();
        if (requests.get(key) !== request) return;
        const guilds = new Map<string, Guild>(data.map(guild => [guild.id, guild]));
        for (const [id, mutation] of request.mutations) {
          if (mutation.kind === 'delete') guilds.delete(id);
          else if (mutation.kind === 'put') guilds.set(id, mutation.guild);
          else {
            const existing = guilds.get(id);
            if (existing) guilds.set(id, { ...existing, ...mutation.guild });
          }
        }
        get().setGuilds([...guilds.values()], scope);
      } catch (err) {
        if (!context.signal.aborted) toast.error(`Failed to load servers: ${extractApiError(err)}`);
      } finally { context.dispose(); }
    })();
    return request.promise;
  },
  acceptInvite: async (code, scope, answers) => {
    const context = own(scope);
    try {
      const { data } = await createInviteApi(() => context.api).accept(code, answers);
      context.assertCurrent();
      const guild = 'guild' in data ? data.guild : data;
      get().addGuild(guild, scope);
      return scopeGuild(guild, scope);
    } finally { context.dispose(); }
  },
  applyTemplate: async (id, name, scope) => {
    const context = own(scope);
    try {
      const { data } = await createTemplateApi(() => context.api).apply(id, name);
      context.assertCurrent();
      get().addGuild(data, scope);
      return scopeGuild(data, scope);
    } finally { context.dispose(); }
  },
  joinPublic: async (id, scope) => {
    const context = own(scope);
    try {
      const { data } = await createGuildApi(() => context.api).joinPublic(id);
      context.assertCurrent();
      get().addGuild(data, scope);
      return scopeGuild(data, scope);
    } finally { context.dispose(); }
  },
  selectGuild: guild => set({ selectedGuild: guild ? { id: guild.id, scope: { ...guild.scope } } : null }),
  setGuilds: (guilds, scope) => set(state => {
    const key = accountScopeKey(scope);
    const stamped = guilds.map(guild => scopeGuild(guild, scope));
    const selected = state.selectedGuild;
    return {
      guilds: [...state.guilds.filter(guild => accountScopeKey(guild.scope) !== key), ...stamped],
      selectedGuild: selected && accountScopeKey(selected.scope) === key && !stamped.some(guild => guild.id === selected.id) ? null : selected,
    };
  }),
  createGuild: async (name, scope, icon) => {
    const context = own(scope);
    try {
      const { data } = await createGuildApi(() => context.api).create({ name, icon });
      context.assertCurrent();
      get().addGuild(data, scope);
      return scopeGuild(data, scope);
    } finally { context.dispose(); }
  },
  updateGuild: async (id, patch, scope) => {
    const context = own(scope);
    try {
      const { data } = await createGuildApi(() => context.api).update(id, patch);
      context.assertCurrent();
      get().updateGuildData(id, data, scope);
    } catch (err) {
      if (!context.signal.aborted) toast.error(`Failed to update settings: ${extractApiError(err)}`);
      throw err;
    } finally { context.dispose(); }
  },
  deleteGuild: async (id, scope) => {
    const context = own(scope);
    try {
      await createGuildApi(() => context.api).delete(id);
      context.assertCurrent();
      get().removeGuild(id, scope);
    } finally { context.dispose(); }
  },
  leaveGuild: async (id, scope) => {
    const context = own(scope);
    try {
      await createGuildApi(() => context.api).leaveGuild(id);
      context.assertCurrent();
      get().removeGuild(id, scope);
    } finally { context.dispose(); }
  },
  addGuild: (guild, scope) => {
    const stamped = scopeGuild(guild, scope);
    record(scope, guild.id, { kind: 'put', guild });
    set(state => ({ guilds: state.guilds.some(existing => existing.key === stamped.key)
      ? state.guilds.map(existing => existing.key === stamped.key ? { ...existing, ...stamped } : existing)
      : [...state.guilds, stamped] }));
  },
  removeGuild: (id, scope) => {
    const key = entityScopeKey(scope, id);
    record(scope, id, { kind: 'delete' });
    set(state => ({
      guilds: state.guilds.filter(guild => guild.key !== key),
      selectedGuild: state.selectedGuild && entityScopeKey(state.selectedGuild.scope, state.selectedGuild.id) === key ? null : state.selectedGuild,
    }));
  },
  updateGuildData: (id, patch, scope) => {
    const key = entityScopeKey(scope, id);
    record(scope, id, { kind: 'patch', guild: patch });
    set(state => ({ guilds: state.guilds.map(guild => guild.key === key ? scopeGuild({ ...guild, ...patch, id }, scope) : guild) }));
  },
  resetAccount: scope => {
    const key = accountScopeKey(scope);
    for (const operation of operations) if (operation.key === key) operation.dispose();
    set(state => ({
      guilds: state.guilds.filter(guild => accountScopeKey(guild.scope) !== key),
      selectedGuild: state.selectedGuild && accountScopeKey(state.selectedGuild.scope) === key ? null : state.selectedGuild,
      loading: Object.fromEntries(Object.entries(state.loading).filter(([id]) => id !== key)),
    }));
  },
  reset: () => {
    for (const operation of operations) operation.dispose();
    operations.clear(); requests.clear();
    set({ guilds: [], selectedGuild: null, loading: {} });
  },
}));
registerSessionReset('guilds', () => useGuildStore.getState().reset());
registerAccountHistoryReset('guilds', scope => useGuildStore.getState().resetAccount(scope));
