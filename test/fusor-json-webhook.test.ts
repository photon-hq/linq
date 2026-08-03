import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";
import {
  FusorJsonWebhookError,
  normalizeFusorWebhookRequest,
} from "../src/webhook";

const SECRET = "outer-secret";
const TIMESTAMP = "1785792072";

const relayBody = JSON.stringify({
  schemaVersion: 1,
  eventId: "evt-json-1",
  projectId: "proj-json-1",
  platform: "linq",
  receivedAt: "2026-08-03T12:00:00Z",
  sourceId: "source-1",
  prevSubjectSeq: 4,
  request: {
    method: "POST",
    path: "/linq?source=test",
    headers: {
      "content-type": ["application/json"],
      "x-webhook-signature": ["inner-signature"],
    },
    bodyEncoding: "json",
    body: { event_type: "message.received" },
    rawBodyBase64: Buffer.from('{"event_type":"message.received"}').toString(
      "base64"
    ),
  },
});

const signature = createHmac("sha256", SECRET)
  .update(`v0:${TIMESTAMP}:`)
  .update(relayBody)
  .digest("hex");

const request = (providedSignature = `v0=${signature}`): Request =>
  new Request("https://example.com/webhooks/fusor", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-signature": providedSignature,
      "x-spectrum-timestamp": TIMESTAMP,
    },
    body: relayBody,
  });

describe("normalizeFusorWebhookRequest", () => {
  it("converts a signed schema-v1 JSON relay to Spectrum's protobuf envelope", async () => {
    const normalized = await normalizeFusorWebhookRequest(request(), {
      webhookSecret: SECRET,
    });
    const decoded = RawInboundEvent.decode(
      new Uint8Array(await normalized.arrayBuffer())
    );

    expect(decoded.eventId).toBe("evt-json-1");
    expect(decoded.projectId).toBe("proj-json-1");
    expect(decoded.platform).toBe("linq");
    expect(decoded.sourceId).toBe("source-1");
    expect(decoded.prevSubjectSeq).toBe(4);
    expect(new TextDecoder().decode(decoded.rawRequest)).toBe(
      'POST /linq?source=test HTTP/1.1\r\ncontent-type: application/json\r\nx-webhook-signature: inner-signature\r\n\r\n{"event_type":"message.received"}'
    );
  });

  it("rejects an invalid outer signature when a secret is configured", async () => {
    await expect(
      normalizeFusorWebhookRequest(request(`v0=${"0".repeat(64)}`), {
        webhookSecret: SECRET,
      })
    ).rejects.toMatchObject({
      name: FusorJsonWebhookError.name,
      status: 401,
    });
  });

  it("leaves protobuf and native Spectrum JSON requests untouched", async () => {
    const protobuf = new Request("https://example.com/webhooks/fusor", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array([10, 1, 120]),
    });
    const native = new Request("https://example.com/webhooks/spectrum", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "messages", message: {} }),
    });

    expect(await normalizeFusorWebhookRequest(protobuf)).toBe(protobuf);
    expect(await normalizeFusorWebhookRequest(native)).toBe(native);
  });
});
