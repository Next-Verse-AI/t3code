import { useEffect, useId, useState } from "react";
import { T, useGT } from "gt-react";
import { create } from "zustand";

import { normalizeFolderName } from "../threadFoldersStore";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly mode: "create" | "rename";
  readonly initial: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a folder name; resolves null when the dialog is cancelled. */
export function requestFolderName(mode: Request["mode"], initial = ""): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { mode, initial, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending folder name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog request={request} /> : null;
}

function FolderNameDialog({ request }: { request: Request }) {
  const gt = useGT();
  const id = useId();
  const [name, setName] = useState(request.initial);
  const normalized = normalizeFolderName(name);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (normalized !== null) finish(normalized);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request.mode === "create" ? <T>New folder</T> : <T>Rename folder</T>}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={id}>
                <T>Name</T>
              </Label>
              <Input
                id={id}
                autoFocus
                value={name}
                placeholder={gt("e.g. Personal")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={normalized === null}>
              {request.mode === "create" ? <T>Create</T> : <T>Rename</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
