import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Textarea } from "@ui-sdk/react/textarea";
import { useEffect, useState } from "react";
import type {
  ConnectorDraft,
  ConnectorInfo,
  ConnectorProblem,
  ConnectorSecrets,
  EnvironmentConfig,
  EnvironmentStatus,
} from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

type Problem = { problem: ConnectorProblem; message?: string | undefined };
type Answer = { connector: ConnectorInfo } | Problem | { cancelled: true };
type Pending = Promise<Answer>;
type Act = () => Pending;

export type ConnectorsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  /** The environment to show first, when it can keep connectors. */
  environmentId?: string | undefined;
};

/** The MCP servers an environment's daemon keeps for every agent (docs/protocol.md §14). */
export function ConnectorsDialog(props: ConnectorsDialogProps) {
  const { t } = useI18n();
  const able = props.environments.filter(
    (h) =>
      props.status[h.id]?.state === "connected" &&
      props.status[h.id]?.capabilities?.connectors === true,
  );
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const environment =
    able.find((h) => h.id === chosen) ?? able.find((h) => h.id === props.environmentId) ?? able[0];
  const [editing, setEditing] = useState<ConnectorInfo | "new" | undefined>(undefined);
  useEffect(() => {
    if (props.open) return;
    setEditing(undefined);
    setChosen(undefined);
  }, [props.open]);
  return (
    <Dialog open={props.open} onOpenChange={(next) => props.onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent data-kind="connectors">
        <DialogTitle>
          {editing === undefined
            ? t("connectors.title")
            : editing === "new"
              ? t("connectors.form.addTitle")
              : t("connectors.form.editTitle", { name: editing.name })}
        </DialogTitle>
        {environment === undefined ? (
          <>
            <p data-slot="hint">{t("connectors.none")}</p>
            <div data-slot="row" data-dialog-footer="">
              <DialogClose>{t("common.close")}</DialogClose>
            </div>
          </>
        ) : editing !== undefined ? (
          <ConnectorForm
            environment={environment}
            editing={editing === "new" ? undefined : editing}
            onDone={() => setEditing(undefined)}
          />
        ) : (
          <>
            <DialogDescription>
              {t("connectors.lead", { environment: environment.name })}
            </DialogDescription>
            {able.length > 1 ? (
              <Field name="environment">
                <FieldLabel>{t("connectors.environment")}</FieldLabel>
                <Select
                  items={able.map((h) => ({ value: h.id, label: h.name }))}
                  value={environment.id}
                  onValueChange={(next) => setChosen((next as string | null) ?? undefined)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {able.map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <ConnectorList
              key={environment.id}
              environment={environment}
              onEdit={(connector) => setEditing(connector)}
            />
            <div data-slot="row" data-dialog-footer="">
              <DialogClose>{t("common.close")}</DialogClose>
              <Button data-variant="solid" onClick={() => setEditing("new")}>
                {t("connectors.add")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const useProblemText = (environment: EnvironmentConfig) => {
  const { t } = useI18n();
  return (p: Problem) =>
    t(`connectors.problem.${p.problem}`, {
      environment: environment.name,
      reason: p.message ?? "",
    });
};

/** Where a connector is: the host of its URL, or the command it runs. Never a secret: those are not here at all. */
const whereOf = (connector: ConnectorInfo): string => {
  if (connector.transport.type === "stdio")
    return [connector.transport.command, ...connector.transport.args].join(" ");
  try {
    return new URL(connector.transport.url).host;
  } catch {
    return connector.transport.url;
  }
};

function ConnectorList(props: {
  environment: EnvironmentConfig;
  onEdit: (connector: ConnectorInfo) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(props.environment);
  const environmentId = props.environment.id;
  const read = useAppState((s) => s.connectors[environmentId]);
  const list = read?.list;
  /** What went wrong with one connector, shown under its row. */
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [waiting, setWaiting] = useState<ConnectorInfo | undefined>(undefined);
  const [signedIn, setSignedIn] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<ConnectorInfo | undefined>(undefined);

  useEffect(() => {
    void store.loadConnectors(environmentId);
  }, [store, environmentId]);

  const act = async (connector: ConnectorInfo, action: Act) => {
    setBusy((b) => ({ ...b, [connector.id]: true }));
    setProblems(({ [connector.id]: _gone, ...rest }) => rest);
    try {
      const answer = await action();
      if ("problem" in answer) setProblems((p) => ({ ...p, [connector.id]: answer }));
      return answer;
    } finally {
      setBusy(({ [connector.id]: _gone, ...rest }) => rest);
    }
  };

  const signIn = async (connector: ConnectorInfo) => {
    setWaiting(connector);
    setSignedIn(undefined);
    const answer = await act(connector, () =>
      store.authorizeConnector(environmentId, connector.id),
    );
    setWaiting((w) => (w?.id === connector.id ? undefined : w));
    if ("connector" in answer) setSignedIn(connector.name);
  };

  const unreadable =
    read?.error !== undefined ? (
      <div data-slot="row" role="alert">
        <span data-slot="hint">{t("connectors.unreadable", { reason: read.error })}</span>
        <Button onClick={() => void store.loadConnectors(environmentId)}>
          {t("connectors.retry")}
        </Button>
      </div>
    ) : null;
  if (list === undefined) return unreadable ?? <p data-slot="hint">{t("connectors.loading")}</p>;
  return (
    <div data-slot="stack">
      {unreadable}
      {waiting !== undefined ? (
        <div data-slot="row" role="status">
          <span data-slot="hint">{t("connectors.waiting", { name: waiting.name })}</span>
          <Button onClick={() => void store.cancelConnectorAuth()}>
            {t("connectors.stopWaiting")}
          </Button>
        </div>
      ) : signedIn !== undefined ? (
        <p data-slot="hint" role="status">
          {t("connectors.signedIn", { name: signedIn })}
        </p>
      ) : null}
      {list.length === 0 ? (
        <p data-slot="hint">{t("connectors.empty")}</p>
      ) : (
        <ul data-slot="connector-list">
          {list.map((connector) => {
            const oauth = connector.auth.type === "oauth";
            const problem = problems[connector.id];
            return (
              <li key={connector.id} data-slot="connector" data-off={!connector.enabled}>
                <div data-slot="connector-row">
                  <div data-slot="connector-text">
                    <span data-slot="connector-name">{connector.name}</span>
                    <span data-slot="connector-where" title={whereOf(connector)}>
                      {whereOf(connector)}
                    </span>
                    <span data-slot="connector-status" data-state={connector.status.state}>
                      {statusWord(t, connector)}
                    </span>
                  </div>
                  {oauth && connector.enabled && connector.status.state === "needs_auth" ? (
                    <Button
                      disabled={busy[connector.id] === true}
                      onClick={() => void signIn(connector)}
                    >
                      {t("connectors.signIn")}
                    </Button>
                  ) : null}
                  <Switch
                    aria-label={t("connectors.use", { name: connector.name })}
                    checked={connector.enabled}
                    disabled={busy[connector.id] === true}
                    onCheckedChange={(enabled) =>
                      void act(connector, () =>
                        store.updateConnector(environmentId, connector.id, { enabled }),
                      )
                    }
                  >
                    <SwitchThumb />
                  </Switch>
                  <Menu
                    onAction={(value) => {
                      if (value === "edit") props.onEdit(connector);
                      else if (value === "sign-out")
                        void act(connector, () =>
                          store.signOutConnector(environmentId, connector.id),
                        );
                      else if (value === "remove") setRemoving(connector);
                    }}
                  >
                    <Tip label={t("connectors.actions", { name: connector.name })}>
                      <MenuTrigger data-variant="ghost">
                        <MoreIcon />
                      </MenuTrigger>
                    </Tip>
                    <MenuContent>
                      <MenuItem value="edit">{t("connectors.edit")}</MenuItem>
                      {oauth && connector.authorized ? (
                        <MenuItem value="sign-out">{t("connectors.signOut")}</MenuItem>
                      ) : null}
                      <MenuItem value="remove">{t("connectors.remove")}</MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
                {problem !== undefined ? (
                  <p data-slot="hint" role="alert">
                    {problemText(problem)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("connectors.removeTitle", { name: removing.name })}
          description={t("connectors.removeDescription")}
          confirmLabel={t("connectors.removeConfirm")}
          destructive
          onConfirm={async () => {
            const target = removing;
            const answer = await store.removeConnector(environmentId, target.id);
            if ("problem" in answer) return problemText(answer);
            return undefined;
          }}
        />
      ) : null}
    </div>
  );
}

const statusWord = (
  t: (key: string, params?: Record<string, string>) => string,
  connector: ConnectorInfo,
): string => {
  const { state, reason } = connector.status;
  if (state === "error")
    return reason !== undefined ? t(`connectors.status.${reason}`) : t("connectors.status.error");
  return t(`connectors.status.${state}`);
};

type SecretKind = "headers" | "env";
type NewSecret = { key: number; name: string; value: string };

function ConnectorForm(props: {
  environment: EnvironmentConfig;
  editing: ConnectorInfo | undefined;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(props.environment);
  const before = props.editing;
  const [name, setName] = useState(before?.name ?? "");
  const [kind, setKind] = useState<"http" | "stdio">(before?.transport.type ?? "http");
  const [url, setUrl] = useState(before?.transport.type === "http" ? before.transport.url : "");
  const [command, setCommand] = useState(
    before?.transport.type === "stdio" ? before.transport.command : "",
  );
  const [args, setArgs] = useState(
    before?.transport.type === "stdio" ? before.transport.args.join("\n") : "",
  );
  const [cwd, setCwd] = useState(
    before?.transport.type === "stdio" ? (before.transport.cwd ?? "") : "",
  );
  const [auth, setAuth] = useState<"none" | "oauth">(before?.auth.type ?? "none");
  const [clientId, setClientId] = useState(
    before?.auth.type === "oauth" ? (before.auth.clientId ?? "") : "",
  );
  const secretKind: SecretKind = kind === "http" ? "headers" : "env";
  /** Names kept that are to be removed on save. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<NewSecret[]>([]);
  const [counter, setCounter] = useState(0);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const kept = before?.secrets[secretKind] ?? [];

  const draft = (): ConnectorDraft => {
    const secrets: Record<string, string | null> = {};
    for (const removed of dropped) secrets[removed] = null;
    for (const pair of added)
      if (pair.name.trim() !== "" && pair.value !== "") secrets[pair.name.trim()] = pair.value;
    const written: ConnectorSecrets | undefined =
      Object.keys(secrets).length > 0 ? { [secretKind]: secrets } : undefined;
    return {
      name: name.trim(),
      transport:
        kind === "http"
          ? { type: "http", url: url.trim() }
          : {
              type: "stdio",
              command: command.trim(),
              args: args
                .split("\n")
                .map((a) => a.trim())
                .filter((a) => a !== ""),
              ...(cwd.trim() !== "" ? { cwd: cwd.trim() } : {}),
            },
      auth:
        kind === "http" && auth === "oauth"
          ? {
              type: "oauth",
              ...(clientId.trim() !== "" ? { clientId: clientId.trim() } : {}),
              // Scopes have no field here: what the connector has is kept, not dropped by an edit.
              ...(before?.auth.type === "oauth" && before.auth.scopes !== undefined
                ? { scopes: before.auth.scopes }
                : {}),
            }
          : { type: "none" },
      ...(written !== undefined ? { secrets: written } : {}),
    };
  };

  const ready = name.trim() !== "" && (kind === "http" ? url.trim() !== "" : command.trim() !== "");

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const answer =
        before === undefined
          ? await store.addConnector(props.environment.id, draft())
          : await store.updateConnector(props.environment.id, before.id, draft());
      if ("connector" in answer) props.onDone();
      else setProblem(answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-slot="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field name="name">
        <FieldLabel>{t("connectors.form.name")}</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <FieldDescription>{t("connectors.form.nameHint")}</FieldDescription>
      </Field>
      <Field name="transport">
        <FieldLabel>{t("connectors.form.transport")}</FieldLabel>
        <SegmentedControl
          value={kind}
          onValueChange={(next) => {
            if (next === "http" || next === "stdio") setKind(next);
          }}
        >
          <SegmentedControlIndicator />
          <SegmentedControlItem value="http">
            {t("connectors.form.transport.http")}
          </SegmentedControlItem>
          <SegmentedControlItem value="stdio">
            {t("connectors.form.transport.stdio")}
          </SegmentedControlItem>
        </SegmentedControl>
      </Field>
      {kind === "http" ? (
        <>
          <Field name="url">
            <FieldLabel>{t("connectors.form.url")}</FieldLabel>
            <Input
              value={url}
              placeholder="https://"
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
          </Field>
          <Field name="auth">
            <FieldLabel>{t("connectors.form.auth")}</FieldLabel>
            <SegmentedControl
              value={auth}
              onValueChange={(next) => {
                if (next === "none" || next === "oauth") setAuth(next);
              }}
            >
              <SegmentedControlIndicator />
              <SegmentedControlItem value="none">
                {t("connectors.form.auth.none")}
              </SegmentedControlItem>
              <SegmentedControlItem value="oauth">
                {t("connectors.form.auth.oauth")}
              </SegmentedControlItem>
            </SegmentedControl>
          </Field>
          {auth === "oauth" ? (
            <Field name="clientId">
              <FieldLabel>{t("connectors.form.clientId")}</FieldLabel>
              <Input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
              <FieldDescription>{t("connectors.form.clientIdHint")}</FieldDescription>
            </Field>
          ) : null}
        </>
      ) : (
        <>
          <Field name="command">
            <FieldLabel>{t("connectors.form.command")}</FieldLabel>
            <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          </Field>
          <Field name="args">
            <FieldLabel>{t("connectors.form.args")}</FieldLabel>
            <Textarea value={args} rows={3} onChange={(e) => setArgs(e.currentTarget.value)} />
          </Field>
          <Field name="cwd">
            <FieldLabel>{t("connectors.form.cwd")}</FieldLabel>
            <Input value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} />
            <FieldDescription>{t("connectors.form.cwdHint")}</FieldDescription>
          </Field>
        </>
      )}
      <fieldset data-slot="secrets">
        <legend>{t(kind === "http" ? "connectors.form.headers" : "connectors.form.env")}</legend>
        <p data-slot="hint">
          {t("connectors.form.secretsHint", { environment: props.environment.name })}
        </p>
        {kept.map((secret) => {
          const gone = dropped.has(secret);
          return (
            <div key={secret} data-slot="row">
              <span data-slot="secret-name" data-removed={gone}>
                {t(gone ? "connectors.form.secretRemoving" : "connectors.form.secretSet", {
                  name: secret,
                })}
              </span>
              <Button
                type="button"
                data-variant="ghost"
                onClick={() =>
                  setDropped((set) => {
                    const next = new Set(set);
                    if (gone) next.delete(secret);
                    else next.add(secret);
                    return next;
                  })
                }
              >
                {t(gone ? "connectors.form.secretKeep" : "connectors.form.secretRemove", {
                  name: secret,
                })}
              </Button>
            </div>
          );
        })}
        {added.map((pair) => (
          <div key={pair.key} data-slot="row">
            <Input
              aria-label={t("connectors.form.secretName")}
              placeholder={t("connectors.form.secretName")}
              value={pair.name}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setAdded((list) =>
                  list.map((p) => (p.key === pair.key ? { ...p, name: value } : p)),
                );
              }}
            />
            <Input
              type="password"
              autoComplete="off"
              aria-label={t("connectors.form.secretValue")}
              placeholder={t("connectors.form.secretValue")}
              value={pair.value}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setAdded((list) => list.map((p) => (p.key === pair.key ? { ...p, value } : p)));
              }}
            />
          </div>
        ))}
        <div data-slot="row">
          <Button
            type="button"
            data-variant="ghost"
            onClick={() => {
              setAdded((list) => [...list, { key: counter, name: "", value: "" }]);
              setCounter((n) => n + 1);
            }}
          >
            {t("connectors.form.secretAdd")}
          </Button>
        </div>
      </fieldset>
      {problem !== undefined ? (
        <p data-slot="hint" role="alert">
          {problemText(problem)}
        </p>
      ) : null}
      <div data-slot="row" data-dialog-footer="">
        <Button type="button" onClick={props.onDone}>
          {t("connectors.form.back")}
        </Button>
        <Button data-variant="solid" type="submit" disabled={!ready || busy}>
          {t(before === undefined ? "connectors.form.create" : "connectors.form.save")}
        </Button>
      </div>
    </form>
  );
}
