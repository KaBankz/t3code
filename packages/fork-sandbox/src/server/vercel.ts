import { APIError, Sandbox } from "@vercel/sandbox";

import type { SandboxStatus } from "../contracts.ts";
import type { SandboxCredentials, SandboxMachine, SandboxProviderAdapter } from "./provider.ts";

// Hobby teams cap a session at 45 minutes. The sandbox is persistent, so the
// filesystem, including t3's state and pairings, outlives the session.
const SESSION_TIMEOUT_MS = 45 * 60_000;

const apiOptions = (credentials: SandboxCredentials) => ({
  token: credentials.token ?? "",
  teamId: credentials.teamId ?? "",
  projectId: credentials.projectId ?? "",
});

const isNotFound = (error: unknown) => error instanceof APIError && error.response.status === 404;

function toMachine(sandbox: Sandbox, port: number): SandboxMachine {
  return {
    providerSandboxId: sandbox.name,
    publicUrl: sandbox.domain(port),
    run: async (script, timeoutMs) => {
      const result = await sandbox.runCommand({ cmd: "sh", args: ["-c", script], timeoutMs });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return { exitCode: result.exitCode, stdout, stderr };
    },
    spawn: async (script) => {
      await sandbox.runCommand({ cmd: "sh", args: ["-c", script], detached: true });
    },
  };
}

function toStatus(status: Sandbox["status"]): SandboxStatus {
  switch (status) {
    case "running":
    case "pending":
      return "running";
    case "stopping":
    case "stopped":
    case "snapshotting":
      return "stopped";
    default:
      return "unknown";
  }
}

export const vercelAdapter: SandboxProviderAdapter = {
  kind: "vercel",
  label: "Vercel Sandbox",
  lifecycle: "Stops after 45 minutes and keeps its files. Starting it again restarts t3.",
  credentialFields: [
    { name: "token", label: "Access token", environmentVariable: "VERCEL_TOKEN", secret: true },
    { name: "teamId", label: "Team ID", environmentVariable: "VERCEL_TEAM_ID", secret: false },
    {
      name: "projectId",
      label: "Project ID",
      environmentVariable: "VERCEL_PROJECT_ID",
      secret: false,
    },
  ],
  create: async (credentials, options) =>
    toMachine(
      await Sandbox.create({
        ...apiOptions(credentials),
        ports: [options.port],
        timeout: SESSION_TIMEOUT_MS,
        persistent: true,
        resources: { vcpus: 2 },
        env: { ...options.environment },
        tags: { ...options.metadata },
      }),
      options.port,
    ),
  connect: async (credentials, providerSandboxId, port) =>
    toMachine(
      await Sandbox.get({ ...apiOptions(credentials), name: providerSandboxId, resume: true }),
      port,
    ),
  status: async (credentials, providerSandboxId) => {
    try {
      const sandbox = await Sandbox.get({ ...apiOptions(credentials), name: providerSandboxId });
      return toStatus(sandbox.status);
    } catch (error) {
      if (isNotFound(error)) return "missing";
      throw error;
    }
  },
  destroy: async (credentials, providerSandboxId) => {
    try {
      const sandbox = await Sandbox.get({ ...apiOptions(credentials), name: providerSandboxId });
      await sandbox.delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
};
