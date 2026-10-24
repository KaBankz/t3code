import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { SandboxProviderAdapter } from "./provider.ts";
import * as SandboxManager from "./SandboxManager.ts";

const descriptor = {
  environmentId: "env-sandbox",
  label: "sandbox",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.2",
  capabilities: {},
};

function fakeAdapter(options: { readonly bootFails?: boolean } = {}) {
  const calls = { created: 0, destroyed: [] as Array<string>, credentials: [] as Array<unknown> };
  const adapter: SandboxProviderAdapter = {
    kind: "e2b",
    label: "Fake",
    lifecycle: "Never sleeps.",
    credentialFields: [
      { name: "apiKey", label: "API key", environmentVariable: "FAKE_KEY", secret: true },
    ],
    create: async (credentials) => {
      calls.created += 1;
      calls.credentials.push(credentials);
      return {
        providerSandboxId: `remote-${calls.created}`,
        publicUrl: "https://3773-remote.example.dev",
        run: async (script) =>
          script.includes("pairing create")
            ? { exitCode: 0, stdout: '{"credential":"tok"}', stderr: "" }
            : options.bootFails && script.includes("T3_FORK_SANDBOX_RUNNER")
              ? { exitCode: 1, stdout: "", stderr: "no network" }
              : { exitCode: 0, stdout: "", stderr: "" },
        spawn: async () => {},
      };
    },
    connect: async () => {
      throw new Error("unused");
    },
    status: async () => "running",
    destroy: async (_credentials, providerSandboxId) => {
      calls.destroyed.push(providerSandboxId);
    },
  };
  return { adapter, calls };
}

function makeManager(
  adapter: SandboxProviderAdapter,
  options: {
    readonly environment?: Record<string, string>;
    readonly stored?: Map<string, string>;
  } = {},
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fork-sandbox-" });
    const stored = options.stored ?? new Map<string, string>();
    const layerCredentials = Layer.succeed(
      SandboxManager.SandboxCredentialStore,
      SandboxManager.SandboxCredentialStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
    );
    const layerHttp = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(descriptor))),
        ),
      ),
    );
    const manager = yield* SandboxManager.make({
      registryPath: `${directory}/sandboxes.json`,
      t3Version: "0.1.2",
      environment: options.environment ?? { FAKE_KEY: "from-env" },
      adapters: [adapter],
    }).pipe(Effect.provide(Layer.merge(layerCredentials, layerHttp)));
    return { manager, stored };
  });
}

describe("SandboxManager", () => {
  it.effect("creates, pairs and remembers a sandbox", () =>
    Effect.gen(function* () {
      const { adapter } = fakeAdapter();
      const { manager } = yield* makeManager(adapter);
      const result = yield* manager.create({
        provider: "e2b",
        installClaudeCode: false,
        environment: {},
      });
      assert.strictEqual(result.pairingUrl, "https://3773-remote.example.dev/pair#token=tok");
      assert.strictEqual(result.sandbox.environmentId, "env-sandbox");
      const listed = yield* manager.list;
      assert.deepStrictEqual(
        listed.sandboxes.map((sandbox) => [sandbox.providerSandboxId, sandbox.status]),
        [["remote-1", "running"]],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("deletes the sandbox and forgets it when booting fails", () =>
    Effect.gen(function* () {
      const { adapter, calls } = fakeAdapter({ bootFails: true });
      const { manager } = yield* makeManager(adapter);
      const error = yield* Effect.flip(
        manager.create({ provider: "e2b", installClaudeCode: false, environment: {} }),
      );
      assert.include(error.message, "no network");
      assert.deepStrictEqual(calls.destroyed, ["remote-1"]);
      assert.deepStrictEqual((yield* manager.list).sandboxes, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("prefers saved credentials over the server environment", () =>
    Effect.gen(function* () {
      const { adapter, calls } = fakeAdapter();
      const { manager } = yield* makeManager(adapter);
      yield* manager.setCredentials("e2b", { apiKey: " saved " });
      yield* manager.create({ provider: "e2b", installClaudeCode: false, environment: {} });
      assert.deepStrictEqual(calls.credentials, [{ apiKey: "saved" }]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to create without credentials and reports how to add them", () =>
    Effect.gen(function* () {
      const { adapter, calls } = fakeAdapter();
      const { manager } = yield* makeManager(adapter, { environment: {} });
      const listed = yield* manager.list;
      assert.isFalse(listed.providers[0]?.configured);
      const error = yield* Effect.flip(
        manager.create({ provider: "e2b", installClaudeCode: false, environment: {} }),
      );
      assert.include(error.message, "FAKE_KEY");
      assert.strictEqual(calls.created, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("destroy removes the record and returns its environment", () =>
    Effect.gen(function* () {
      const { adapter, calls } = fakeAdapter();
      const { manager } = yield* makeManager(adapter);
      const created = yield* manager.create({
        provider: "e2b",
        installClaudeCode: false,
        environment: {},
      });
      const removed = yield* manager.destroy(created.sandbox.id);
      assert.strictEqual(removed.environmentId, "env-sandbox");
      assert.deepStrictEqual(calls.destroyed, ["remote-1"]);
      assert.deepStrictEqual((yield* manager.list).sandboxes, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
