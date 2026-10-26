import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Hostinger's LiteSpeed loader require()s this file, so no top-level await.
const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error("sqlite unavailable", error instanceof Error ? error.message : error);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "public");
// Hostinger publishes every deploy into a fresh hbuilds/versions/<build>/ folder, so data kept
// next to the code is lost on each deploy. There, keep it in the home folder instead.
const deployed = here.split(path.sep).includes("hbuilds");
const dataDir = process.env.DATA_DIR || (deployed ? path.join(os.homedir(), "ad-reports-data") : path.join(here, "data"));
const pdfDir = path.join(dataDir, "pdfs");
if (deployed && !process.env.DATA_DIR) recoverFromOldBuilds();

// One-time move: copy the newest data/ left behind in an earlier build folder.
function recoverFromOldBuilds() {
  try {
    if (fs.existsSync(path.join(dataDir, "workspace.db"))) return;
    const versions = path.resolve(here, "..", "..");
    const candidates = fs.readdirSync(versions)
      .map((name) => path.join(versions, name, "nodejs", "data"))
      .filter((dir) => dir !== path.join(here, "data") && fs.existsSync(path.join(dir, "workspace.db")))
      .sort((a, b) => fs.statSync(path.join(b, "workspace.db")).mtimeMs - fs.statSync(path.join(a, "workspace.db")).mtimeMs);
    if (!candidates.length) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.cpSync(candidates[0], dataDir, { recursive: true });
    console.error("data recovered from", candidates[0]);
  } catch (error) {
    console.error("data recovery skipped", error instanceof Error ? error.message : error);
  }
}
const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";

function loadEnv() {
  const file = path.join(here, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

let db = null;
if (DatabaseSync) {
  try {
    fs.mkdirSync(pdfDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, "workspace.db"));
    db.exec(`
  CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT,
    kind TEXT,
    body TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pdfs (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    filename TEXT,
    created_at TEXT NOT NULL
  );
`);
  } catch (error) {
    console.error("database unavailable", error instanceof Error ? error.message : error);
    db = null;
  }
}

const DENY = ["windsor", "openai", "gpt", "chatgpt", "supabase", "vercel", "telegram", "birch", "bïrch", "meta api"];
function blocked(text) {
  const lower = String(text || "").toLowerCase();
  return DENY.some((word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(lower));
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
};

function kolkataDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function buildLive(rows, endDate) {
  const byAccount = new Map();
  for (const row of rows) {
    const id = String(row.account_id || "");
    const date = String(row.date || "").slice(0, 10);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byAccount.has(id)) byAccount.set(id, { id, name: String(row.account_name || id), currency: String(row.account_currency || "INR"), days: {} });
    const account = byAccount.get(id);
    if (row.account_name) account.name = String(row.account_name);
    if (row.account_currency) account.currency = String(row.account_currency);
    account.days[date] = {
      spend: Number(row.spend) || 0,
      leads: Number(row.actions_lead) || 0,
      clicks: Number(row.link_clicks) || 0,
      impressions: Number(row.impressions) || 0,
    };
  }
  const spendOf = (account) => Object.values(account.days).reduce((sum, day) => sum + day.spend, 0);
  const accounts = [...byAccount.values()].sort((a, b) => spendOf(b) - spendOf(a));
  const palette = [
    ["#eee7db", "#9c8764"],
    ["#e6eddf", "#7d9569"],
    ["#e9e5ee", "#9a89aa"],
    ["#e3eaf0", "#7894a7"],
    ["#f1e5df", "#b18a71"],
    ["#e7e9e2", "#90997d"],
  ];
  const clients = accounts.map((account, index) => {
    const yesterday = account.days[endDate] || { spend: 0 };
    const [color, ink] = palette[index % palette.length];
    const active = yesterday.spend > 0;
    const currency = account.currency === "AED" ? "AED" : "INR";
    return {
      id: `c${account.id}`,
      name: account.name,
      sector: "Meta Ads",
      currency,
      budget: null,
      color,
      ink,
      severity: active ? "low" : "none",
      status: active ? "ready" : "skipped",
      pace: null,
      confidence: null,
      ai: true,
      reportEnabled: active,
      context: "Meta lead generation. Spend, impressions, link clicks, and leads are account totals for the selected dates.",
    };
  });
  const syncedLabel = `Live Meta sync · ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date())} IST`;
  return {
    endDate,
    endDay: Number(endDate.slice(-2)),
    mtdDays: Number(endDate.slice(-2)),
    syncedAt: new Date().toISOString(),
    syncedLabel,
    google: false,
    clients,
    accounts: accounts.map((account) => ({
      id: `fb${account.id}`,
      client: `c${account.id}`,
      platform: "meta",
      name: account.name,
      externalId: account.id,
      currency: account.currency === "AED" ? "AED" : "INR",
      days: account.days,
    })),
  };
}

async function syncLive() {
  const key = process.env.WINDSOR_API_KEY;
  const cachePath = path.join(dataDir, "live.json");
  if (!key) return null;
  const endDate = kolkataDate(-1);
  const startDate = kolkataDate(-45);
  try {
    const url = new URL("https://connectors.windsor.ai/facebook");
    url.searchParams.set("api_key", key);
    url.searchParams.set("fields", "date,account_id,account_name,account_currency,spend,impressions,link_clicks,actions_lead");
    url.searchParams.set("date_from", startDate);
    url.searchParams.set("date_to", endDate);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("live sync failed", response.status, String(payload.error || payload.message || "request failed"));
      return null;
    }
    const rows = Array.isArray(payload) ? payload : payload.data || [];
    const model = buildLive(rows, endDate);
    const previous = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : null;
    for (const account of model.accounts) account.ads = previous?.accounts?.find((a) => a.id === account.id)?.ads || [];
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(model));
    console.error("live sync", model.accounts.length, "accounts", rows.length, "rows", "through", endDate);
    syncAds(model, cachePath, startDate, endDate);
    return model;
  } catch (error) {
    console.error("live sync failed", String(error.message || error).replace(/api_key=[^&\s]+/gi, "api_key=redacted"));
    return null;
  }
}

// Ad-level daily rows (campaign / ad set / ad) for the client drill-down screens.
// Windsor is slow for this query, so it runs after the account totals are saved.
async function syncAds(model, cachePath, startDate, endDate) {
  try {
    const url = new URL("https://connectors.windsor.ai/facebook");
    url.searchParams.set("api_key", process.env.WINDSOR_API_KEY);
    url.searchParams.set("fields", "date,account_id,campaign_id,campaign,adset_id,adset_name,ad_id,ad_name,thumbnail_url,spend,impressions,link_clicks,actions_lead,actions_onsite_conversion_messaging_conversation_started_7d");
    url.searchParams.set("date_from", startDate);
    url.searchParams.set("date_to", endDate);
    const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("ad sync failed", response.status);
      return;
    }
    const rows = Array.isArray(payload) ? payload : payload.data || [];
    const byAccount = new Map();
    for (const row of rows) {
      const date = String(row.date || "").slice(0, 10);
      const adId = String(row.ad_id || "");
      if (!adId || !isoDate.test(date)) continue;
      const accountId = `fb${row.account_id}`;
      if (!byAccount.has(accountId)) byAccount.set(accountId, new Map());
      const ads = byAccount.get(accountId);
      if (!ads.has(adId)) ads.set(adId, { id: adId, name: "", campaignId: "", campaign: "", adsetId: "", adset: "", thumb: null, days: {} });
      const ad = ads.get(adId);
      ad.name = String(row.ad_name || ad.name).trim();
      ad.campaignId = String(row.campaign_id || ad.campaignId);
      ad.campaign = String(row.campaign || ad.campaign);
      ad.adsetId = String(row.adset_id || ad.adsetId);
      ad.adset = String(row.adset_name || ad.adset);
      if (/^https:\/\//.test(row.thumbnail_url || "")) ad.thumb = row.thumbnail_url;
      ad.days[date] = {
        spend: Number(row.spend) || 0,
        leads: Math.round(Number(row.actions_lead) || 0),
        clicks: Math.round(Number(row.link_clicks) || 0),
        impressions: Math.round(Number(row.impressions) || 0),
        conv: Math.round(Number(row.actions_onsite_conversion_messaging_conversation_started_7d) || 0),
      };
    }
    for (const account of model.accounts) {
      account.ads = [...(byAccount.get(account.id)?.values() || [])].filter((ad) => Object.values(ad.days).some((d) => d.spend > 0 || d.impressions > 0));
    }
    fs.writeFileSync(cachePath, JSON.stringify(model));
    console.error("ad sync", rows.length, "rows", model.accounts.reduce((n, a) => n + a.ads.length, 0), "ads");
  } catch (error) {
    console.error("ad sync failed", String(error.message || error).replace(/api_key=[^&\s]+/gi, "api_key=redacted"));
  }
}

const creativeCache = new Map();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

async function fetchCreatives(from, to, fresh = false) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) throw Object.assign(new Error("live data not configured"), { status: 503 });
  const cacheKey = `${from}|${to}`;
  const hit = creativeCache.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.body;
  const url = new URL("https://connectors.windsor.ai/facebook");
  url.searchParams.set("api_key", key);
  url.searchParams.set("fields", "account_name,account_currency,campaign,adset_name,ad_name,ad_id,thumbnail_url,spend,impressions,link_clicks,actions_lead,actions_onsite_conversion_messaging_conversation_started_7d");
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("creatives sync failed", response.status);
    throw Object.assign(new Error("live data request failed"), { status: 502 });
  }
  const rows = Array.isArray(payload) ? payload : payload.data || [];
  const ads = rows
    .filter((row) => Number(row.spend) > 0)
    .map((row) => ({
      account: String(row.account_name || ""),
      currency: row.account_currency === "AED" ? "AED" : "INR",
      campaign: String(row.campaign || ""),
      adset: String(row.adset_name || ""),
      name: String(row.ad_name || "").trim(),
      id: String(row.ad_id || ""),
      thumb: /^https:\/\//.test(row.thumbnail_url || "") ? row.thumbnail_url : null,
      spend: Number(row.spend) || 0,
      impressions: Math.round(Number(row.impressions) || 0),
      clicks: Math.round(Number(row.link_clicks) || 0),
      leads: Math.round(Number(row.actions_lead) || 0),
      conv: Math.round(Number(row.actions_onsite_conversion_messaging_conversation_started_7d) || 0),
    }));
  const body = { from, to, syncedAt: new Date().toISOString(), accounts: [...new Set(ads.map((ad) => ad.account))].sort(), ads };
  creativeCache.set(cacheKey, { at: Date.now(), body });
  if (creativeCache.size > 50) creativeCache.delete(creativeCache.keys().next().value);
  return body;
}

function readLive() {
  const cachePath = path.join(dataDir, "live.json");
  if (!fs.existsSync(cachePath)) return { clients: [], accounts: [], google: false };
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(raw);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fileFor(urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^[/\\]+/, "");
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.INTERNAL_CHAT_ID;
  if (!token || !chat) return { delivered: false, error: "telegram_not_configured" };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) return { delivered: false, error: "telegram_failed" };
  return { delivered: true, error: null };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/creatives") {
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!isoDate.test(from) || !isoDate.test(to) || !(span >= 0 && span <= 92)) return sendJson(res, 400, { error: "invalid dates" });
    return sendJson(res, 200, await fetchCreatives(from, to));
  }

  if (!db && pathname !== "/api/live") return sendJson(res, 503, { error: "database unavailable" });

  if (req.method === "GET" && pathname === "/api/live") {
    return sendJson(res, 200, readLive());
  }

  if (req.method === "GET" && pathname === "/api/state") {
    const row = db.prepare("SELECT data FROM workspace WHERE id = 1").get();
    if (!row) return sendJson(res, 200, null);
    return sendJson(res, 200, JSON.parse(row.data));
  }

  if (req.method === "POST" && pathname === "/api/state") {
    const raw = await readBody(req, 2_000_000);
    const data = JSON.parse(raw.toString("utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.staff)) return sendJson(res, 400, { error: "invalid workspace" });
    db.prepare("INSERT INTO workspace (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(JSON.stringify(data), new Date().toISOString());
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/outbox") {
    const data = JSON.parse((await readBody(req, 200_000)).toString("utf8"));
    const text = String(data.text || "");
    if (!text.trim()) return sendJson(res, 400, { error: "empty" });
    if (blocked(text)) {
      db.prepare("INSERT INTO outbox (client_id, kind, body, delivered, error, created_at) VALUES (?,?,?,?,?,?)")
        .run(String(data.client || ""), String(data.kind || "daily"), "[blocked]", 0, "denylist", new Date().toISOString());
      return sendJson(res, 422, { ok: false, blocked: true });
    }
    const delivery = await sendTelegram(text);
    db.prepare("INSERT INTO outbox (client_id, kind, body, delivered, error, created_at) VALUES (?,?,?,?,?,?)")
      .run(String(data.client || ""), String(data.kind || "daily"), text, delivery.delivered ? 1 : 0, delivery.error, new Date().toISOString());
    return sendJson(res, 200, { ok: true, delivered: delivery.delivered });
  }

  if (req.method === "POST" && pathname === "/api/pdf") {
    const bytes = await readBody(req, 12_000_000);
    if (bytes.subarray(0, 5).toString("utf8") !== "%PDF-") return sendJson(res, 415, { error: "not a pdf" });
    const id = String(req.headers["x-pdf-id"] || "").replace(/[^a-z0-9]/gi, "").slice(0, 80);
    if (!id) return sendJson(res, 400, { error: "missing id" });
    const client = String(req.headers["x-client"] || "client").replace(/[^a-z0-9-]/gi, "").slice(0, 32);
    const filename = decodeURIComponent(String(req.headers["x-filename"] || "report.pdf")).replace(/[^a-zA-Z0-9._-]/g, "_");
    fs.writeFileSync(path.join(pdfDir, `${id}.pdf`), bytes);
    db.prepare("INSERT INTO pdfs (id, client_id, filename, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, created_at = excluded.created_at")
      .run(id, client, filename, new Date().toISOString());
    return sendJson(res, 200, { ok: true, url: `/api/pdf/${id}` });
  }

  const pdf = pathname.match(/^\/api\/pdf\/([a-z0-9]+)$/i);
  if (req.method === "GET" && pdf) {
    const row = db.prepare("SELECT filename FROM pdfs WHERE id = ?").get(pdf[1]);
    const file = path.join(pdfDir, `${pdf[1]}.pdf`);
    if (!row || !fs.existsSync(file)) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${row.filename}"`,
      "Cache-Control": "private, max-age=3600",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/review") {
    const data = JSON.parse((await readBody(req, 200_000)).toString("utf8"));
    const key = process.env.OPENAI_API_KEY;
    if (!key) return sendJson(res, 200, { summary: null, mode: "rules" });
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a senior performance-marketing analyst. Use only the supplied metrics. Never mention internal tool names. Return JSON with summary and overall_severity (low, medium, or high)." },
          { role: "user", content: JSON.stringify({ client: data.name, currency: data.currency, metrics: data.metrics }) },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const content = payload.choices?.[0]?.message?.content;
    if (!response.ok || !content) return sendJson(res, 200, { summary: null, mode: "rules" });
    const parsed = JSON.parse(content);
    return sendJson(res, 200, { summary: String(parsed.summary || ""), severity: parsed.overall_severity || null, mode: "openai" });
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname).catch((error) => {
      console.error(error);
      if (res.headersSent) return;
      sendJson(res, error.status || 500, { error: "request failed" });
    });
    return;
  }

  const file = fileFor(url.pathname === "/creatives" ? "/creatives.html" : decodeURIComponent(url.pathname));
  if (!file) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  fs.stat(file, (err, stat) => {
    const target = !err && stat.isFile() ? file : path.join(root, "index.html");
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" || ext === ".js" ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`CreativHeads Ad Reports listening on ${port}`);
  syncLive();
  setInterval(syncLive, 3 * 60 * 60 * 1000).unref();
  // Windsor's ad-level query is slow (~45s), so keep the default "last 7 days" range warm.
  const warm = () => fetchCreatives(kolkataDate(-7), kolkataDate(-1), true).catch((error) => console.error("creatives warm failed", error.message));
  warm();
  setInterval(warm, 25 * 60 * 1000).unref();
});
