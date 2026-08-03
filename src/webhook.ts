import { createHmac, timingSafeEqual } from "node:crypto";
import { RawInboundEvent } from "@photon-ai/proto/photon/fusor/v1/inbound";

const SIGNATURE_HEADER = "x-spectrum-signature";
const TIMESTAMP_HEADER = "x-spectrum-timestamp";
const SIGNATURE_PREFIX = "v0=";
const SIGNATURE_SCHEME = "v0";
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLATFORM = /^[a-z0-9_-]+$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WHITESPACE = /\s/g;
const LINE_BREAK = /[\r\n]/;
const INVALID_PATH_CHARACTER = /[\r\n ]/;

type JsonRecord = Record<string, unknown>;

export class FusorJsonWebhookError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "FusorJsonWebhookError";
    this.status = status;
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (record: JsonRecord, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FusorJsonWebhookError(
      `Fusor JSON webhook is missing a valid ${key}`
    );
  }
  return value;
};

const verifyOuterSignature = (
  request: Request,
  body: Uint8Array,
  secret: string
): void => {
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const provided = request.headers.get(SIGNATURE_HEADER);
  if (!(timestamp && provided)) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook is missing signature headers",
      401
    );
  }

  const providedHex = provided.startsWith(SIGNATURE_PREFIX)
    ? provided.slice(SIGNATURE_PREFIX.length)
    : provided;
  if (!HEX_SIGNATURE.test(providedHex)) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook signature is malformed",
      401
    );
  }

  const expected = createHmac("sha256", secret)
    .update(`${SIGNATURE_SCHEME}:${timestamp}:`)
    .update(body)
    .digest();
  const actual = Buffer.from(providedHex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook signature mismatch",
      401
    );
  }
};

const decodeBase64 = (value: unknown): Uint8Array => {
  if (typeof value !== "string") {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook request is missing rawBodyBase64"
    );
  }
  const compact = value.replace(WHITESPACE, "");
  if (compact.length % 4 === 1 || !BASE64.test(compact)) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook rawBodyBase64 is malformed"
    );
  }
  return Buffer.from(compact, "base64");
};

const serializeHeaders = (value: unknown): string => {
  if (!isRecord(value)) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook request is missing headers"
    );
  }

  const lines: string[] = [];
  for (const [name, rawValue] of Object.entries(value)) {
    if (!TOKEN.test(name)) {
      throw new FusorJsonWebhookError(
        `Fusor JSON webhook contains an invalid header name: ${name}`
      );
    }
    let values: string[] | undefined;
    if (typeof rawValue === "string") {
      values = [rawValue];
    } else if (
      Array.isArray(rawValue) &&
      rawValue.every((item): item is string => typeof item === "string")
    ) {
      values = rawValue;
    }
    if (!values) {
      throw new FusorJsonWebhookError(
        `Fusor JSON webhook header ${name} has an invalid value`
      );
    }
    for (const headerValue of values) {
      if (LINE_BREAK.test(headerValue)) {
        throw new FusorJsonWebhookError(
          `Fusor JSON webhook header ${name} contains a line break`
        );
      }
      lines.push(`${name}: ${headerValue}\r\n`);
    }
  }
  return lines.join("");
};

const encodeRelayEnvelope = (envelope: JsonRecord): Uint8Array => {
  if (envelope.schemaVersion !== 1) {
    throw new FusorJsonWebhookError(
      `Unsupported Fusor JSON webhook schemaVersion: ${String(envelope.schemaVersion)}`
    );
  }

  const eventId = requiredString(envelope, "eventId");
  const projectId = requiredString(envelope, "projectId");
  const platform = requiredString(envelope, "platform");
  if (!PLATFORM.test(platform)) {
    throw new FusorJsonWebhookError(
      `Fusor JSON webhook contains an invalid platform: ${platform}`
    );
  }

  if (!isRecord(envelope.request)) {
    throw new FusorJsonWebhookError("Fusor JSON webhook is missing request");
  }
  const relayedRequest = envelope.request;
  const method = requiredString(relayedRequest, "method");
  const path = requiredString(relayedRequest, "path");
  if (!TOKEN.test(method)) {
    throw new FusorJsonWebhookError(
      `Fusor JSON webhook contains an invalid method: ${method}`
    );
  }
  if (!path.startsWith("/") || INVALID_PATH_CHARACTER.test(path)) {
    throw new FusorJsonWebhookError(
      `Fusor JSON webhook contains an invalid path: ${path}`
    );
  }

  const rawBody = decodeBase64(relayedRequest.rawBodyBase64);
  const headerLines = serializeHeaders(relayedRequest.headers);
  const rawRequest = Buffer.concat([
    Buffer.from(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n`, "utf8"),
    Buffer.from(rawBody),
  ]);

  const receivedAt =
    typeof envelope.receivedAt === "string"
      ? new Date(envelope.receivedAt)
      : undefined;
  if (receivedAt && Number.isNaN(receivedAt.getTime())) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook contains an invalid receivedAt"
    );
  }

  const sourceId =
    typeof envelope.sourceId === "string" ? envelope.sourceId : undefined;
  const prevSubjectSeq =
    typeof envelope.prevSubjectSeq === "number"
      ? envelope.prevSubjectSeq
      : undefined;
  if (
    prevSubjectSeq !== undefined &&
    (!Number.isSafeInteger(prevSubjectSeq) || prevSubjectSeq < 0)
  ) {
    throw new FusorJsonWebhookError(
      "Fusor JSON webhook contains an invalid prevSubjectSeq"
    );
  }

  return RawInboundEvent.encode(
    RawInboundEvent.create({
      eventId,
      platform,
      projectId,
      rawRequest,
      ...(receivedAt ? { receivedAt } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(prevSubjectSeq === undefined ? {} : { prevSubjectSeq }),
    })
  ).finish();
};

/**
 * Spectrum 12 accepts protobuf for its Fusor webhook path, while a Fusor HTTP
 * subscription can deliver the equivalent schema-v1 JSON relay envelope.
 * Convert only that relay shape; protobuf and native Spectrum JSON requests are
 * returned untouched so Spectrum can continue auto-detecting them itself.
 */
export const normalizeFusorWebhookRequest = async (
  request: Request,
  options: { webhookSecret?: string } = {}
): Promise<Request> => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("json")) {
    return request;
  }

  const body = new Uint8Array(await request.clone().arrayBuffer());
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return request;
  }

  // Native Spectrum JSON has `{ event, message }`; the Fusor relay has both
  // `schemaVersion` and `request`. Leave every other JSON shape to Spectrum.
  if (!(isRecord(parsed) && "schemaVersion" in parsed && "request" in parsed)) {
    return request;
  }

  if (options.webhookSecret) {
    verifyOuterSignature(request, body, options.webhookSecret);
  }
  const encoded = encodeRelayEnvelope(parsed);
  return new Request(request.url, {
    method: request.method,
    headers: { "content-type": "application/x-protobuf" },
    body: encoded,
  });
};
