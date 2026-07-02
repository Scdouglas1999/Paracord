import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Folder {
  id: string;
  name: string;
  color?: string;
  guildIds: string[];
  collapsed: boolean;
}

interface FolderState {
  folders: Folder[];

  createFolder: (name: string, color?: string) => void;
  deleteFolder: (id: string) => void;
  addGuildToFolder: (folderId: string, guildId: string) => void;
  removeGuildFromFolder: (folderId: string, guildId: string) => void;
  toggleCollapsed: (folderId: string) => void;
  reorderFolders: (folderIds: string[]) => void;
}

export const useFolderStore = create<FolderState>()(
  persist(
    (set) => ({
      folders: [],

      createFolder: (name, color) =>
        set((state) => ({
          folders: [
            ...state.folders,
            {
              id: crypto.randomUUID(),
              name,
              color,
              guildIds: [],
              collapsed: false,
            },
          ],
        })),

      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
        })),

      addGuildToFolder: (folderId, guildId) =>
        set((state) => ({
          folders: state.folders.map((f) => {
            if (f.id === folderId) {
              if (f.guildIds.includes(guildId)) return f;
              return { ...f, guildIds: [...f.guildIds, guildId] };
            }
            // Remove from other folders so a guild is only in one folder
            if (f.guildIds.includes(guildId)) {
              return { ...f, guildIds: f.guildIds.filter((id) => id !== guildId) };
            }
            return f;
          }),
        })),

      removeGuildFromFolder: (folderId, guildId) =>
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId
              ? { ...f, guildIds: f.guildIds.filter((id) => id !== guildId) }
              : f
          ),
        })),

      toggleCollapsed: (folderId) =>
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, collapsed: !f.collapsed } : f
          ),
        })),

      reorderFolders: (folderIds) =>
        set((state) => {
          const byId = new Map(state.folders.map((f) => [f.id, f]));
          const reordered: Folder[] = [];
          for (const id of folderIds) {
            const f = byId.get(id);
            if (f) reordered.push(f);
          }
          return { folders: reordered };
        }),
    }),
    {
      name: 'paracord:folders',
    }
  )
);
