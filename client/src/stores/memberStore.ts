import { create } from 'zustand';
import type { Member, User } from '../types';
import { createGuildApi } from '../api/guilds';
import { extractApiError, isMissingOrForbidden } from '../api/client';
import { captureOperationContext, type OperationContext } from '../lib/operationContext';
import { accountScopeKey, entityScopeKey, entityKeyBelongsToScope, type AccountScope } from '../lib/serverScope';
import { toast } from './toastStore';
import { registerSessionReset } from './sessionReset';
import { registerAccountHistoryReset } from '../lib/databaseHistory';

interface MemberState {
  /** Keys include the server, authenticated account and guild. */
  members: Map<string, Member[]>;
  membersLoaded: Record<string, boolean>;
  loading: Record<string, boolean>;
  fetchMembers: (guildId: string, scope: AccountScope) => Promise<void>;
  addMember: (guildId: string, member: Member, scope: AccountScope) => void;
  removeMember: (guildId: string, userId: string, scope: AccountScope) => void;
  updateMember: (guildId: string, member: MemberPatch, scope: AccountScope) => void;
  updateUserIdentity: (user: User, scope: AccountScope) => void;
  resetAccount: (scope: AccountScope) => void;
  reset: () => void;
}

type MemberPatch = Omit<Partial<Member>, 'user'> & { user: { id: string } & Partial<User> };
type MemberMutation = { kind: 'delete' } | { kind: 'upsert'; member: Member } | { kind: 'patch'; member: MemberPatch };
interface MemberRequest {
  context: OperationContext;
  promise: Promise<void>;
  mutations: Map<string, MemberMutation>;
}
const requests = new Map<string, MemberRequest>();
const MAX_PENDING_MEMBERS = 10_000;
const scopes = new Map<string, string>();

function applyMutation(members: Member[], userId: string, mutation: MemberMutation): Member[] {
  if (mutation.kind === 'delete') return members.filter(member => member.user.id !== userId);
  if (mutation.kind === 'upsert') return members.some(member => member.user.id === userId)
    ? members.map(member => member.user.id === userId ? mutation.member : member)
    : [...members, mutation.member];
  return members.map(member => member.user.id === userId
    ? { ...member, ...mutation.member, user: { ...member.user, ...mutation.member.user } }
    : member);
}

function reconcileSnapshot(snapshot: Member[], mutations: Map<string, MemberMutation>): Member[] {
  const members = new Map(snapshot.map(member => [member.user.id, member]));
  for (const [userId, mutation] of mutations) {
    if (mutation.kind === 'delete') {
      members.delete(userId);
    } else if (mutation.kind === 'upsert') {
      members.set(userId, mutation.member);
    } else {
      const existing = members.get(userId);
      if (existing) members.set(userId, {
        ...existing, ...mutation.member, user: { ...existing.user, ...mutation.member.user },
      });
    }
  }
  return [...members.values()];
}

function recordMutation(key: string, userId: string, mutation: MemberMutation) {
  const pending = requests.get(key);
  if (!pending || pending.context.signal.aborted) return;
  if (!pending.mutations.has(userId) && pending.mutations.size >= MAX_PENDING_MEMBERS) {
    pending.context.dispose();
    useMemberStore.setState(state => ({ membersLoaded: { ...state.membersLoaded, [key]: false } }));
    toast.error('Member activity exceeded this snapshot. Reopen the member list to refresh.');
    return;
  }
  const prior = pending.mutations.get(userId);
  // Coalesce fields, never closures or event arrays: repeated updates for a
  // single member cannot grow the journal or the reconciliation call stack.
  if (mutation.kind === 'patch' && prior) {
    if (prior.kind === 'delete') return;
    pending.mutations.set(userId, {
      ...prior,
      member: { ...prior.member, ...mutation.member, user: { ...prior.member.user, ...mutation.member.user } },
    } as MemberMutation);
  } else {
    pending.mutations.set(userId, mutation);
  }
}

export const useMemberStore = create<MemberState>()((set, get) => {
  const apply = (guildId: string, scope: AccountScope, userId: string, mutation: MemberMutation) => {
    const key = entityScopeKey(scope, guildId);
    scopes.set(key, accountScopeKey(scope));
    recordMutation(key, userId, mutation);
    set(state => {
      const members = new Map(state.members);
      members.set(key, applyMutation(members.get(key) ?? [], userId, mutation));
      return { members };
    });
  };
  return {
    members: new Map(),
    membersLoaded: {},
    loading: {},
    fetchMembers: async (guildId, scope) => {
      const key = entityScopeKey(scope, guildId);
      const existing = requests.get(key);
      if (existing) return existing.promise;
      let context: OperationContext;
      try {
        context = captureOperationContext(scope.serverId);
        if (context.scope.userId !== scope.userId) {
          context.dispose();
          return;
        }
      } catch {
        return; // No authenticated connection exists for this view.
      }
      const request: MemberRequest = { context, mutations: new Map(), promise: Promise.resolve() };
      requests.set(key, request);
      context.signal.addEventListener('abort', () => {
        if (requests.get(key) !== request) return;
        requests.delete(key);
        set(state => ({ loading: { ...state.loading, [key]: false } }));
      }, { once: true });
      scopes.set(key, accountScopeKey(scope));
      set(state => ({ loading: { ...state.loading, [key]: true } }));
      request.promise = (async () => {
        try {
          const { data } = await createGuildApi(() => context.api).getMembers(guildId);
          context.assertCurrent();
          if (requests.get(key) !== request) return;
          const reconciled = reconcileSnapshot(data, request.mutations);
          set(state => ({
            members: new Map(state.members).set(key, reconciled),
            membersLoaded: { ...state.membersLoaded, [key]: true },
          }));
        } catch (err) {
          if (!context.signal.aborted && requests.get(key) === request) {
            // A building that is not yours to see is not a failure to report on
            // top of whatever the surface is already saying about it — and
            // "Failed to load members: forbidden" is the API's words, not the
            // product's.
            if (!isMissingOrForbidden(err)) {
              toast.error(`Failed to load members: ${extractApiError(err)}`);
            }
          }
        } finally {
          context.dispose();
        }
      })();
      return request.promise;
    },
    addMember: (guildId, member, scope) => apply(guildId, scope, member.user.id, { kind: 'upsert', member }),
    removeMember: (guildId, userId, scope) => apply(guildId, scope, userId, { kind: 'delete' }),
    updateMember: (guildId, member, scope) => apply(guildId, scope, member.user.id, { kind: 'patch', member }),
    updateUserIdentity: (user, scope) => {
      const owner = accountScopeKey(scope);
      const mutation: MemberMutation = { kind: 'patch', member: { user } };
      const members = new Map(get().members);
      for (const [key, keyScope] of scopes) {
        if (keyScope !== owner) continue;
        recordMutation(key, user.id, mutation);
        const existing = members.get(key);
        if (existing) members.set(key, applyMutation(existing, user.id, mutation));
      }
      set({ members });
    },
    resetAccount: scope => {
      const owner = accountScopeKey(scope);
      for (const request of requests.values()) if (request.context.key === owner) request.context.dispose();
      for (const [key, keyScope] of scopes) if (keyScope === owner) scopes.delete(key);
      const retain = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => !entityKeyBelongsToScope(id, scope)));
      set(state => ({
        members: new Map([...state.members].filter(([id]) => !entityKeyBelongsToScope(id, scope))),
        membersLoaded: retain(state.membersLoaded), loading: retain(state.loading),
      }));
    },
    reset: () => {
      for (const request of requests.values()) request.context.dispose();
      requests.clear();
      scopes.clear();
      set({ members: new Map(), membersLoaded: {}, loading: {} });
    },
  };
});

registerSessionReset('members', () => useMemberStore.getState().reset());
registerAccountHistoryReset('members', scope => useMemberStore.getState().resetAccount(scope));
