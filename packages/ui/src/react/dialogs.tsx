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
import { useEffect, useRef, useState } from "react";
import type { AgentInfo, EnvironmentConfig } from "../api.ts";
import { ConfigForm } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";

type OpenProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: OpenProps & {
  title: string;
  description: string;
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

export type NewSessionProps = OpenProps & {
  /** The environments a session can be started on: those that are connected. */
  environments: EnvironmentConfig[];
  /** Where it starts unless the person says: the environment of the session that is open, else the first. */
  defaultEnvironment: string | undefined;
  /** The folder it starts in unless the person says: the workspace that is shown. */
  defaultCwd?: string | undefined;
  agents: Record<string, AgentInfo[]>;
  readDefaults: (
    environmentId: string,
    agent: string,
  ) => Promise<Record<string, string> | undefined>;
  /** Opens this computer's folder chooser: only what is on this computer can be chosen with it. */
  chooseDirectory: () => Promise<string | undefined>;
  onCreate: (
    environmentId: string,
    params: {
      cwd: string;
      agent: string;
      config: Record<string, string>;
    },
  ) => void | Promise<void>;
};

export function NewSessionDialog({
  open,
  onOpenChange,
  environments,
  defaultEnvironment,
  defaultCwd,
  agents,
  readDefaults,
  chooseDirectory,
  onCreate,
}: NewSessionProps) {
  const { t } = useI18n();
  const [chosenEnvironment, setChosenEnvironment] = useState<string | null>(null);
  const environment =
    environments.find((h) => h.id === chosenEnvironment) ??
    environments.find((h) => h.id === defaultEnvironment) ??
    environments[0];
  const environmentId = environment?.id;
  const available = (environmentId !== undefined ? (agents[environmentId] ?? []) : []).filter(
    (a) => a.available,
  );
  const [cwd, setCwd] = useState("");
  // The agent that was picked, and for which environment: another environment has other agents, so the pick does not carry over.
  const [picked, setPicked] = useState<{ environmentId: string; agentId: string } | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const agent =
    available.find(
      (a) => picked !== null && picked.environmentId === environmentId && a.id === picked.agentId,
    ) ?? available[0];

  // Each time it opens it starts again from where the person is; and another environment has other agents.
  // The folder it starts in is read as it opens: a workspace that changes under an open dialog does not rewrite what is typed.
  const startCwd = useRef(defaultCwd);
  startCwd.current = defaultCwd;
  const startEnvironment = useRef(defaultEnvironment);
  startEnvironment.current = defaultEnvironment;
  useEffect(() => {
    if (!open) return;
    setChosenEnvironment(startEnvironment.current ?? null);
    setCwd(startCwd.current ?? "");
  }, [open]);

  // Start each session from what the user set as the agent's defaults, on that environment.
  const agentKey = agent?.id;
  useEffect(() => {
    if (!open || environmentId === undefined || agentKey === undefined) return;
    let current = true;
    void readDefaults(environmentId, agentKey).then((defaults) => {
      if (current) setConfig(defaults ?? {});
    });
    return () => {
      current = false;
    };
  }, [open, environmentId, agentKey, readDefaults]);

  const create = async () => {
    if (environmentId === undefined || agent === undefined || cwd.trim() === "") return;
    await onCreate(environmentId, { cwd: cwd.trim(), agent: agent.id, config });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>New session</DialogTitle>
        <DialogDescription>
          {environment !== undefined && environments.length > 1
            ? t("newSession.onHost", { host: environment.name })
            : "The agent works in this directory, on the host you are connected to."}
        </DialogDescription>
        <div data-slot="stack">
          {environments.length > 1 ? (
            <Field name="host">
              <FieldLabel>{t("newSession.host")}</FieldLabel>
              <Select
                items={environments.map((h) => ({ value: h.id, label: h.name }))}
                value={environmentId ?? null}
                onValueChange={(next) => {
                  // A folder and settings of one environment mean nothing on another.
                  setChosenEnvironment(next as string | null);
                  setCwd("");
                  setConfig({});
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field name="cwd">
            <FieldLabel>Directory</FieldLabel>
            <div data-slot="row">
              <Input
                value={cwd}
                placeholder="/path/to/project"
                onChange={(e) => setCwd(e.currentTarget.value)}
              />
              {environment?.kind === "local" ? (
                <Button
                  data-variant="outline"
                  onClick={async () => {
                    const chosen = await chooseDirectory();
                    if (chosen !== undefined) setCwd(chosen);
                  }}
                >
                  Browse…
                </Button>
              ) : null}
            </div>
          </Field>
          {available.length > 1 ? (
            <Field name="agent">
              <FieldLabel>Agent</FieldLabel>
              <Select
                items={available.map((a) => ({ value: a.id, label: a.name }))}
                value={agent?.id ?? null}
                onValueChange={(next) => {
                  if (environmentId !== undefined && typeof next === "string")
                    setPicked({ environmentId, agentId: next });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {available.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {agent !== undefined ? (
            <ConfigForm schema={agent.configSchema} value={config} onChange={setConfig} />
          ) : null}
          {agent === undefined ? <p data-slot="hint">No agent is available on this host.</p> : null}
        </div>
        <div data-slot="row">
          <DialogClose>Cancel</DialogClose>
          <Button
            data-variant="solid"
            disabled={agent === undefined || cwd.trim() === ""}
            onClick={create}
          >
            Start
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const save = async () => {
    if (host.trim() === "") return;
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
        <DialogTitle>Add a host</DialogTitle>
        <DialogDescription>
          Cycle connects with your system's ssh, so your keys and ~/.ssh/config apply. There is no
          password prompt.
        </DialogDescription>
        <div data-slot="stack">
          <Field name="host">
            <FieldLabel>Host</FieldLabel>
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
            <FieldLabel>Command on the host</FieldLabel>
            <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          </Field>
        </div>
        <div data-slot="row">
          <DialogClose>Cancel</DialogClose>
          <Button data-variant="solid" disabled={host.trim() === ""} onClick={save}>
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
  useEffect(() => {
    if (!open || agentKey === undefined) return;
    let current = true;
    void read(agentKey).then((defaults) => {
      if (current) setConfig(defaults ?? {});
    });
    return () => {
      current = false;
    };
  }, [open, agentKey, read]);
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
          {agent !== undefined ? (
            <ConfigForm schema={agent.configSchema} value={config} onChange={setConfig} />
          ) : null}
        </div>
        <div data-slot="row">
          <DialogClose>Close</DialogClose>
          <Button
            data-variant="solid"
            disabled={agent === undefined}
            onClick={async () => {
              if (agent !== undefined) await onSave(agent.id, config);
              onOpenChange(false);
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
