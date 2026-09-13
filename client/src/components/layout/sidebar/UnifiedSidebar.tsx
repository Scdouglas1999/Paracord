import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Bell, BellOff, CheckCheck, LogOut, Settings } from 'lucide-react';

import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useBuildingLights } from '../../../hooks/useLights';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { useVoice } from '../../../hooks/useVoice';
import { personLight, type BuildingLight, type RoomLight } from '../../../lib/attention/light';
import { activateGuild } from '../../../lib/guildNavigation';
import { markGuildRead } from '../../../lib/guildActions';
import { canAccessGuildSettingsSync } from '../../../lib/guildSettingsAccess';
import { displayName } from '../../../lib/displayName';
import { findScopedGuild } from '../../../lib/guildScope';
import { accountScopeKey, entityScopeKey, LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { getServerAccountScope } from '../../../lib/serverIdentity';
import { isAdmin as isGlobalAdmin } from '../../../types';
import { useAuthStore } from '../../../stores/authStore';
import { confirm } from '../../../stores/confirmStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { CreateGuildModal } from '../../guild/CreateGuildModal';
import { AccountPlate } from './AccountPlate';
import { BuildingsColumn } from './BuildingsColumn';
import { CallDock } from './CallDock';
import { CollapsedRail } from './CollapsedRail';
import type { RoomAttention } from './RoomRow';

/**
 * The sidebar — a 276px **Buildings column** on the street
 * (docs/lantern-stage-spec.md §7.1; IA from docs/layout-spec.md §5, §6).
 *
 * This module is the container: it reads the stores through WP1's selectors and
 * hands plain models to the presentational column. `useBuildingLights()` is the
 * ONLY source of what is lit — nothing here re-derives a light (WP1 §9).
 *
 * What it merges on top of the light:
 *   - the Home and Messages counts, from the cross-server conversation merge
 *   - unread / mention state per room, keyed the same way a `RoomLight` is
 *   - the building context menu (mute, mark read, settings, leave) — re-homed
 *     from the deleted `SpacesList`, which was the only writer of the muted set
 */

export function UnifiedSidebar() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const activeScope = useCurrentAccountScope();
  const user = useCurrentUser();
  const settings = useAuthStore((s) => s.settings);
  const { selfMute, selfDeaf, toggleMute: toggleSelfMute, toggleDeaf } = useVoice();
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showCreateGuild, setShowCreateGuild] = useState(false);

  const buildings = useBuildingLights();
  const { mutedGuildKeys, toggleMute, saving } = useMutedGuilds();
  const { needsYou, needsYouOverflowCount, recent, pinned } = useUnifiedConversations(mutedGuildKeys);

  const mutedBuildingKeys = useMemo(() => new Set(mutedGuildKeys), [mutedGuildKeys]);

  /**
   * Unread / mention state per room. A `ConversationEntry.key` and a
   * `RoomLight.key` are the same `entityScopeKey(scope, channelId)`, so the two
   * merges line up without a second resolution pass.
   */
  const attention = useMemo(() => {
    const map = new Map<string, RoomAttention>();
    for (const entry of [...needsYou, ...pinned, ...recent]) {
      if (!entry.guildId) continue;
      map.set(entry.key, { unread: entry.unread, mentionCount: entry.mentionCount });
    }
    return map;
  }, [needsYou, pinned, recent]);

  /**
   * The Home chip: everything the attention ranking says is waiting on you —
   * the capped Needs-you list plus the count that continues past the cap. Home
   * owns the list now (§7.1); the column keeps only the number.
   */
  const needsYouCount = needsYou.length + needsYouOverflowCount;

  /** The Messages chip: direct and group conversations carrying unread. */
  const messagesCount = useMemo(
    () =>
      [...needsYou, ...pinned, ...recent].filter(
        (entry) =>
          (entry.kind === 'dm' || entry.kind === 'group_dm')
          && (entry.isDMUnread || entry.unread || entry.mentionCount > 0),
      ).length,
    [needsYou, pinned, recent],
  );

  const pathname = location.pathname;
  const homeActive = pathname === '/app' || pathname === '/app/';
  const messagesActive = pathname.startsWith('/app/dms');
  const activeBuildingKey =
    activeScope && params.guildId && !params.channelId
      ? entityScopeKey(activeScope, params.guildId)
      : null;
  const activeRoomKey =
    activeScope && params.channelId ? entityScopeKey(activeScope, params.channelId) : null;

  const account = useMemo(
    () =>
      personLight({
        userId: user?.id ?? '0',
        name: displayName(user),
        status: settings?.status === 'invisible' ? 'offline' : (settings?.status ?? 'online'),
        avatar: user?.avatar_hash ?? null,
      }),
    [settings?.status, user],
  );

  const openCreateGuild = useCallback(() => setShowCreateGuild(true), []);
  const openHome = useCallback(() => navigate('/app'), [navigate]);
  const openMessages = useCallback(() => navigate('/app/dms'), [navigate]);
  const openSearch = useCallback(() => useUIStore.getState().setCommandPaletteOpen(true), []);
  const openSettings = useCallback(() => useUIStore.getState().setUserSettingsOpen(true), []);

  const openLobby = useCallback(
    (building: BuildingLight) => {
      try {
        activateGuild({ id: building.guildId, scope: building.scope });
        navigate(`/app/guilds/${building.guildId}`);
      } catch (error) {
        toast.error(`Failed to open ${building.name}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const openRoom = useCallback(
    (room: RoomLight) => {
      if (!room.guildId) return;
      try {
        activateGuild({ id: room.guildId, scope: room.scope });
        navigate(`/app/guilds/${room.guildId}/channels/${room.channelId}`);
      } catch (error) {
        toast.error(`Failed to open ${room.name}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const leaveBuilding = useCallback(
    async (building: BuildingLight) => {
      const ok = await confirm({
        title: `Leave ${building.name}?`,
        description: 'You will need an invite to come back to this building.',
        confirmLabel: 'Leave building',
        variant: 'danger',
      });
      if (!ok) return;
      try {
        await useGuildStore.getState().leaveGuild(building.guildId, building.scope);
        toast.success(`Left ${building.name}.`);
        const currentScope = getServerAccountScope(
          useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID,
        );
        if (
          currentScope
          && accountScopeKey(currentScope) === accountScopeKey(building.scope)
          && typeof window !== 'undefined'
          && window.location.pathname.includes(`/guilds/${building.guildId}`)
        ) {
          navigate('/app');
        }
      } catch (error) {
        toast.error(`Failed to leave building: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  /**
   * The building context menu, re-homed from `SpacesList` (layout-spec §2). It
   * is still the only writer of the account-owned muted set that feeds the
   * attention ranking.
   */
  const buildingMenu = useCallback(
    (building: BuildingLight): ContextMenuItem[] => {
      const reference = { id: building.guildId, scope: building.scope };
      const muted = mutedGuildKeys.includes(building.key);
      const guild = findScopedGuild(useGuildStore.getState().guilds, building.scope, building.guildId);
      const isOwner = Boolean(building.scope.userId && guild?.owner_id === building.scope.userId);
      const items: ContextMenuItem[] = [
        {
          label: muted ? 'Unmute building' : 'Mute building',
          icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
          disabled: saving[building.key] ?? false,
          action: () => {
            void toggleMute(reference);
          },
        },
        {
          label: 'Mark as read',
          icon: <CheckCheck size={16} />,
          action: () => {
            void markGuildRead(reference).catch((error) =>
              toast.error(`Failed to save read positions: ${extractApiError(error)}`),
            );
          },
        },
      ];
      if (canAccessGuildSettingsSync(building.guildId, building.scope)) {
        items.push({
          label: 'Building settings',
          icon: <Settings size={16} />,
          action: () => {
            activateGuild(reference);
            useUIStore.getState().setGuildSettingsId(building.guildId);
          },
        });
      }
      if (!isOwner) {
        items.push({
          label: 'Leave building',
          icon: <LogOut size={16} />,
          danger: true,
          action: () => void leaveBuilding(building),
        });
      }
      return items;
    },
    [leaveBuilding, mutedGuildKeys, saving, toggleMute],
  );

  const onBuildingContextMenu = useCallback(
    (event: MouseEvent, building: BuildingLight) => onContextMenu(event, buildingMenu(building)),
    [buildingMenu, onContextMenu],
  );

  const showAdminDashboard = Boolean(user && isGlobalAdmin(user.flags ?? 0));

  return (
    <>
      {sidebarCollapsed ? (
        <aside aria-label="Navigation" data-collapsed="true" className="h-full w-16 shrink-0 bg-bg-base py-1">
          <CollapsedRail
            buildings={buildings}
            activeBuildingKey={activeBuildingKey ?? (activeRoomKey ? activeGuildKeyOf(buildings, activeRoomKey) : null)}
            account={account}
            homeActive={homeActive}
            messagesActive={messagesActive}
            onOpenSearch={openSearch}
            onOpenHome={openHome}
            onOpenMessages={openMessages}
            onOpenLobby={openLobby}
            onAddBuilding={openCreateGuild}
            onOpenSettings={openSettings}
            footer={<CallDock collapsed />}
          />
        </aside>
      ) : (
        <aside
          aria-label="Navigation"
          data-collapsed="false"
          className="h-full w-[88vw] max-w-full shrink-0 bg-bg-base p-3 md:w-[calc(var(--w-buildings-column)+var(--gutter)+var(--gutter))]"
        >
          <BuildingsColumn
            buildings={buildings}
            needsYouCount={needsYouCount}
            messagesCount={messagesCount}
            homeActive={homeActive}
            messagesActive={messagesActive}
            activeBuildingKey={activeBuildingKey}
            activeRoomKey={activeRoomKey}
            attention={attention}
            mutedBuildingKeys={mutedBuildingKeys}
            onOpenHome={openHome}
            onOpenMessages={openMessages}
            onOpenLobby={openLobby}
            onOpenRoom={openRoom}
            onAddBuilding={openCreateGuild}
            onBuildingContextMenu={onBuildingContextMenu}
            footer={
              <div className="flex flex-col gap-2">
                <CallDock />
                <AccountPlate
                  user={user}
                  navigate={navigate}
                  muted={selfMute}
                  deafened={selfDeaf}
                  onToggleMute={toggleSelfMute}
                  onToggleDeaf={toggleDeaf}
                  showAdminDashboard={showAdminDashboard}
                />
              </div>
            }
          />
        </aside>
      )}

      <ContextMenu
        open={contextMenu.isOpen}
        items={contextMenu.items}
        position={contextMenu.position}
        onClose={closeContextMenu}
      />
      {showCreateGuild && <CreateGuildModal onClose={() => setShowCreateGuild(false)} />}
    </>
  );
}

/** The building a room belongs to, so the collapsed rail can mark it. */
function activeGuildKeyOf(buildings: readonly BuildingLight[], roomKey: string): string | null {
  for (const building of buildings) {
    if (building.rooms.some((room) => room.key === roomKey)) return building.key;
  }
  return null;
}
