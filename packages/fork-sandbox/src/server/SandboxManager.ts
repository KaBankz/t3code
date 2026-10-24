import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  SandboxOperationError,
  SandboxRecord,
  type SandboxCreateInput,
  type SandboxListResult,
  type SandboxPairingResult,
  type SandboxProviderKind,
  type SandboxProviderSummary,
  type SandboxStatus,
  type SandboxView,
} from "../contracts.ts";
import { T3_PORT, callProvider, describeCause, ensureServer, mintPairingUrl } from "./bootstrap.ts";
import { e2bAdapter } from "./e2b.ts";
import type { SandboxCredentials, SandboxMachine, SandboxProviderAdapter } from "./provider.ts";
import { vercelAdapter } from "./vercel.ts";

/** Backed by the server's secret store, so keys never sit in settings.json. */
export class SandboxCredentialStore extends Context.Service<
  SandboxCredentialStore,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<string>, SandboxOperationError>;
    readonly set: (name: string, value: string) => Effect.Effect<void, SandboxOperationError>;
    readonly remove: (name: string) => Effect.Effect<void, SandboxOperationError>;
  }
>()("@t3tools/fork-sandbox/server/SandboxManager/SandboxCredentialStore") {}

export interface SandboxManagerOptions {
  /** JSON file listing the sandboxes this server created. */
  readonly registryPath: string;
  /** Version of the t3 release archive started inside new sandboxes. */
  readonly t3Version: string;
  readonly releaseBaseUrl?: string | undefined;
  /** Read for credentials that were not saved through the API. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly adapters?: ReadonlyArray<SandboxProviderAdapter>;
}

export class SandboxManager extends Context.Service<
  SandboxManager,
  {
    readonly list: Effect.Effect<SandboxListResult, SandboxOperationError>;
    readonly create: (
      input: SandboxCreateInput,
    ) => Effect.Effect<SandboxPairingResult, SandboxOperationError>;
    /** Wakes the sandbox and its t3 server if needed, then mints a fresh pairing link. */
    readonly pair: (id: string) => Effect.Effect<SandboxPairingResult, SandboxOperationError>;
    readonly destroy: (id: string) => Effect.Effect<SandboxRecord, SandboxOperationError>;
    readonly setCredentials: (
      provider: SandboxProviderKind,
      values: Readonly<Record<string, string>>,
    ) => Effect.Effect<SandboxProviderSummary, SandboxOperationError>;
    readonly clearCredentials: (
      provider: SandboxProviderKind,
    ) => Effect.Effect<SandboxProviderSummary, SandboxOperationError>;
  }
>()("@t3tools/fork-sandbox/server/SandboxManager") {}

const Registry = Schema.fromJsonString(Schema.Struct({ sandboxes: Schema.Array(SandboxRecord) }));
const decodeRegistry = Schema.decodeUnknownEffect(Registry);
const encodeRegistry = Schema.encodeEffect(Registry);

const STATUS_TIMEOUT = "10 seconds";

const credentialSecretName = (provider: SandboxProviderKind, field: string) =>
  `fork-sandbox-${provider}-${field}`;

const sandboxIdPattern = /^[a-z0-9-]{1,64}$/u;

export const make = Effect.fn("forkSandbox.SandboxManager.make")(function* (
  options: SandboxManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const credentialStore = yield* SandboxCredentialStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const adapters = new Map(
    (options.adapters ?? [e2bAdapter, vercelAdapter]).map((adapter) => [adapter.kind, adapter]),
  );
  const registryLock = yield* Semaphore.make(1);

  const adapterFor = Effect.fn("forkSandbox.SandboxManager.adapterFor")(function* (
    provider: SandboxProviderKind,
  ) {
    const adapter = adapters.get(provider);
    if (adapter === undefined) {
      return yield* new SandboxOperationError({ message: `${provider} is not available.` });
    }
    return adapter;
  });

  const readRegistry = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(options.registryPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const text = yield* fileSystem.readFileString(options.registryPath);
    return (yield* decodeRegistry(text)).sandboxes;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SandboxOperationError({
          message: `Could not read ${options.registryPath}: ${describeCause(cause)}`,
        }),
    ),
  );

  const writeRegistry = Effect.fn("forkSandbox.SandboxManager.writeRegistry")(
    function* (sandboxes: ReadonlyArray<SandboxRecord>) {
      const text = yield* encodeRegistry({ sandboxes });
      const temporaryPath = `${options.registryPath}.tmp`;
      yield* fileSystem.writeFileString(temporaryPath, `${text}\n`);
      yield* fileSystem.rename(temporaryPath, options.registryPath);
    },
    Effect.mapError(
      (cause) =>
        new SandboxOperationError({
          message: `Could not write ${options.registryPath}: ${describeCause(cause)}`,
        }),
    ),
  );

  const updateRegistry = (
    update: (sandboxes: ReadonlyArray<SandboxRecord>) => ReadonlyArray<SandboxRecord>,
  ) =>
    registryLock.withPermits(1)(
      Effect.flatMap(readRegistry, (sandboxes) => writeRegistry(update(sandboxes))),
    );

  const upsertRecord = (record: SandboxRecord) =>
    updateRegistry((sandboxes) => [...sandboxes.filter((entry) => entry.id !== record.id), record]);

  const findRecord = Effect.fn("forkSandbox.SandboxManager.findRecord")(function* (id: string) {
    const record = (yield* readRegistry).find((entry) => entry.id === id);
    if (record === undefined) {
      return yield* new SandboxOperationError({ message: `No sandbox ${id} on this server.` });
    }
    return record;
  });

  const readCredentialField = Effect.fn("forkSandbox.SandboxManager.readCredentialField")(
    function* (
      provider: SandboxProviderKind,
      field: SandboxProviderAdapter["credentialFields"][number],
    ) {
      const stored = yield* credentialStore.get(credentialSecretName(provider, field.name));
      if (Option.isSome(stored) && stored.value.trim() !== "") return Option.some(stored.value);
      const fromEnvironment = options.environment[field.environmentVariable]?.trim();
      return fromEnvironment ? Option.some(fromEnvironment) : Option.none<string>();
    },
  );

  const summarize = Effect.fn("forkSandbox.SandboxManager.summarize")(function* (
    adapter: SandboxProviderAdapter,
  ) {
    const fields = yield* Effect.forEach(adapter.credentialFields, (field) =>
      Effect.map(readCredentialField(adapter.kind, field), (value) => ({
        name: field.name,
        label: field.label,
        environmentVariable: field.environmentVariable,
        secret: field.secret,
        configured: Option.isSome(value),
      })),
    );
    return {
      kind: adapter.kind,
      label: adapter.label,
      lifecycle: adapter.lifecycle,
      configured: fields.every((field) => field.configured),
      fields,
    } satisfies SandboxProviderSummary;
  });

  const resolveCredentials = Effect.fn("forkSandbox.SandboxManager.resolveCredentials")(function* (
    adapter: SandboxProviderAdapter,
  ) {
    const credentials: Record<string, string> = {};
    for (const field of adapter.credentialFields) {
      const value = yield* readCredentialField(adapter.kind, field);
      if (Option.isNone(value)) {
        return yield* new SandboxOperationError({
          message: `${adapter.label} needs ${field.label} (or ${field.environmentVariable} on the server).`,
        });
      }
      credentials[field.name] = value.value;
    }
    return credentials as SandboxCredentials;
  });

  const readEnvironmentId = (httpBaseUrl: string) =>
    httpClient.get(new URL("/.well-known/t3/environment", httpBaseUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(
        (cause) =>
          new SandboxOperationError({
            message: `${httpBaseUrl} did not answer as a t3 server: ${describeCause(cause)}`,
          }),
      ),
      // The provider's public proxy can lag the server it routes to by a few seconds.
      Effect.retry({ times: 10, schedule: Schedule.spaced("1 second") }),
      Effect.map((descriptor) => descriptor.environmentId),
    );

  const statusOf = (adapter: SandboxProviderAdapter, record: SandboxRecord) =>
    resolveCredentials(adapter).pipe(
      Effect.flatMap((credentials) =>
        callProvider("Reading sandbox status", () =>
          adapter.status(credentials, record.providerSandboxId),
        ),
      ),
      Effect.timeout(STATUS_TIMEOUT),
      Effect.orElseSucceed((): SandboxStatus => "unknown"),
    );

  const pairMachine = Effect.fn("forkSandbox.SandboxManager.pairMachine")(function* (
    record: SandboxRecord,
    machine: SandboxMachine,
    installClaudeCode: boolean,
  ) {
    yield* ensureServer(machine, {
      runner: { archiveVersion: record.t3Version, releaseBaseUrl: options.releaseBaseUrl ?? null },
      installClaudeCode,
    });
    const pairingUrl = yield* mintPairingUrl(machine);
    const environmentId = yield* readEnvironmentId(machine.publicUrl);
    const next: SandboxRecord = { ...record, httpBaseUrl: machine.publicUrl, environmentId };
    yield* upsertRecord(next);
    return { sandbox: { ...next, status: "running" }, pairingUrl } satisfies SandboxPairingResult;
  });

  const list = Effect.gen(function* () {
    const providers = yield* Effect.forEach([...adapters.values()], summarize);
    const records = yield* readRegistry;
    const sandboxes = yield* Effect.forEach(
      records,
      (record) =>
        Effect.map(
          adapterFor(record.provider).pipe(Effect.flatMap((adapter) => statusOf(adapter, record))),
          (status): SandboxView => ({ ...record, status }),
        ),
      { concurrency: 4 },
    );
    return { providers, sandboxes } satisfies SandboxListResult;
  }).pipe(Effect.withSpan("forkSandbox.SandboxManager.list"));

  const create = Effect.fn("forkSandbox.SandboxManager.create")(function* (
    input: SandboxCreateInput,
  ) {
    const adapter = yield* adapterFor(input.provider);
    const credentials = yield* resolveCredentials(adapter);
    const uuid = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError((cause) => new SandboxOperationError({ message: describeCause(cause) })),
      );
    const id = `sbx-${uuid.slice(0, 8)}`;
    const label = input.label?.trim() || `${adapter.label} sandbox`;
    const machine = yield* callProvider(`Creating the ${adapter.label} sandbox`, () =>
      adapter.create(credentials, {
        port: T3_PORT,
        label,
        environment: input.environment,
        metadata: { t3ForkSandboxId: id },
      }),
    );
    const record: SandboxRecord = {
      id,
      provider: adapter.kind,
      providerSandboxId: machine.providerSandboxId,
      label,
      httpBaseUrl: machine.publicUrl,
      t3Version: input.t3Version?.trim() || options.t3Version,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    // Record it before booting so a crash mid-boot still leaves a sandbox the UI can delete.
    yield* upsertRecord(record);
    return yield* pairMachine(record, machine, input.installClaudeCode).pipe(
      Effect.tapError(() =>
        callProvider("Deleting the failed sandbox", () =>
          adapter.destroy(credentials, machine.providerSandboxId),
        ).pipe(
          Effect.andThen(
            updateRegistry((sandboxes) => sandboxes.filter((entry) => entry.id !== id)),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const pair = Effect.fn("forkSandbox.SandboxManager.pair")(function* (id: string) {
    const record = yield* findRecord(id);
    const adapter = yield* adapterFor(record.provider);
    const credentials = yield* resolveCredentials(adapter);
    const machine = yield* callProvider(`Starting the ${adapter.label} sandbox`, () =>
      adapter.connect(credentials, record.providerSandboxId, T3_PORT),
    );
    return yield* pairMachine(record, machine, false);
  });

  const destroy = Effect.fn("forkSandbox.SandboxManager.destroy")(function* (id: string) {
    const record = yield* findRecord(id);
    const adapter = yield* adapterFor(record.provider);
    const credentials = yield* resolveCredentials(adapter);
    yield* callProvider(`Deleting the ${adapter.label} sandbox`, () =>
      adapter.destroy(credentials, record.providerSandboxId),
    );
    yield* updateRegistry((sandboxes) => sandboxes.filter((entry) => entry.id !== id));
    return record;
  });

  const setCredentials = Effect.fn("forkSandbox.SandboxManager.setCredentials")(function* (
    provider: SandboxProviderKind,
    values: Readonly<Record<string, string>>,
  ) {
    const adapter = yield* adapterFor(provider);
    for (const field of adapter.credentialFields) {
      const value = values[field.name]?.trim();
      // Blank fields keep what is saved, so a form can update one key at a time.
      if (value) yield* credentialStore.set(credentialSecretName(provider, field.name), value);
    }
    return yield* summarize(adapter);
  });

  const clearCredentials = Effect.fn("forkSandbox.SandboxManager.clearCredentials")(function* (
    provider: SandboxProviderKind,
  ) {
    const adapter = yield* adapterFor(provider);
    for (const field of adapter.credentialFields) {
      yield* credentialStore.remove(credentialSecretName(provider, field.name));
    }
    return yield* summarize(adapter);
  });

  const validateId =
    <A, E>(f: (id: string) => Effect.Effect<A, E>) =>
    (id: string) =>
      sandboxIdPattern.test(id)
        ? f(id)
        : Effect.fail(new SandboxOperationError({ message: `Invalid sandbox id ${id}.` }));

  return SandboxManager.of({
    list,
    create,
    pair: validateId(pair),
    destroy: validateId(destroy),
    setCredentials,
    clearCredentials,
  });
});

export const layer = (options: SandboxManagerOptions) =>
  Layer.effect(SandboxManager, make(options));
