import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared-passcode gate and daily run quota for exposing the app through a tunnel.
//
// Off unless ACCESS_PASSCODE is set, so `npm run dev` behaves as before. When on:
//   - a request that arrives directly on this machine (loopback socket, no proxy
//     headers) is the owner and is never gated, limited or blocked;
//   - everything else needs the passcode (cookie set by /login);
//   - routes that spend API money count against DAILY_RUN_LIMIT / PER_IP_DAILY_LIMIT;
//   - the eval labelling routes, which write to disk, are not reachable from outside.
// Cloudflare sets Cf-Connecting-Ip on every proxied request and overwrites a client's
// own value, which is what makes "has a proxy header" a safe test for "came via tunnel".

const COOKIE = "da_access";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const MAX_LOGIN_BODY = 4096;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const PAID_ROUTES = [
  ["POST", /^\/api\/v2\/sessions$/],
  ["POST", /^\/api\/v2\/sessions\/[A-Za-z0-9_-]+\/react$/],
  ["POST", /^\/api\/recommend$/],
  ["POST", /^\/api\/preview-image$/]
];
const OWNER_ONLY = [/^\/api\/eval\//, /^\/api\/v2\/eval\//, /^\/eval-label\./, /^\/eval-rooms\//, /^\/v2\/label-critique\.html$/, /^\/v2\/compare\.html$/];

export function createAccessGate({ env = process.env, usageFile, now = () => new Date() } = {}) {
  const fails = new Map();

  // Returns true when it has answered the request itself (the caller must stop).
  return async function gate(req, res) {
    const passcode = env.ACCESS_PASSCODE;
    if (!passcode) return false;

    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "text/plain; charset=utf-8", "ok");
    if (isOwner(req)) return false;

    const ip = clientIp(req);
    if (url.pathname === "/login") {
      if (req.method === "POST") return await handleLogin(req, res, url, passcode, ip, fails, now);
      if (req.method === "GET") return send(res, 200, "text/html; charset=utf-8", loginPage(url.searchParams.get("next")));
    }

    if (!hasValidCookie(req, passcode)) {
      if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) {
        res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, "Cache-Control": "no-store" });
        res.end();
        return true;
      }
      return sendJson(res, { error: "Passcode required. Open the site in a browser and log in." }, 401);
    }

    if (OWNER_ONLY.some((pattern) => pattern.test(url.pathname))) {
      return sendJson(res, { error: "Not available remotely." }, 403);
    }

    if (env.DESIGN_AGENT_LIVE === "1" && PAID_ROUTES.some(([method, pattern]) => method === req.method && pattern.test(url.pathname))) {
      const verdict = takeQuota({ env, usageFile, ip, now: now() });
      if (!verdict.ok) return sendJson(res, { error: verdict.message }, 429);
    }
    return false;
  };
}

export function isOwner(req) {
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
  return local && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
}

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function token(passcode) {
  return crypto.createHmac("sha256", passcode).update("design-agent-access-v1").digest("hex");
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function hasValidCookie(req, passcode) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return safeEqual(rest.join("="), token(passcode));
  }
  return false;
}

async function handleLogin(req, res, url, passcode, ip, fails, now) {
  const record = fails.get(ip);
  if (record && record.until > now().getTime()) {
    return send(res, 429, "text/html; charset=utf-8", loginPage(null, "Too many attempts. Try again in a few minutes."));
  }
  const body = await readSmallBody(req);
  const form = new URLSearchParams(body);
  if (!safeEqual(form.get("passcode") || "", passcode)) {
    const count = (record?.count || 0) + 1;
    fails.set(ip, count >= LOGIN_MAX_FAILS ? { count: 0, until: now().getTime() + LOGIN_LOCKOUT_MS } : { count, until: 0 });
    return send(res, 401, "text/html; charset=utf-8", loginPage(form.get("next"), "Wrong passcode."));
  }
  fails.delete(ip);
  const secure = req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"] ? "; Secure" : "";
  res.writeHead(303, {
    Location: safeNext(form.get("next")),
    "Set-Cookie": `${COOKIE}=${token(passcode)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
    "Cache-Control": "no-store"
  });
  res.end();
  return true;
}

function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/v2/";
}

function readSmallBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_LOGIN_BODY) {
        reject(new Error("Login body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Counts one paid run against today's totals (local date), persisted so a restart
// does not reset the day. Only paid starts are counted, never reads.
function takeQuota({ env, usageFile, ip, now }) {
  const total = limit(env.DAILY_RUN_LIMIT, 30);
  const perIp = limit(env.PER_IP_DAILY_LIMIT, 10);
  const day = localDay(now);
  let usage = { day, total: 0, byIp: {} };
  if (usageFile && fs.existsSync(usageFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(usageFile, "utf8"));
      if (saved.day === day) usage = saved;
    } catch {
      // A corrupt usage file starts the day fresh rather than blocking everyone.
    }
  }
  if (total && usage.total >= total) return { ok: false, message: `Today's run limit (${total}) has been reached. Try again tomorrow.` };
  if (perIp && (usage.byIp[ip] || 0) >= perIp) return { ok: false, message: `You have used your ${perIp} runs for today. Try again tomorrow.` };
  usage.total += 1;
  usage.byIp[ip] = (usage.byIp[ip] || 0) + 1;
  if (usageFile) {
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    fs.writeFileSync(usageFile, `${JSON.stringify(usage)}\n`);
  }
  return { ok: true };
}

function limit(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function localDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
  return true;
}

function sendJson(res, body, status = 200) {
  return send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function loginPage(next, error) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Window Design Agent</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f5f2; color: #222; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { background: #fff; padding: 28px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); width: min(320px, 90vw); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  input, button { font: inherit; width: 100%; box-sizing: border-box; padding: 10px; margin-top: 8px; border-radius: 8px; }
  input { border: 1px solid #ccc; }
  button { border: 0; background: #2b2b2b; color: #fff; cursor: pointer; }
  .err { color: #b00020; font-size: 14px; margin: 0 0 8px; }
</style></head>
<body><form method="post" action="/login">
  <h1>Window Design Agent</h1>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <input type="hidden" name="next" value="${escapeHtml(next || "")}">
  <input type="password" name="passcode" placeholder="Passcode" autofocus required>
  <button type="submit">Enter</button>
</form></body></html>`;
}
