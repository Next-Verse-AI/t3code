import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { ThreadFolder } from "../../threadFoldersStore";

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarUserFolderRowId(folderId: string) {
  return `user-folder:${folderId}`;
}

/**
 * A folder the user made to group threads. It reads like a project folder: a trailing count
 * while closed and a chevron. Right-click renames or deletes it.
 */
export const SidebarUserFolderHeader = memo(function SidebarUserFolderHeader(props: {
  folder: ThreadFolder;
  threadCount: number;
  onToggle: (folderId: string) => void;
  onContextMenu: (
    folder: ThreadFolder,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { folder, threadCount } = props;
  const Icon = folder.collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <li data-testid="sidebar-user-folder" className="relative mt-2 list-none first:mt-0">
      <button
        type="button"
        data-sidebar-row={sidebarUserFolderRowId(folder.id)}
        aria-expanded={!folder.collapsed}
        onClick={() => props.onToggle(folder.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            folder,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {folder.name}
        </span>
        {folder.collapsed && threadCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {threadCount}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            folder.collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
});
