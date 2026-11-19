import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useEffect, useState } from "react";
import type { AgentInfo, EnvironmentConfig } from "../api.ts";
import { ConfigForm } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";

type OpenProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  detail,
  confirmLabel,
  onConfirm,
}: OpenProps & {
  title: string;
  description: string;
  /** A path or name the decision is about, shown whole under the description. */
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <AlertDialogBackdrop />
      <AlertDialogContent>
        <div data-slot="stack">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {detail !== undefined ? <code data-slot="decision-path">{detail}</code> : null}
        </div>
        <div data-slot="row">
          <AlertDialogClose>Cancel</AlertDialogClose>
          <AlertDialogClose data-variant="solid" value="confirm" onClick={() => onConfirm()}>
            {confirmLabel}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type EnvironmentDialogProps = OpenProps & {
  onSave: (environment: EnvironmentConfig) => void | Promise<void>;
};

/** A remote environment: a daemon on another machine, reached over ssh with the keys and config the user already has. */
export function EnvironmentDialog({ open, onOpenChange, onSave }: EnvironmentDialogProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [command, setCommand] = useState("cycle proxy");
  const [busy, setBusy] = useState(false);
  // Each time it opens it is empty: what was added the time before is not to be added again.
  useEffect(() => {
    if (open) return;
    setName("");
    setHost("");
    setCommand("cycle proxy");
  }, [open]);
  const save = async () => {
    if (host.trim() === "" || busy) return;
    setBusy(true);
    try {
      await add();
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const id = `ssh-${host.trim().replace(/[^a-zA-Z0-9]+/g, "-")}`;
    await onSave({
      id,
      name: name.trim() || host.trim(),
      kind: "remote",
      transport: {
        type: "ssh",
        host: host.trim(),
        command: command.trim().split(/\s+/).filter(Boolean),
      },
    });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>Add an environment</DialogTitle>
        <DialogDescription>
          Cycle connects with your system's ssh, so your keys and ~/.ssh/config apply. There is no
          password prompt.
        </DialogDescription>
        <div data-slot="stack">
          <Field name="host">
            <FieldLabel>Address</FieldLabel>
            <Input
              value={host}
              placeholder="user@host, or an alias"
              onChange={(e) => setHost(e.currentTarget.value)}
            />
          </Field>
          <Field name="name">
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              placeholder={host || "Shown in the list"}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field name="command">
            <FieldLabel>Command on the environment</FieldLabel>
            <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          </Field>
        </div>
        <div data-slot="row">
          <DialogClose>Cancel</DialogClose>
          <Button data-variant="solid" disabled={host.trim() === "" || busy} onClick={save}>
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type AgentDefaultsProps = OpenProps & {
  agents: AgentInfo[];
  read: (agent: string) => Promise<Record<string, string> | undefined>;
  onSave: (agent: string, config: Record<string, string>) => void | Promise<void>;
};

/** What every new session of an agent starts with. */
export function AgentDefaultsDialog({
  open,
  onOpenChange,
  agents,
  read,
  onSave,
}: AgentDefaultsProps) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const agentKey = agent?.id;
  // Saved only as what was read for the agent shown: the settings of the one before are not this one's.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    if (!open || agentKey === undefined) return;
    let current = true;
    setLoaded(null);
    setUnread(false);
    setConfig({});
    read(agentKey).then(
      (defaults) => {
        if (!current) return;
        setConfig(defaults ?? {});
        setLoaded(agentKey);
      },
      () => {
        // Not "nothing saved": saving over it would replace what is saved with the near-empty form.
        if (current) setUnread(true);
      },
    );
    return () => {
      current = false;
    };
  }, [open, agentKey, read]);
  useEffect(() => {
    if (open) return;
    setLoaded(null);
    setUnread(false);
    setConfig({});
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>Agent defaults</DialogTitle>
        <DialogDescription>New sessions of the agent start with these settings.</DialogDescription>
        <div data-slot="stack">
          {agents.length > 1 ? (
            <Field name="agent">
              <FieldLabel>Agent</FieldLabel>
              <Select
                items={agents.map((a) => ({ value: a.id, label: a.name }))}
                value={agent?.id ?? null}
                onValueChange={(next) => setAgentId(next as string | null)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {agent !== undefined && loaded === agentKey ? (
            <ConfigForm schema={agent.configSchema} value={config} onChange={setConfig} />
          ) : null}
          {unread ? <p data-slot="hint">{t("defaults.unreadable")}</p> : null}
        </div>
        <div data-slot="row">
          <DialogClose>Close</DialogClose>
          <Button
            data-variant="solid"
            disabled={agent === undefined || loaded !== agentKey || busy}
            onClick={async () => {
              if (agent === undefined || busy) return;
              setBusy(true);
              try {
                await onSave(agent.id, config);
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type RenameProps = OpenProps & {
  current: string;
  onRename: (title: string) => void | Promise<void>;
};

export function RenameDialog({ open, onOpenChange, current, onRename }: RenameProps) {
  const [title, setTitle] = useState(current);
  useEffect(() => {
    if (open) setTitle(current);
  }, [open, current]);
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>Rename</DialogTitle>
        <Field name="title">
          <FieldLabel>Name</FieldLabel>
          <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <div data-slot="row">
          <DialogClose>Cancel</DialogClose>
          <Button
            data-variant="solid"
            disabled={title.trim() === ""}
            onClick={async () => {
              await onRename(title.trim());
              onOpenChange(false);
            }}
          >
            Rename
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
