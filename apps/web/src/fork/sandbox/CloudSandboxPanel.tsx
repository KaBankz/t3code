import type {
  SandboxProviderKind,
  SandboxProviderSummary,
  SandboxStatus,
  SandboxView,
} from "@t3tools/fork-sandbox/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CloudIcon, CopyIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { parseRemotePairingFields } from "~/components/settings/ConnectionsSettings.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { environmentCatalog } from "~/connection/catalog";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { sandboxApi, sandboxListAtom } from "./api";
import { parseEnvironmentVariables } from "./environmentVariables";

const STATUS_BADGE: Record<
  SandboxStatus,
  { readonly label: string; readonly variant: "success" | "warning" | "error" | "outline" }
> = {
  running: { label: "Running", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
  stopped: { label: "Stopped", variant: "warning" },
  missing: { label: "Gone", variant: "error" },
  unknown: { label: "Unknown", variant: "outline" },
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The sandbox request failed.";

/**
 * Creates and manages sandboxes on the primary server, then pairs each one as an
 * ordinary remote environment, so everything after pairing is stock t3.
 */
export function CloudSandboxPanel({
  onConnected,
}: {
  readonly onConnected: (label: string) => void;
}) {
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const sandboxes = useEnvironmentQuery(sandboxListAtom);
  const state = sandboxes.data;
  const [selectedKind, setSelectedKind] = useState<SandboxProviderKind>("e2b");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [installClaudeCode, setInstallClaudeCode] = useState(true);
  const [environmentText, setEnvironmentText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Pairing link copied",
        description: "Open it on the device you want to connect. It works once.",
      });
    },
  });

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
      sandboxes.refresh();
    }
  };

  const pairWithThisClient = async (pairingUrl: string, sandbox: SandboxView) => {
    const result = await connectPairing({
      ...parseRemotePairingFields({ host: pairingUrl, pairingCode: "" }),
      ...(sandbox.environmentId ? { expectedEnvironmentId: sandbox.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      throw new Error(errorMessage(squashAtomCommandFailure(result)));
    }
    onConnected(sandbox.label);
  };

  const provider = state?.providers.find((entry) => entry.kind === selectedKind);
  const isBusy = busy !== null;

  const saveCredentials = (summary: SandboxProviderSummary) =>
    runAction("credentials", async () => {
      await sandboxApi.setCredentials(summary.kind, credentialValues);
      setCredentialValues({});
    });

  const createSandbox = (summary: SandboxProviderSummary) =>
    runAction("create", async () => {
      const result = await sandboxApi.create({
        provider: summary.kind,
        ...(label.trim() ? { label: label.trim() } : {}),
        installClaudeCode,
        environment: parseEnvironmentVariables(environmentText),
      });
      setLabel("");
      setEnvironmentText("");
      await pairWithThisClient(result.pairingUrl, result.sandbox);
    });

  const destroySandbox = (sandbox: SandboxView) =>
    runAction(`destroy:${sandbox.id}`, async () => {
      setConfirmingDeleteId(null);
      const removed = await sandboxApi.destroy(sandbox.id);
      // The sandbox's server is gone with it, so its saved connection can only fail.
      if (removed.environmentId) await removeEnvironment(removed.environmentId);
      toastManager.add({ type: "success", title: "Sandbox deleted", description: removed.label });
    });

  const renderCredentials = (summary: SandboxProviderSummary) => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {summary.fields.map((field) => (
          <label key={field.name} className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">{field.label}</span>
            <Input
              type={field.secret ? "password" : "text"}
              value={credentialValues[field.name] ?? ""}
              onChange={(event) =>
                setCredentialValues((values) => ({ ...values, [field.name]: event.target.value }))
              }
              placeholder={field.configured ? "Saved" : field.environmentVariable}
              disabled={isBusy}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-2xs text-muted-foreground">
          Saved in this machine's secret store. Server environment variables work too.
        </span>
        <div className="flex gap-2">
          {summary.fields.some((field) => field.configured) ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={isBusy}
              onClick={() =>
                void runAction("credentials", async () => {
                  await sandboxApi.clearCredentials(summary.kind);
                })
              }
            >
              Forget
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={isBusy || Object.values(credentialValues).every((value) => !value.trim())}
            onClick={() => void saveCredentials(summary)}
          >
            Save credentials
          </Button>
        </div>
      </div>
    </div>
  );

  const renderCreateForm = (summary: SandboxProviderSummary) => (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={`${summary.label} sandbox`}
          disabled={isBusy}
          spellCheck={false}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">
          Environment variables
        </span>
        <Textarea
          value={environmentText}
          onChange={(event) => setEnvironmentText(event.target.value)}
          placeholder={"ANTHROPIC_API_KEY=sk-ant-…\nGH_TOKEN=…"}
          disabled={isBusy}
          spellCheck={false}
          rows={3}
        />
        <span className="mt-1 block text-2xs text-muted-foreground">
          Set inside the sandbox for agents and git. They are not saved on this machine.
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          className="mt-0.5"
          checked={installClaudeCode}
          disabled={isBusy}
          onCheckedChange={(checked) => setInstallClaudeCode(checked === true)}
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">Install Claude Code</span>
          <span className="block text-xs leading-snug text-muted-foreground">
            Codex installs itself from the sandbox's provider settings.
          </span>
        </span>
      </label>
      <p className="text-2xs text-muted-foreground">{summary.lifecycle}</p>
      <Button
        variant="outline"
        className="w-full"
        disabled={isBusy}
        onClick={() => void createSandbox(summary)}
      >
        {busy === "create" ? <Spinner /> : <PlusIcon className="size-3.5" />}
        {busy === "create" ? "Creating sandbox… this takes a minute or two" : "Create sandbox"}
      </Button>
    </div>
  );

  const renderSandbox = (sandbox: SandboxView) => {
    const badge = STATUS_BADGE[sandbox.status];
    const providerLabel =
      state?.providers.find((entry) => entry.kind === sandbox.provider)?.label ?? sandbox.provider;
    return (
      <li key={sandbox.id} className="flex items-center gap-3 px-3 py-2.5">
        <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{sandbox.label}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <span className="block truncate text-xs text-muted-foreground">
            {providerLabel} · t3 {sandbox.t3Version} · {sandbox.httpBaseUrl}
          </span>
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={isBusy || sandbox.status === "missing"}
          onClick={() =>
            void runAction(`pair:${sandbox.id}`, async () => {
              const result = await sandboxApi.pair(sandbox.id);
              await pairWithThisClient(result.pairingUrl, result.sandbox);
            })
          }
        >
          {busy === `pair:${sandbox.id}` ? <Spinner /> : <PlayIcon className="size-3" />}
          Connect
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Copy a pairing link for another device"
          disabled={isBusy || sandbox.status === "missing"}
          onClick={() =>
            void runAction(`link:${sandbox.id}`, async () => {
              copyToClipboard((await sandboxApi.pair(sandbox.id)).pairingUrl);
            })
          }
        >
          {busy === `link:${sandbox.id}` ? <Spinner /> : <CopyIcon className="size-3" />}
        </Button>
        <Button
          size="xs"
          variant="ghost-destructive"
          aria-label="Delete sandbox"
          disabled={isBusy}
          onClick={() =>
            confirmingDeleteId === sandbox.id
              ? void destroySandbox(sandbox)
              : setConfirmingDeleteId(sandbox.id)
          }
        >
          {busy === `destroy:${sandbox.id}` ? <Spinner /> : <Trash2Icon className="size-3" />}
          {confirmingDeleteId === sandbox.id ? "Delete" : null}
        </Button>
      </li>
    );
  };

  if (state === null) {
    return sandboxes.error ? (
      <Alert variant="error">
        <AlertDescription>{sandboxes.error}</AlertDescription>
      </Alert>
    ) : (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ToggleGroup
        aria-label="Sandbox provider"
        variant="segmented"
        value={[selectedKind]}
        onValueChange={(next) => {
          const kind = state.providers.find((entry) => entry.kind === next[0])?.kind;
          if (kind) {
            setSelectedKind(kind);
            setCredentialValues({});
          }
        }}
      >
        {state.providers.map((entry) => (
          <Toggle key={entry.kind} value={entry.kind}>
            {entry.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {provider ? (provider.configured ? renderCreateForm(provider) : null) : null}
      {provider ? renderCredentials(provider) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {state.sandboxes.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-lg border border-input">
          {state.sandboxes.map(renderSandbox)}
        </ul>
      ) : null}
    </div>
  );
}
