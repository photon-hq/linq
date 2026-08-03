import {
  FusorJsonWebhookError,
  linq,
  normalizeFusorWebhookRequest,
} from "@photon-ai/linq";
import {
  type Content,
  type ContentBuilder,
  type Message,
  type Space,
  Spectrum,
} from "spectrum-ts";

/**
 * Minimal LinQ reply-echo bot over Fusor webhook delivery, with an auto-started
 * ngrok tunnel so you have a public URL to paste into your Fusor subscription.
 *
 * Unlike `echo-linq.ts` (which posts a standalone `echo: …` message), this echoes
 * each inbound message straight back: text, links, images and files thread under
 * the original via `message.reply()` (a LinQ `reply_to`), while voice notes echo
 * as a fresh voice memo (LinQ voice memos carry no `reply_to`, so they can't
 * thread). Multi-part messages are echoed one reply per part.
 *
 * Spectrum v12 replies as soon as the event is verified and then runs the echo
 * handler detached — Fusor's ack window isn't blocked by uploads (or, in a real
 * bot, slow AI work) that would otherwise time out and trigger an at-least-once
 * redelivery. Spectrum logs a thrown echo; a small in-memory dedup on
 * `message.id` guards against duplicates.
 *
 * Usage:
 *   LINQ_API_KEY=… \
 *   LINQ_WEBHOOK_SECRET=…           # LinQ's own webhook HMAC (inner verify)
 *   WEBHOOK_SECRET=…                # Fusor delivery signature (outer verify)
 *   PROJECT_ID=… PROJECT_SECRET=…   # optional (only for the gRPC stream)
 *   bun run scripts/reply-echo-linq.ts
 *
 * Two independent signature layers are exercised here (both opt-in):
 *   - WEBHOOK_SECRET       → the JSON relay normalizer verifies X-Spectrum-*
 *   - LINQ_WEBHOOK_SECRET  → the LinQ adapter verifies LinQ's webhook HMAC
 *
 * Echoing is loop-safe: our echo emits a `message.sent` webhook, which the LinQ
 * adapter ignores — so the bot never echoes its own echoes.
 *
 * If `ngrok` is on your PATH (or already running), the public webhook URL is
 * printed on boot; otherwise start it yourself with `ngrok http <port>`.
 */

const PORT = Number(process.env.PORT ?? 8787);
const WEBHOOK_PATH = "/webhooks/fusor";
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const NGROK_BOOT_TIMEOUT_MS = 15_000;
const NGROK_POLL_INTERVAL_MS = 400;

interface NgrokTunnel {
  stop: () => void;
  url: string;
}

/**
 * Wrap an already-resolved inbound `Content` back into a builder so it can be
 * echoed straight back through `reply()` or `send()`.
 */
const passthrough = (content: Content): ContentBuilder => ({
  build: async () => content,
});

// Inbound message ids we've already echoed. Spectrum v12 acknowledges before
// invoking the handler, but at-least-once delivery can still redeliver — this
// keeps the echo at-most-once. Bounded so it can't grow without limit.
const processed = new Set<string>();
const PROCESSED_CAP = 1000;
const alreadyEchoed = (id: string): boolean => {
  if (processed.has(id)) {
    return true;
  }
  processed.add(id);
  if (processed.size > PROCESSED_CAP) {
    const oldest = processed.values().next().value; // Set keeps insertion order
    if (oldest !== undefined) {
      processed.delete(oldest);
    }
  }
  return false;
};

/**
 * Echo one inbound message back to its space. Spectrum v12's webhook contract
 * replies first and runs this detached, so slow work (file uploads now, AI
 * workflows later) never delays Fusor's response. A throw is logged rather
 * than changing the already-computed HTTP response.
 *
 * Text, links, images and files thread back via `message.reply()`. Voice can't
 * thread (LinQ voice memos have no `reply_to`), so it's echoed as a fresh voice
 * memo via `space.send()`. Multi-part `group` messages are echoed per part.
 * System signals (reactions, typing, opaque custom) are skipped.
 */
const echoInbound = async (space: Space, message: Message): Promise<void> => {
  const { content } = message;
  if (
    content.type === "reaction" ||
    content.type === "typing" ||
    content.type === "custom"
  ) {
    return;
  }
  if (alreadyEchoed(message.id)) {
    return;
  }

  // Voice can't thread, so it goes out as a new voice memo; everything else
  // threads back via reply.
  const echo = (part: Content) =>
    part.type === "voice"
      ? space.send(passthrough(part))
      : message.reply(passthrough(part));

  const parts =
    content.type === "group"
      ? content.items.map((item) => item.content)
      : [content];
  // A throw here propagates to Spectrum, which logs it (we've already acked, so
  // there's no retry) — no local try/catch needed.
  for (const part of parts) {
    const sent = await echo(part);
    console.log(
      `[reply-echo] echoed ${message.id} in ${message.space.id} (id=${sent?.id})`
    );
  }

  // Tapback the original message (👍 → LinQ "like"). Best-effort.
  try {
    await message.react("👍");
    console.log(`[reply-echo] reacted 👍 to ${message.id}`);
  } catch (err) {
    console.error(`[reply-echo] react failed for ${message.id}:`, err);
  }
};

/** Read the public https URL from a running ngrok agent's local API. */
const fetchNgrokUrl = async (): Promise<string | undefined> => {
  try {
    const res = await fetch(NGROK_API);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as {
      tunnels?: { proto?: string; public_url?: string }[];
    };
    return data.tunnels?.find((t) => t.public_url?.startsWith("https://"))
      ?.public_url;
  } catch {
    // No agent listening on :4040 yet.
    return;
  }
};

/**
 * Return a public https tunnel to `port`: reuse a running ngrok agent if one is
 * already up, else spawn `ngrok http <port>` and poll until it's ready. Returns
 * undefined when ngrok isn't installed (caller falls back to manual setup).
 */
const startNgrok = async (port: number): Promise<NgrokTunnel | undefined> => {
  const existing = await fetchNgrokUrl();
  if (existing) {
    return { url: existing, stop: () => undefined };
  }

  const bin = globalThis.Bun.which("ngrok");
  if (!bin) {
    return;
  }

  const proc = globalThis.Bun.spawn(
    [bin, "http", String(port), "--log", "stdout"],
    {
      stdout: "ignore",
      stderr: "ignore",
    }
  );

  const deadline = Date.now() + NGROK_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await globalThis.Bun.sleep(NGROK_POLL_INTERVAL_MS);
    const url = await fetchNgrokUrl();
    if (url) {
      return { url, stop: () => proc.kill() };
    }
  }

  proc.kill();
  return;
};

const provider = linq.config({
  apiKey: process.env.LINQ_API_KEY ?? "",
  webhookSigningSecret: process.env.LINQ_WEBHOOK_SECRET,
  defaultFrom: process.env.LINQ_DEFAULT_FROM,
});
const projectId = process.env.PROJECT_ID;
const projectSecret = process.env.PROJECT_SECRET;
if (Boolean(projectId) !== Boolean(projectSecret)) {
  throw new Error("Set both PROJECT_ID and PROJECT_SECRET, or neither.");
}
const app =
  projectId && projectSecret
    ? await Spectrum({ projectId, projectSecret, providers: [provider] })
    : await Spectrum({ providers: [provider] });

const server = globalThis.Bun.serve({
  port: PORT,
  routes: {
    [WEBHOOK_PATH]: {
      // Spectrum v12 invokes echoInbound after computing the response, so a
      // slow echo never blocks Fusor's acknowledgement window.
      POST: async (req) => {
        try {
          const normalized = await normalizeFusorWebhookRequest(req, {
            webhookSecret: process.env.WEBHOOK_SECRET,
          });
          return await app.webhook(normalized, echoInbound);
        } catch (error) {
          if (error instanceof FusorJsonWebhookError) {
            return new Response(error.message, { status: error.status });
          }
          throw error;
        }
      },
    },
  },
});

console.log(`Listening on :${PORT}${WEBHOOK_PATH}`);

const tunnel = await startNgrok(PORT);
if (tunnel) {
  console.log("\nPublic webhook URL (point your Fusor subscription here):");
  console.log(`  ${tunnel.url}${WEBHOOK_PATH}\n`);
} else {
  console.log(
    `\nngrok not started automatically — run it yourself:\n  ngrok http ${PORT}\nthen use https://<id>.ngrok.app${WEBHOOK_PATH}\n`
  );
}

// Spectrum installs its own SIGINT/SIGTERM handlers (stop + exit); we only need
// to tear down ngrok and the HTTP server alongside them.
const shutdown = () => {
  tunnel?.stop();
  server.stop(true);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
