import { describe, expect, it } from "bun:test";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import { type Message, type Space, Spectrum } from "spectrum-ts";
import type { LinqClient } from "../src/client";
import { linq, normalizeFusorWebhookRequest } from "../src/index";

// Encode the protobuf envelope Fusor POSTs: a RawInboundEvent whose rawRequest
// is the platform's original HTTP/1.1 wire bytes (headers + JSON body).
const encodeEvent = (httpBody: string): Uint8Array => {
  const wire = `POST /linq HTTP/1.1\r\ncontent-type: application/json\r\n\r\n${httpBody}`;
  return RawInboundEvent.encode(
    RawInboundEvent.create({
      eventId: "evt-int-1",
      projectId: "proj",
      platform: "linq",
      rawRequest: new TextEncoder().encode(wire),
    })
  ).finish();
};

const receivedTextEnvelope = (text: string): string =>
  JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "evt-int-1",
    created_at: "2026-05-29T00:00:00Z",
    trace_id: "t",
    partner_id: "p",
    data: {
      id: "m-int-1",
      chat: { id: "chat-int-1" },
      direction: "inbound",
      parts: [{ type: "text", value: text }],
      sender_handle: {
        id: "u-int-1",
        handle: "+15551112222",
        joined_at: "2026-05-29T00:00:00Z",
        service: "iMessage",
        is_me: false,
      },
      service: "iMessage",
      sent_at: "2026-05-29T00:00:01Z",
    },
  });

const typingStartedEnvelope = (): string =>
  JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "chat.typing_indicator.started",
    event_id: "evt-typing-1",
    created_at: "2026-05-29T00:00:00Z",
    trace_id: "t",
    partner_id: "p",
    data: { chat_id: "chat-int-1" },
  });

const jsonRelayRequest = (httpBody: string): Request =>
  new Request("https://example.com/webhooks/fusor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      eventId: "evt-relay-1",
      projectId: "proj",
      platform: "linq",
      receivedAt: "2026-05-29T00:00:02Z",
      prevSubjectSeq: 0,
      request: {
        method: "POST",
        path: "/linq",
        headers: { "content-type": ["application/json"] },
        bodyEncoding: "json",
        body: JSON.parse(httpBody),
        rawBodyBase64: Buffer.from(httpBody, "utf8").toString("base64"),
      },
    }),
  });

describe("linq end-to-end via spectrum.webhook", () => {
  it("routes a LinQ message.received envelope to the handler as [space, message]", async () => {
    // No webhookSigningSecret → signature check is skipped for the smoke test.
    const app = await Spectrum({ providers: [linq.config({ apiKey: "k" })] });
    const delivered = Promise.withResolvers<{
      message: Message;
      space: Space;
    }>();

    const result = await app.webhook(
      {
        headers: {},
        body: encodeEvent(receivedTextEnvelope("hello from linq")),
      },
      (space, message) => {
        delivered.resolve({ message, space });
      }
    );

    expect(result.status).toBe(200);
    // Spectrum v12 acknowledges before invoking webhook handlers, so wait for
    // the detached delivery rather than assuming it completed with webhook().
    const { message, space } = await delivered.promise;
    expect(space.id).toBe("chat-int-1");
    expect(space.__platform).toBe("linq");
    expect(message.id).toBe("m-int-1");
    expect(message.direction).toBe("inbound");
    expect(message.platform).toBe("linq");
    expect(message.content).toEqual({ type: "text", text: "hello from linq" });
    expect(message.sender?.id).toBe("u-int-1");

    await app.stop();
  });

  it("returns a reaction Message from message.react()", async () => {
    const app = await Spectrum({ providers: [linq.config({ apiKey: "k" })] });
    const delivered = Promise.withResolvers<Message>();
    const reactionCalls: unknown[][] = [];
    const client = {
      addReaction: (messageId, input) => {
        reactionCalls.push([messageId, input]);
        return Promise.resolve();
      },
    } as LinqClient;
    const runtime = app.__internal.platforms.get("linq");
    if (!runtime) {
      throw new Error("LinQ platform runtime was not initialized");
    }
    runtime.store.set("linq.client", client);

    await app.webhook(
      { headers: {}, body: encodeEvent(receivedTextEnvelope("react to me")) },
      (_space, message) => {
        delivered.resolve(message);
      }
    );
    const message = await delivered.promise;
    const sentReaction = await message.react("👍");

    expect(sentReaction).toMatchObject({
      id: "reaction:m-int-1:self:%F0%9F%91%8D",
      direction: "outbound",
      platform: "linq",
      space: { id: "chat-int-1" },
      content: { type: "reaction", emoji: "👍" },
    });
    expect(reactionCalls).toEqual([
      ["m-int-1", { operation: "add", type: "like" }],
    ]);

    await app.stop();
  });

  it("delivers a typing indicator as a senderless message", async () => {
    const app = await Spectrum({ providers: [linq.config({ apiKey: "k" })] });
    const delivered = Promise.withResolvers<{
      message: Message;
      space: Space;
    }>();

    const result = await app.webhook(
      { headers: {}, body: encodeEvent(typingStartedEnvelope()) },
      (space, message) => {
        delivered.resolve({ message, space });
      }
    );

    expect(result.status).toBe(200);
    const { message, space } = await delivered.promise;
    expect(space.id).toBe("chat-int-1");
    expect(message.content).toEqual({ type: "typing", state: "start" });
    expect(message.sender).toBeUndefined();

    await app.stop();
  });

  it("accepts a Fusor schema-v1 JSON relay envelope", async () => {
    const app = await Spectrum({ providers: [linq.config({ apiKey: "k" })] });
    const delivered = Promise.withResolvers<{
      message: Message;
      space: Space;
    }>();
    const request = await normalizeFusorWebhookRequest(
      jsonRelayRequest(receivedTextEnvelope("hello from the JSON relay"))
    );

    const response = await app.webhook(request, (space, message) => {
      delivered.resolve({ message, space });
    });

    expect(response.status).toBe(200);
    const { message, space } = await delivered.promise;
    expect(space.id).toBe("chat-int-1");
    expect(message.platform).toBe("linq");
    expect(message.content).toEqual({
      type: "text",
      text: "hello from the JSON relay",
    });

    await app.stop();
  });

  it("returns 400 when the platform signature is wrong (poison, no retry)", async () => {
    const app = await Spectrum({
      providers: [
        linq.config({ apiKey: "k", webhookSigningSecret: "whsec_x" }),
      ],
    });

    const result = await app.webhook(
      {
        headers: {
          "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-webhook-signature": "deadbeef",
        },
        body: encodeEvent(receivedTextEnvelope("nope")),
      },
      () => undefined
    );

    expect(result.status).toBe(400);
    await app.stop();
  });
});
