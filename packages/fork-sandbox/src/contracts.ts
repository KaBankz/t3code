import {
  EnvironmentAuthenticatedAuth,
  EnvironmentId,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

export const SandboxProviderKind = Schema.Literals(["e2b", "vercel"]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

export const SandboxStatus = Schema.Literals([
  "running",
  "paused",
  "stopped",
  "missing",
  "unknown",
]);
export type SandboxStatus = typeof SandboxStatus.Type;

export const SandboxCredentialField = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  environmentVariable: Schema.String,
  secret: Schema.Boolean,
  configured: Schema.Boolean,
});
export type SandboxCredentialField = typeof SandboxCredentialField.Type;

export const SandboxProviderSummary = Schema.Struct({
  kind: SandboxProviderKind,
  label: Schema.String,
  configured: Schema.Boolean,
  /** What happens when the sandbox times out, in the provider's own terms. */
  lifecycle: Schema.String,
  fields: Schema.Array(SandboxCredentialField),
});
export type SandboxProviderSummary = typeof SandboxProviderSummary.Type;

export const SandboxRecord = Schema.Struct({
  id: Schema.String,
  provider: SandboxProviderKind,
  providerSandboxId: Schema.String,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  t3Version: Schema.String,
  environmentId: Schema.optionalKey(EnvironmentId),
  createdAt: Schema.String,
});
export type SandboxRecord = typeof SandboxRecord.Type;

export const SandboxView = Schema.Struct({
  ...SandboxRecord.fields,
  status: SandboxStatus,
});
export type SandboxView = typeof SandboxView.Type;

export const SandboxListResult = Schema.Struct({
  providers: Schema.Array(SandboxProviderSummary),
  sandboxes: Schema.Array(SandboxView),
});
export type SandboxListResult = typeof SandboxListResult.Type;

export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProviderKind,
  label: Schema.optionalKey(Schema.String),
  /** Defaults to the primary server's own version. */
  t3Version: Schema.optionalKey(Schema.String),
  installClaudeCode: Schema.Boolean,
  environment: Schema.Record(Schema.String, Schema.String),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

export const SandboxPairingResult = Schema.Struct({
  sandbox: SandboxView,
  pairingUrl: Schema.String,
});
export type SandboxPairingResult = typeof SandboxPairingResult.Type;

export const SandboxCredentialsInput = Schema.Struct({
  values: Schema.Record(Schema.String, Schema.String),
});

const SandboxIdParams = Schema.Struct({ id: Schema.String });
const SandboxProviderParams = Schema.Struct({ provider: SandboxProviderKind });

export class SandboxOperationError extends Schema.TaggedError<SandboxOperationError>()(
  "SandboxOperationError",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const SandboxErrors = [
  SandboxOperationError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export class SandboxHttpApiGroup extends HttpApiGroup.make("sandboxes")
  .add(
    HttpApiEndpoint.get("list", "/api/fork/sandboxes", {
      success: SandboxListResult,
      error: SandboxErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/api/fork/sandboxes", {
      payload: SandboxCreateInput,
      success: SandboxPairingResult,
      error: SandboxErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("pair", "/api/fork/sandboxes/:id/pairing", {
      params: SandboxIdParams,
      success: SandboxPairingResult,
      error: SandboxErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("destroy", "/api/fork/sandboxes/:id", {
      params: SandboxIdParams,
      success: SandboxRecord,
      error: SandboxErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("setCredentials", "/api/fork/sandbox-providers/:provider/credentials", {
      params: SandboxProviderParams,
      payload: SandboxCredentialsInput,
      success: SandboxProviderSummary,
      error: SandboxErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "clearCredentials",
      "/api/fork/sandbox-providers/:provider/credentials",
      {
        params: SandboxProviderParams,
        success: SandboxProviderSummary,
        error: SandboxErrors,
      },
    ),
  )
  .middleware(EnvironmentAuthenticatedAuth) {}

export class SandboxHttpApi extends HttpApi.make("forkSandbox").add(SandboxHttpApiGroup) {}
