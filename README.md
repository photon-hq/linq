# @photon-ai/linq

[LinQ](https://docs.linqapp.com) adapter for [Spectrum](https://photon.codes/spectrum).

- **Inbound** is delivered through **Fusor** (Spectrum's built-in inbound
  pipeline). Fusor hands the adapter the original raw request; the adapter
  verifies LinQ's webhook HMAC, parses the event, and produces Spectrum
  messages.
- **Outbound** uses LinQ's HTTP API via the official
  [`@linqapp/sdk`](https://github.com/linq-team/linq-node).

LinQ is iMessage-native, so most of Spectrum's content model maps directly:
text, attachments, voice memos, reactions (tapbacks), replies, rich links,
message effects, typing indicators, group rename / icon, and contact cards.

## Install

```sh
bun add @photon-ai/linq spectrum-ts@^12.7.0
```

## Configure

Provision a bearer token and a webhook signing secret from your LinQ
representative, then drop the provider into `Spectrum({ providers: [...] })`:

```typescript
import { Spectrum, text } from "spectrum-ts";
import { linq } from "@photon-ai/linq";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [
    linq.config({
      apiKey: process.env.LINQ_API_KEY,
      webhookSigningSecret: process.env.LINQ_WEBHOOK_SECRET,
      defaultFrom: "+12025550123", // optional: number for proactively-created chats
    }),
  ],
});

// Streaming
for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(text(`echo: ${message.content.text}`));
  }
}
```

### Webhook mode

```typescript
import {
  FusorJsonWebhookError,
  normalizeFusorWebhookRequest,
} from "@photon-ai/linq";

// Hono / Bun.serve / Next.js / Workers — pass the raw Request.
server.post("/webhooks/fusor", async (c) => {
  try {
    // Spectrum 12 consumes protobuf Fusor envelopes. This also accepts the
    // schema-v1 JSON envelope used by Fusor HTTP subscriptions and verifies
    // its outer signature when a secret is provided.
    const request = await normalizeFusorWebhookRequest(c.req.raw, {
      webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
    });
    return app.webhook(request, async (space, message) => {
      await space.send("got it");
    });
  } catch (error) {
    if (error instanceof FusorJsonWebhookError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
});
```

The normalizer leaves protobuf Fusor deliveries and native Spectrum JSON
webhooks untouched so `app.webhook()` can auto-detect them. If you also receive
native Spectrum JSON, configure its separate `Spectrum({ webhookSecret })`.

### Webhook signing

Inbound POSTs are verified in two independent layers:

| Layer | Secret | Set on | Header(s) | Signed payload |
| --- | --- | --- | --- | --- |
| **Outer** — JSON relay came from Fusor | `webhookSecret` | `normalizeFusorWebhookRequest(...)` | `x-spectrum-signature` / `x-spectrum-timestamp` | `v0:{timestamp}:` + raw body bytes, signature prefixed `v0=` |
| **Inner** — event came from LinQ | `webhookSigningSecret` | `linq.config({...})` | `x-webhook-signature` / `x-webhook-timestamp` | `{timestamp}.{body}` |

Both use `HMAC-SHA256` and are **opt-in**: when a secret is omitted, that layer's
check is skipped. Set both in production — the outer secret proves the request
reached you through the Fusor JSON relay, while the inner one proves the raw
payload originated at LinQ. Spectrum's separate native JSON webhook uses
`Spectrum({ webhookSecret })` instead.

Only the inner LinQ layer is replay-guarded (`replayToleranceSec`); the outer
Fusor layer intentionally does not enforce timestamp freshness, since Fusor
retries can legitimately reuse an older sign-time.

## Config

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | yes | — | LinQ bearer token (outbound + media downloads). |
| `webhookSigningSecret` | recommended | — | Per-subscription HMAC secret. When set, inbound webhooks are verified (HMAC-SHA256 over `{timestamp}.{body}`) and replay-guarded. When omitted, verification is skipped. |
| `defaultFrom` | no | — | Provisioned phone number used when creating a new chat for a proactive send. |
| `baseUrl` | no | SDK default | Override the LinQ API base URL. |
| `replayToleranceSec` | no | `300` | Reject webhooks whose timestamp is older than this. |

## Content support

| Spectrum content | LinQ |
| --- | --- |
| `text` | text part |
| `attachment` | upload → media part (`attachment_id`) |
| `voice` | voice-memo bubble |
| `richlink` | link part (sole part) |
| `reply` | threaded `reply_to` |
| `effect` | iMessage effect + inner part |
| `reaction` | tapback (or custom emoji) |
| `typing` | typing indicator |
| `rename` | group name update |
| `avatar` | group icon update |
| `contact` | shared as a `.vcf` media attachment |
| `group` | one message with multiple parts |
| `custom` | escape hatch (`raw` merged into the message body) |
| `poll` / `poll_option` | unsupported (LinQ has no polls) → `UnsupportedError` |
