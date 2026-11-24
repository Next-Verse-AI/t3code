import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  normalizeFolderName,
  sanitizeThreadFolders,
  useThreadFoldersStore,
} from "./threadFoldersStore";

const store = () => useThreadFoldersStore.getState();

beforeEach(() => {
  useThreadFoldersStore.setState({ folders: [], folderByThread: {} });
});

describe("thread folders", () => {
  it("files threads in a folder, opens it, and takes them back out", () => {
    const id = store().createFolder("  Personal  ");
    expect(store().folders).toEqual([{ id, name: "Personal", collapsed: false }]);
    store().toggleFolder(id);
    store().moveThreads(["env\u0000a", "env\u0000b"], id);
    expect(store().folderByThread).toEqual({ "env\u0000a": id, "env\u0000b": id });
    // Moving a thread into a closed folder opens it.
    expect(store().folders[0]?.collapsed).toBe(false);
    store().moveThreads(["env\u0000a"], null);
    expect(store().folderByThread).toEqual({ "env\u0000b": id });
  });

  it("ignores a move to a folder that does not exist", () => {
    store().moveThreads(["env\u0000a"], "missing");
    expect(store().folderByThread).toEqual({});
  });

  it("puts a deleted folder's threads back", () => {
    const keep = store().createFolder("Keep");
    const drop = store().createFolder("Drop");
    store().moveThreads(["env\u0000a"], keep);
    store().moveThreads(["env\u0000b"], drop);
    store().deleteFolder(drop);
    expect(store().folders.map((folder) => folder.name)).toEqual(["Keep"]);
    expect(store().folderByThread).toEqual({ "env\u0000a": keep });
  });

  it("renames only to a real name", () => {
    const id = store().createFolder("Work");
    store().renameFolder(id, "   ");
    expect(store().folders[0]?.name).toBe("Work");
    store().renameFolder(id, "Ops  team");
    expect(store().folders[0]?.name).toBe("Ops team");
  });
});

describe("sanitizeThreadFolders", () => {
  it("drops malformed folders and assignments to missing ones", () => {
    expect(
      sanitizeThreadFolders({
        folders: [{ id: "f", name: " A ", collapsed: true }, { id: "", name: "x" }, "junk"],
        folderByThread: { t1: "f", t2: "gone", t3: 4 },
      }),
    ).toEqual({
      folders: [{ id: "f", name: "A", collapsed: true }],
      folderByThread: { t1: "f" },
    });
    expect(sanitizeThreadFolders(null)).toEqual({ folders: [], folderByThread: {} });
    expect(normalizeFolderName("  ")).toBeNull();
  });
});
