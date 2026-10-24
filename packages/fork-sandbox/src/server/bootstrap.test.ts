import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildReadyScript, ensureServer, parsePairingUrl, SERVE_SCRIPT } from "./bootstrap.ts";
import type { SandboxCommandResult, SandboxMachine } from "./provider.ts";

const RUNNER = { runner: { archiveVersion: "0.1.2" }, installClaudeCode: false };

function fakeMachine(respond: (script: string) => SandboxCommandResult) {
  const ran: Array<string> = [];
  const spawned: Array<string> = [];
  const machine: SandboxMachine = {
    providerSandboxId: "sbx",
    publicUrl: "https://3773-sbx.example.dev",
    run: async (script) => {
      ran.push(script);
      return respond(script);
    },
    spawn: async (script) => {
      spawned.push(script);
    },
  };
  return { machine, ran, spawned };
}

const ok = { exitCode: 0, stdout: "", stderr: "" };
const failed = { exitCode: 1, stdout: "", stderr: "" };

describe("parsePairingUrl", () => {
  it.effect("prefers the CLI's link and reads the last JSON line", () =>
    Effect.gen(function* () {
      const url = yield* parsePairingUrl(
        'starting\n{"credential":"abc","pairUrl":"https://x.dev/pair#token=abc"}\n',
        "https://x.dev",
      );
      assert.strictEqual(url, "https://x.dev/pair#token=abc");
    }),
  );

  it.effect("builds the link from the credential when the CLI omits it", () =>
    Effect.gen(function* () {
      const url = yield* parsePairingUrl('{"credential":"abc"}', "https://x.dev/");
      assert.strictEqual(url, "https://x.dev/pair#token=abc");
    }),
  );

  it.effect("fails with the output when there is no credential", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parsePairingUrl("permission denied", "https://x.dev"));
      assert.include(error.message, "permission denied");
    }),
  );
});

describe("ensureServer", () => {
  it.effect("keeps a server that already answers", () =>
    Effect.gen(function* () {
      const { machine, spawned } = fakeMachine(() => ok);
      yield* ensureServer(machine, RUNNER);
      assert.deepStrictEqual(spawned, []);
    }),
  );

  it.effect("starts the server when the probe fails, then waits for it", () =>
    Effect.gen(function* () {
      const probe = buildReadyScript(2_000);
      const { machine, ran, spawned } = fakeMachine((script) => (script === probe ? failed : ok));
      yield* ensureServer(machine, RUNNER);
      assert.deepStrictEqual(spawned, [SERVE_SCRIPT]);
      assert.strictEqual(ran.at(-1), buildReadyScript(90_000));
    }),
  );

  it.effect("reports the server log when the server never becomes ready", () =>
    Effect.gen(function* () {
      const { machine } = fakeMachine((script) =>
        script.startsWith("tail")
          ? { exitCode: 0, stdout: "EADDRINUSE", stderr: "" }
          : script.includes("wait-ready")
            ? failed
            : ok,
      );
      const error = yield* Effect.flip(ensureServer(machine, RUNNER));
      assert.include(error.message, "EADDRINUSE");
    }),
  );

  it.effect("stops before starting anything when the install fails", () =>
    Effect.gen(function* () {
      const { machine, spawned } = fakeMachine((script) =>
        script.includes("T3_FORK_SANDBOX_RUNNER")
          ? { exitCode: 1, stdout: "", stderr: "Checksum mismatch" }
          : ok,
      );
      const error = yield* Effect.flip(ensureServer(machine, RUNNER));
      assert.include(error.message, "Checksum mismatch");
      assert.deepStrictEqual(spawned, []);
    }),
  );

  it.effect("rejects a version that cannot name a release", () =>
    Effect.gen(function* () {
      const { machine } = fakeMachine(() => ok);
      const error = yield* Effect.flip(
        ensureServer(machine, { ...RUNNER, runner: { archiveVersion: "../latest" } }),
      );
      assert.include(error.message, "../latest");
    }),
  );
});
