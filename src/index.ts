import { definePlatform, fusor } from "spectrum-ts";
import { initClient } from "./client";
import { configSchema, LINQ_PLATFORM } from "./config";
import { handleMessages } from "./inbound/messages";
import { send } from "./outbound/send";
import { resolveSpace, resolveUser, spaceParamsSchema } from "./space";
import type { LinqPayload } from "./types";
import { makeVerify } from "./verify";

export type { LinqConfig } from "./config";
// biome-ignore lint/performance/noBarrelFile: this is the package's public entry point.
export {
  FusorJsonWebhookError,
  normalizeFusorWebhookRequest,
} from "./webhook";

/**
 * LinQ provider for Spectrum.
 *
 * Inbound is delivered through Fusor (`createClient` returns a `fusor(...)`
 * client whose `verify` checks the LinQ webhook HMAC and parses the event);
 * outbound goes through LinQ's HTTP API. Drop `linq.config({...})` into
 * `Spectrum({ providers: [...] })`.
 */
export const linq = definePlatform(LINQ_PLATFORM, {
  config: configSchema,
  lifecycle: {
    createClient: ({ config, store }) => {
      initClient(store, config);
      return Promise.resolve(
        fusor<LinqPayload>(LINQ_PLATFORM, makeVerify(config))
      );
    },
  },
  user: { resolve: resolveUser },
  space: { params: spaceParamsSchema, create: resolveSpace },
  messages: handleMessages,
  send,
});
