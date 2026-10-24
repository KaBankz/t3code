import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { SandboxHttpApi, SandboxOperationError } from "@t3tools/fork-sandbox/contracts";
import { SandboxManager } from "@t3tools/fork-sandbox/server";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import packageJson from "../../package.json" with { type: "json" };
import {
  annotateEnvironmentRequest,
  layerAuthenticatedAuth,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toSandboxError = (cause: ServerSecretStore.SecretStoreError) =>
  new SandboxOperationError({ message: cause.message });

const layerCredentialStore = Layer.effect(
  SandboxManager.SandboxCredentialStore,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return SandboxManager.SandboxCredentialStore.of({
      get: (name) =>
        secrets
          .get(name)
          .pipe(
            Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
            Effect.mapError(toSandboxError),
          ),
      set: (name, value) =>
        secrets.set(name, textEncoder.encode(value)).pipe(Effect.mapError(toSandboxError)),
      remove: (name) => secrets.remove(name).pipe(Effect.mapError(toSandboxError)),
    });
  }),
);

const layerManager = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return SandboxManager.layer({
      registryPath: path.join(config.stateDir, "fork-sandboxes.json"),
      // Sandboxes run the published release matching this server, so the
      // client talks to the same protocol version it was built against.
      t3Version: packageJson.version,
      releaseBaseUrl: process.env[CLI_RELEASE_BASE_URL_ENV],
      environment: process.env,
    });
  }),
).pipe(Layer.provide(layerCredentialStore));

const layerHandlers = HttpApiBuilder.group(
  SandboxHttpApi,
  "sandboxes",
  Effect.fnUntraced(function* (handlers) {
    const manager = yield* SandboxManager.SandboxManager;
    // Creating sandboxes spends money and stores cloud credentials, so every
    // route needs the same grant as other environment maintenance.
    const guard = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      annotateEnvironmentRequest(name).pipe(
        Effect.andThen(requireEnvironmentScope(AuthEnvironmentMaintainScope)),
        Effect.andThen(effect),
      );
    return handlers
      .handle("list", () => guard("forkSandbox.list", manager.list))
      .handle("create", ({ payload }) => guard("forkSandbox.create", manager.create(payload)))
      .handle("pair", ({ params }) => guard("forkSandbox.pair", manager.pair(params.id)))
      .handle("destroy", ({ params }) => guard("forkSandbox.destroy", manager.destroy(params.id)))
      .handle("setCredentials", ({ params, payload }) =>
        guard(
          "forkSandbox.setCredentials",
          manager.setCredentials(params.provider, payload.values),
        ),
      )
      .handle("clearCredentials", ({ params }) =>
        guard("forkSandbox.clearCredentials", manager.clearCredentials(params.provider)),
      );
  }),
);

/** Fork-owned routes; registered beside the environment API in server.ts. */
export const routesLayer = HttpApiBuilder.layer(SandboxHttpApi).pipe(
  Layer.provide(layerHandlers),
  Layer.provide(layerManager),
  Layer.provide(layerAuthenticatedAuth),
);
