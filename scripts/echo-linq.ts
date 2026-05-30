import { linq } from "@photon-ai/linq";
import { Spectrum, text } from "spectrum-ts";

/**
 * Minimal LinQ echo bot over Fusor webhook delivery, with an auto-started ngrok
 * tunnel so you have a public URL to paste into your Fusor subscription.
 *
 * Usage:
 *   LINQ_API_KEY=… \
 *   LINQ_WEBHOOK_SECRET=…           # LinQ's own webhook HMAC (inner verify)
 *   WEBHOOK_SECRET=…                # Fusor delivery signature (outer verify)
 *   PROJECT_ID=… PROJECT_SECRET=…   # optional (only for the gRPC stream)
 *   bun run scripts/echo-linq.ts
 *
 * Two independent signature layers are exercised here (both opt-in):
 *   - WEBHOOK_SECRET       → Spectrum verifies fusor signed the POST (X-Spectrum-*)
 *   - LINQ_WEBHOOK_SECRET  → the LinQ adapter verifies LinQ's webhook HMAC
 *
 * If `ngrok` is on your PATH (or already running), the public webhook URL is
 * printed on boot; otherwise start it yourself with `ngrok http <port>`.
 */

const PORT = Number(process.env.PORT ?? 8787);
const WEBHOOK_PATH = "/webhooks/fusor";
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const NGROK_BOOT_TIMEOUT_MS = 15_000;
const NGROK_POLL_INTERVAL_MS = 400;

type NgrokTunnel = { stop: () => void; url: string };

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

  const bin = Bun.which("ngrok");
  if (!bin) {
    return;
  }

  const proc = Bun.spawn([bin, "http", String(port), "--log", "stdout"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const deadline = Date.now() + NGROK_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(NGROK_POLL_INTERVAL_MS);
    const url = await fetchNgrokUrl();
    if (url) {
      return { url, stop: () => proc.kill() };
    }
  }

  proc.kill();
  return;
};

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  webhookSecret: process.env.WEBHOOK_SECRET,
  providers: [
    linq.config({
      apiKey: process.env.LINQ_API_KEY ?? "",
      webhookSigningSecret: process.env.LINQ_WEBHOOK_SECRET,
      defaultFrom: process.env.LINQ_DEFAULT_FROM,
    }),
  ],
});

const server = Bun.serve({
  port: PORT,
  routes: {
    [WEBHOOK_PATH]: {
      POST: (req) =>
        app.webhook(req, async (space, message) => {
          if (message.content.type === "text") {
            await space.send(text(`echo: ${message.content.text}`));
          }
        }),
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
