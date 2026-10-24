import { CommandExitError, NotFoundError, Sandbox } from "e2b";

import type { SandboxMachine, SandboxProviderAdapter } from "./provider.ts";

// Hobby accounts cap a sandbox at one hour. Auto-resume makes the cap an idle
// pause rather than an end of life, so a short timeout only costs a wake-up.
const SANDBOX_TIMEOUT_MS = 30 * 60_000;

const apiOptions = (credentials: Readonly<Record<string, string>>) => ({
  apiKey: credentials.apiKey ?? "",
});

function toMachine(sandbox: Sandbox, port: number): SandboxMachine {
  return {
    providerSandboxId: sandbox.sandboxId,
    publicUrl: `https://${sandbox.getHost(port)}`,
    run: async (script, timeoutMs) => {
      try {
        const result = await sandbox.commands.run(script, { timeoutMs });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // The SDK rejects on a non-zero exit; callers decide what a failure means.
        if (error instanceof CommandExitError) {
          return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        }
        throw error;
      }
    },
    spawn: async (script) => {
      // A zero timeout keeps E2B from killing the server when the default 60s elapses.
      await sandbox.commands.run(script, { background: true, timeoutMs: 0 });
    },
  };
}

export const e2bAdapter: SandboxProviderAdapter = {
  kind: "e2b",
  label: "E2B",
  lifecycle: "Pauses after 30 minutes and resumes on the next connection.",
  credentialFields: [
    { name: "apiKey", label: "API key", environmentVariable: "E2B_API_KEY", secret: true },
  ],
  create: async (credentials, options) =>
    toMachine(
      await Sandbox.create({
        ...apiOptions(credentials),
        timeoutMs: SANDBOX_TIMEOUT_MS,
        envs: { ...options.environment },
        metadata: { ...options.metadata, label: options.label },
        lifecycle: { onTimeout: "pause", autoResume: true },
      }),
      options.port,
    ),
  connect: async (credentials, providerSandboxId, port) =>
    toMachine(
      await Sandbox.connect(providerSandboxId, {
        ...apiOptions(credentials),
        timeoutMs: SANDBOX_TIMEOUT_MS,
      }),
      port,
    ),
  status: async (credentials, providerSandboxId) => {
    try {
      const info = await Sandbox.getInfo(providerSandboxId, apiOptions(credentials));
      return info.state;
    } catch (error) {
      if (error instanceof NotFoundError) return "missing";
      throw error;
    }
  },
  destroy: async (credentials, providerSandboxId) => {
    await Sandbox.kill(providerSandboxId, apiOptions(credentials));
  },
};
