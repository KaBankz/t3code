import type { SandboxProviderKind, SandboxStatus } from "../contracts.ts";

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A sandbox the adapter has a live handle to. */
export interface SandboxMachine {
  readonly providerSandboxId: string;
  /** Public HTTPS origin the provider routes to the t3 port. */
  readonly publicUrl: string;
  /** Runs a POSIX shell script and waits for it to exit. */
  readonly run: (script: string, timeoutMs: number) => Promise<SandboxCommandResult>;
  /** Starts a long-running POSIX shell script and returns once it is started. */
  readonly spawn: (script: string) => Promise<void>;
}

export interface SandboxCredentialFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly environmentVariable: string;
  readonly secret: boolean;
}

export type SandboxCredentials = Readonly<Record<string, string>>;

export interface SandboxCreateOptions {
  readonly port: number;
  readonly label: string;
  /** Applied to every command, so it survives the provider restarting the sandbox. */
  readonly environment: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Each adapter is a thin translation of one provider SDK. Everything after the
 * sandbox exists (installing and starting t3, pairing) is provider-neutral and
 * lives in the bootstrap module.
 */
export interface SandboxProviderAdapter {
  readonly kind: SandboxProviderKind;
  readonly label: string;
  readonly lifecycle: string;
  readonly credentialFields: ReadonlyArray<SandboxCredentialFieldDefinition>;
  readonly create: (
    credentials: SandboxCredentials,
    options: SandboxCreateOptions,
  ) => Promise<SandboxMachine>;
  /** Reattaches to a sandbox, resuming it if the provider paused or stopped it. */
  readonly connect: (
    credentials: SandboxCredentials,
    providerSandboxId: string,
    port: number,
  ) => Promise<SandboxMachine>;
  readonly status: (
    credentials: SandboxCredentials,
    providerSandboxId: string,
  ) => Promise<SandboxStatus>;
  /** Resolves even when the provider no longer knows the sandbox. */
  readonly destroy: (credentials: SandboxCredentials, providerSandboxId: string) => Promise<void>;
}
