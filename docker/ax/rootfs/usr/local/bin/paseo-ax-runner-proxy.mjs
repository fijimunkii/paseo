import { timingSafeEqual } from "node:crypto";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 8080;
const BOOTSTRAP_PATH = "/paseo/bootstrap/pairing";
const PAIRING_FILE = "/workspace/.paseo-host/pairing.json";
const CLAIMED_PAIRING_FILE = "/workspace/.paseo-host/pairing.claimed.json";
const BOOTSTRAP_COMPLETE_FILE = "/workspace/.paseo-host/bootstrap-complete";
const expectedToken = process.env.PASEO_AX_BOOTSTRAP_TOKEN ?? "";

function tokenMatches(value) {
  if (!expectedToken || typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function handlePairing(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end("method not allowed\n");
    return;
  }
  if (!tokenMatches(req.headers["x-paseo-bootstrap-token"])) {
    res.writeHead(401);
    res.end("unauthorized\n");
    return;
  }
  if (await exists(BOOTSTRAP_COMPLETE_FILE)) {
    res.writeHead(410);
    res.end("pairing bootstrap already consumed\n");
    return;
  }

  let claimed = false;
  try {
    await rename(PAIRING_FILE, CLAIMED_PAIRING_FILE);
    claimed = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (await exists(BOOTSTRAP_COMPLETE_FILE)) {
        res.writeHead(410);
        res.end("pairing bootstrap already consumed\n");
      } else {
        res.writeHead(503, { "Retry-After": "1" });
        res.end("pairing bootstrap not ready\n");
      }
      return;
    }
    res.writeHead(500);
    res.end("pairing bootstrap failed\n");
    return;
  }

  try {
    const payload = await readFile(CLAIMED_PAIRING_FILE, "utf8");
    JSON.parse(payload);
    await writeFile(BOOTSTRAP_COMPLETE_FILE, "paired\n", { mode: 0o600 });
    await unlink(CLAIMED_PAIRING_FILE).catch(() => undefined);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(payload);
  } catch {
    if (claimed && !(await exists(BOOTSTRAP_COMPLETE_FILE))) {
      await rename(CLAIMED_PAIRING_FILE, PAIRING_FILE).catch(() => undefined);
    }
    res.writeHead(500);
    res.end("pairing bootstrap failed\n");
  }
}

function proxyToRunner(req, res) {
  const upstream = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503);
    res.end("AX runner starting\n");
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }
  if (req.url === BOOTSTRAP_PATH) {
    void handlePairing(req, res);
    return;
  }
  proxyToRunner(req, res);
});

server.listen(80, "0.0.0.0");

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
