// Folders the user makes in the sidebar to group threads. They are kept on this device only.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export interface ThreadFolder {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
}

export interface ThreadFoldersState {
  readonly folders: ReadonlyArray<ThreadFolder>;
  /** Thread key (`scopedThreadKey`) to the folder it sits in. */
  readonly folderByThread: Readonly<Record<string, string>>;
  readonly createFolder: (name: string) => string;
  readonly renameFolder: (id: string, name: string) => void;
  readonly toggleFolder: (id: string) => void;
  /** Deleting a folder puts its threads back where they were. */
  readonly deleteFolder: (id: string) => void;
  /** Moves threads into a folder, or out of any folder with null. */
  readonly moveThreads: (threadKeys: ReadonlyArray<string>, folderId: string | null) => void;
}

export function normalizeFolderName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : trimmed.slice(0, 80);
}

/** Drops assignments to folders that no longer exist, and folders that are malformed. */
export function sanitizeThreadFolders(
  value: unknown,
): Pick<ThreadFoldersState, "folders" | "folderByThread"> {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const folders = (Array.isArray(raw.folders) ? raw.folders : []).flatMap((folder: unknown) => {
    if (typeof folder !== "object" || folder === null) return [];
    const { id, name, collapsed } = folder as Record<string, unknown>;
    const normalized = typeof name === "string" ? normalizeFolderName(name) : null;
    if (typeof id !== "string" || id === "" || normalized === null) return [];
    return [{ id, name: normalized, collapsed: collapsed === true }];
  });
  const ids = new Set(folders.map((folder) => folder.id));
  const assignments =
    typeof raw.folderByThread === "object" && raw.folderByThread !== null
      ? (raw.folderByThread as Record<string, unknown>)
      : {};
  const folderByThread: Record<string, string> = {};
  for (const [threadKey, folderId] of Object.entries(assignments)) {
    if (typeof folderId === "string" && ids.has(folderId)) folderByThread[threadKey] = folderId;
  }
  return { folders, folderByThread };
}

export const useThreadFoldersStore = create<ThreadFoldersState>()(
  persist(
    (set) => ({
      folders: [],
      folderByThread: {},
      createFolder: (name) => {
        const id = randomUUID();
        const normalized = normalizeFolderName(name);
        if (normalized === null) return id;
        set((state) => ({
          folders: [...state.folders, { id, name: normalized, collapsed: false }],
        }));
        return id;
      },
      renameFolder: (id, name) => {
        const normalized = normalizeFolderName(name);
        if (normalized === null) return;
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === id ? { ...folder, name: normalized } : folder,
          ),
        }));
      },
      toggleFolder: (id) =>
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === id ? { ...folder, collapsed: !folder.collapsed } : folder,
          ),
        })),
      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((folder) => folder.id !== id),
          folderByThread: Object.fromEntries(
            Object.entries(state.folderByThread).filter(([, folderId]) => folderId !== id),
          ),
        })),
      moveThreads: (threadKeys, folderId) =>
        set((state) => {
          if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
            return state;
          }
          const folderByThread = { ...state.folderByThread };
          for (const key of threadKeys) {
            if (folderId === null) delete folderByThread[key];
            else folderByThread[key] = folderId;
          }
          // Moving a thread into a closed folder opens it, so the thread does not vanish.
          const folders =
            folderId === null
              ? state.folders
              : state.folders.map((folder) =>
                  folder.id === folderId ? { ...folder, collapsed: false } : folder,
                );
          return { folders, folderByThread };
        }),
    }),
    {
      name: "t3code:thread-folders:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ folders: state.folders, folderByThread: state.folderByThread }),
      merge: (persisted, current) => ({ ...current, ...sanitizeThreadFolders(persisted) }),
    },
  ),
);
