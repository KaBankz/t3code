import { buildRemoteT3RunnerScript, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SandboxOperationError } from "../contracts.ts";
import type { SandboxCommandResult, SandboxMachine } from "./provider.ts";

export const T3_PORT = 3773;

// Installing t3 downloads a ~70 MB release archive; Claude Code adds its own installer.
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 60_000;

const STATE_DIR = `"$HOME/.t3/fork-sandbox"`;
const RUNNER = `"$HOME/.t3/fork-sandbox/run-t3.sh"`;
const SERVER_LOG = `"$HOME/.t3/fork-sandbox/server.log"`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function buildPrepareScript(input: {
  readonly runner: RemoteT3RunnerOptions;
  readonly installClaudeCode: boolean;
}): string {
  const runnerScript = buildRemoteT3RunnerScript(input.runner);
  return `set -eu
mkdir -p ${STATE_DIR}
cat >${RUNNER} <<'T3_FORK_SANDBOX_RUNNER'
${runnerScript}
T3_FORK_SANDBOX_RUNNER
chmod 700 ${RUNNER}
export PATH="$HOME/.local/bin:$PATH"
if [ ${input.installClaudeCode ? 1 : 0} = 1 ] && ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash >>${STATE_DIR}/setup.log 2>&1 ||
    printf 'Claude Code did not install; see ~/.t3/fork-sandbox/setup.log.\\n' >&2
fi
${RUNNER} --version
`;
}

export const buildReadyScript = (timeoutMs: number) =>
  `${RUNNER} __ssh-helper wait-ready ${T3_PORT} ${timeoutMs} ${PROBE_TIMEOUT_MS}`;

// The provider's own detached command keeps the server alive after this returns;
// a shell `&` would be reaped with the command's process group.
export const SERVE_SCRIPT = `export PATH="$HOME/.local/bin:$PATH" T3CODE_NO_BROWSER=1
exec ${RUNNER} serve --host 0.0.0.0 --port ${T3_PORT} --base-dir "$HOME/.t3" >>${SERVER_LOG} 2>&1 </dev/null`;

export const buildPairScript = (publicUrl: string) =>
  `${RUNNER} auth pairing create --base-dir "$HOME/.t3" --base-url ${shellQuote(publicUrl)} --json`;

const LOG_TAIL_SCRIPT = `tail -n 60 ${SERVER_LOG} 2>/dev/null || true`;

const PairingOutput = Schema.fromJsonString(
  Schema.Struct({
    credential: Schema.String,
    pairUrl: Schema.optionalKey(Schema.String),
  }),
);
const decodePairingOutput = Schema.decodeUnknownEffect(PairingOutput);

/** The CLI may log before its JSON, so read the last object line. */
export const parsePairingUrl = Effect.fn("forkSandbox.parsePairingUrl")(function* (
  stdout: string,
  publicUrl: string,
) {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{"));
  const output = yield* decodePairingOutput(line ?? "").pipe(
    Effect.mapError(
      () =>
        new SandboxOperationError({
          message: `The sandbox did not return a pairing link: ${stdout.trim().slice(-400)}`,
        }),
    ),
  );
  return output.pairUrl ?? `${publicUrl.replace(/\/+$/u, "")}/pair#token=${output.credential}`;
});

export const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const callProvider = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SandboxOperationError({ message: `${operation} failed: ${describeCause(cause)}` }),
  });

const outputTail = (result: SandboxCommandResult) =>
  (result.stderr.trim() || result.stdout.trim()).slice(-800);

const runChecked = Effect.fn("forkSandbox.runChecked")(function* (
  machine: SandboxMachine,
  operation: string,
  script: string,
  timeoutMs: number,
) {
  const result = yield* callProvider(operation, () => machine.run(script, timeoutMs));
  if (result.exitCode !== 0) {
    return yield* new SandboxOperationError({
      message: `${operation} exited with ${result.exitCode}: ${outputTail(result)}`,
    });
  }
  return result;
});

/**
 * Leaves a t3 server answering on the sandbox port. Safe to repeat: a running
 * server is kept, and a stopped sandbox whose files survived only restarts it.
 */
export const ensureServer = Effect.fn("forkSandbox.ensureServer")(function* (
  machine: SandboxMachine,
  input: { readonly runner: RemoteT3RunnerOptions; readonly installClaudeCode: boolean },
) {
  const prepareScript = yield* Effect.try({
    try: () => buildPrepareScript(input),
    catch: (cause) => new SandboxOperationError({ message: describeCause(cause) }),
  });
  yield* runChecked(machine, "Installing t3", prepareScript, PREPARE_TIMEOUT_MS);
  const probe = yield* callProvider("Checking the t3 server", () =>
    machine.run(buildReadyScript(PROBE_TIMEOUT_MS), COMMAND_TIMEOUT_MS),
  );
  if (probe.exitCode === 0) return;

  yield* callProvider("Starting the t3 server", () => machine.spawn(SERVE_SCRIPT));
  const ready = yield* callProvider("Waiting for the t3 server", () =>
    machine.run(buildReadyScript(READY_TIMEOUT_MS), READY_TIMEOUT_MS + COMMAND_TIMEOUT_MS),
  );
  if (ready.exitCode === 0) return;
  const log = yield* callProvider("Reading the t3 server log", () =>
    machine.run(LOG_TAIL_SCRIPT, COMMAND_TIMEOUT_MS),
  ).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
  return yield* new SandboxOperationError({
    message: `The t3 server did not become ready. ${log.stdout.trim().slice(-800)}`,
  });
});

export const mintPairingUrl = Effect.fn("forkSandbox.mintPairingUrl")(function* (
  machine: SandboxMachine,
) {
  const result = yield* runChecked(
    machine,
    "Creating a pairing link",
    buildPairScript(machine.publicUrl),
    COMMAND_TIMEOUT_MS,
  );
  return yield* parsePairingUrl(result.stdout, machine.publicUrl);
});
