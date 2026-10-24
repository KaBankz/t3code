import {
  SandboxHttpApi,
  SandboxOperationError,
  type SandboxCreateInput,
  type SandboxProviderKind,
} from "@t3tools/fork-sandbox/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { Atom } from "effect/reactivity";

import * as PrimaryEnvironmentHttpLayer from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

// Sandboxes are provisioned by the primary server, which holds the provider keys.
const runtime = ManagedRuntime.make(PrimaryEnvironmentHttpLayer.layer);

const client = Effect.suspend(() =>
  HttpApiClient.make(SandboxHttpApi, { baseUrl: resolvePrimaryEnvironmentHttpUrl("/") }),
);

type SandboxClient = Effect.Success<typeof client>["sandboxes"];

class SandboxRequestError extends Data.TaggedError("SandboxRequestError")<{
  readonly message: string;
}> {}

const isSandboxOperationError = Schema.is(SandboxOperationError);

function describeFailure(error: unknown): string {
  if (isSandboxOperationError(error)) return error.message;
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  if (tag === "EnvironmentScopeRequiredError") {
    return "This client is not allowed to maintain the environment. Pair it with full permissions.";
  }
  if (tag === "HttpClientError") {
    return "Could not reach this machine's T3 server. It may not include cloud sandbox support.";
  }
  return error instanceof Error ? error.message : "The sandbox request failed.";
}

const run = <A, E>(request: (sandboxes: SandboxClient) => Effect.Effect<A, E>) =>
  runtime.runPromise(
    client.pipe(
      Effect.flatMap((api) => request(api.sandboxes)),
      Effect.mapError((error) => new SandboxRequestError({ message: describeFailure(error) })),
    ),
  );

export const sandboxApi = {
  list: () => run((sandboxes) => sandboxes.list()),
  create: (payload: SandboxCreateInput) => run((sandboxes) => sandboxes.create({ payload })),
  pair: (id: string) => run((sandboxes) => sandboxes.pair({ params: { id } })),
  destroy: (id: string) => run((sandboxes) => sandboxes.destroy({ params: { id } })),
  setCredentials: (provider: SandboxProviderKind, values: Record<string, string>) =>
    run((sandboxes) => sandboxes.setCredentials({ params: { provider }, payload: { values } })),
  clearCredentials: (provider: SandboxProviderKind) =>
    run((sandboxes) => sandboxes.clearCredentials({ params: { provider } })),
};

/** Not kept alive: reopening the panel fetches fresh sandbox status. */
export const sandboxListAtom = Atom.make(
  Effect.tryPromise({
    try: sandboxApi.list,
    catch: (cause) => new SandboxRequestError({ message: describeFailure(cause) }),
  }),
).pipe(Atom.withLabel("fork:sandboxes"));
