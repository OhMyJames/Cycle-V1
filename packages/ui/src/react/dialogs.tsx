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
import type {
  AgentInfo,
  AppApi,
  EnvironmentConfig,
  EnvironmentStatus,
  FolderListing,
} from "../api.ts";
import { ConfigForm } from "./config-form.tsx";
import { FolderBrowser } from "./folder-browser.tsx";
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
  /** The folders in a folder on an environment's machine: for an environment that is not this computer. */
  listFolders: (environmentId: string, path?: string, hidden?: boolean) => Promise<FolderListing>;
  /** How each environment stands, and what its daemon can do. */
  status: Record<string, EnvironmentStatus>;
  /** Folder trust on an environment's machine (docs/protocol.md §8 "信任文件夹"): asked before a session starts in a folder nobody has decided on. */
  readTrust: AppApi["readTrust"];
  setTrust: AppApi["setTrust"];
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
  listFolders,
  status,
  readTrust,
  setTrust,
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
  // Choosing the folder on another environment's machine takes the place of the form until it is chosen or left.
  const [browsing, setBrowsing] = useState(false);
  // The real path of a folder nobody has decided on: whether to trust it takes the place of the form until answered or left.
  const [asking, setAsking] = useState<string | null>(null);
  // Why the answer about the folder could not be kept: nothing is started then, and the question stays.
  const [trustFailed, setTrustFailed] = useState<string | null>(null);
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
    setBrowsing(false);
    setAsking(null);
    setTrustFailed(null);
    setCwd(startCwd.current ?? "");
  }, [open]);

  // Start each session from what the user set as the agent's defaults, on that environment.
  const agentKey = agent?.id;
  // What `config` is the defaults of: until it is the defaults of the agent and environment shown, it is not what a session
  // starts with (another agent's settings are not this one's).
  const [loaded, setLoaded] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const defaultsKey = `${environmentId}/${agentKey}`;
  useEffect(() => {
    if (!open || environmentId === undefined || agentKey === undefined) return;
    let current = true;
    setLoaded(null);
    setUnread(false);
    setConfig({});
    readDefaults(environmentId, agentKey).then(
      (defaults) => {
        if (!current) return;
        setConfig(defaults ?? {});
        setLoaded(`${environmentId}/${agentKey}`);
      },
      () => {
        // Not "nothing saved": a session started from an empty form would not start from what the person set.
        if (current) setUnread(true);
      },
    );
    return () => {
      current = false;
    };
  }, [open, environmentId, agentKey, readDefaults]);
  // Closed, it keeps nothing: opened again, it is not the form of the time before for a moment.
  useEffect(() => {
    if (open) return;
    setLoaded(null);
    setUnread(false);
    setConfig({});
  }, [open]);

  const [busy, setBusy] = useState(false);
  /** Starts the session; with an answer about the folder, records it first. */
  const start = async (trusted?: boolean) => {
    if (busy || loaded !== defaultsKey) return;
    if (environmentId === undefined || agent === undefined || cwd.trim() === "") return;
    setBusy(true);
    try {
      if (trusted !== undefined && asking !== null) {
        setTrustFailed(null);
        try {
          await setTrust(environmentId, asking, trusted);
        } catch (error) {
          setTrustFailed(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      await onCreate(environmentId, { cwd: cwd.trim(), agent: agent.id, config });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (busy || loaded !== defaultsKey) return;
    if (environmentId === undefined || agent === undefined || cwd.trim() === "") return;
    if (status[environmentId]?.capabilities?.trust === true) {
      setBusy(true);
      // A folder that cannot be looked at is not asked about: starting there fails with the daemon's reason.
      const trust = await readTrust(environmentId, cwd.trim()).catch(() => undefined);
      setBusy(false);
      // Nobody has decided: the person is asked before anything of the folder's own runs.
      if (trust?.trusted === null) {
        setAsking(trust.path);
        return;
      }
    }
    await start();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        {asking !== null ? (
          <>
            <DialogTitle>{t("trust.title")}</DialogTitle>
            <DialogDescription>
              {t("trust.description", { environment: environment?.name ?? "" })}
            </DialogDescription>
            <code data-slot="decision-path">{asking}</code>
            {trustFailed !== null ? (
              <p data-slot="hint" role="alert">
                {t("trust.failed", { reason: trustFailed })}
              </p>
            ) : null}
            <div data-slot="row">
              <Button
                data-variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAsking(null);
                  setTrustFailed(null);
                }}
              >
                {t("trust.back")}
              </Button>
              <Button data-variant="outline" disabled={busy} onClick={() => void start(false)}>
                {t("trust.startUntrusted")}
              </Button>
              <Button data-variant="solid" disabled={busy} onClick={() => void start(true)}>
                {t("trust.startTrusted")}
              </Button>
            </div>
          </>
        ) : browsing && environmentId !== undefined ? (
          <>
            <DialogTitle>{t("folders.title")}</DialogTitle>
            <FolderBrowser
              start={cwd.startsWith("/") ? cwd : undefined}
              list={(path, hidden) => listFolders(environmentId, path, hidden)}
              onChoose={(path) => {
                setCwd(path);
                setBrowsing(false);
              }}
              onBack={() => setBrowsing(false)}
            />
          </>
        ) : (
          <>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>
              {environment !== undefined && environments.length > 1
                ? t("newSession.onEnvironment", { environment: environment.name })
                : "The agent works in this directory, on the environment you are connected to."}
            </DialogDescription>
            <div data-slot="stack">
              {environments.length > 1 ? (
                <Field name="host">
                  <FieldLabel>{t("newSession.environment")}</FieldLabel>
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
                      {t("newSession.browse")}
                    </Button>
                  ) : status[environmentId ?? ""]?.capabilities?.folders === true ? (
                    <Button data-variant="outline" onClick={() => setBrowsing(true)}>
                      {t("newSession.browse")}
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
              {agent !== undefined && loaded === defaultsKey ? (
                <ConfigForm schema={agent.configSchema} value={config} onChange={setConfig} />
              ) : null}
              {unread ? <p data-slot="hint">{t("defaults.unreadable")}</p> : null}
              {agent === undefined ? (
                <p data-slot="hint">No agent is available on this environment.</p>
              ) : null}
            </div>
            <div data-slot="row">
              <DialogClose>{t("common.cancel")}</DialogClose>
              <Button
                data-variant="solid"
                disabled={
                  agent === undefined || cwd.trim() === "" || loaded !== defaultsKey || busy
                }
                onClick={create}
              >
                Start
              </Button>
            </div>
          </>
        )}
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
