// Team logins: users, sessions and the /api/auth + /api/users endpoints.
// Passwords are scrypt hashes; sessions are random tokens kept in an HttpOnly cookie and
// stored only as SHA-256 hashes. Roles match the app: admin, performance, staff (read-only).
import crypto from "node:crypto";

export const ROLES = ["admin", "performance", "staff"];
const COOKIE = "ch_session";
const SESSION_DAYS = 30;
const USERNAME = /^[a-z0-9._-]{3,32}$/;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function checkPassword(password, stored) {
  const [, salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex"), b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// clients: null = every client; otherwise the client ids this person may see (admins always see all).
const parseClients = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : null; } catch { return null; } };
const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role, disabled: !!u.disabled, created_at: u.created_at, last_login_at: u.last_login_at, clients: u.role === "admin" ? null : parseClients(u.clients) };
export function allowedClients(user) {
  if (!user || user.role === "admin") return null;
  const list = parseClients(user.clients);
  return list ? new Set(list) : null;
}
function cleanClients(v) {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const list = [...new Set(v.map((x) => String(x).slice(0, 64)))].slice(0, 300);
  return list.length ? list : undefined; // at least one client, or null for all
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function isHttps(req) {
  const host = String(req.headers.host || "");
  return req.headers["x-forwarded-proto"] === "https" || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

export function createAuth(db, { readBody, sendJson }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "clients")) db.exec("ALTER TABLE users ADD COLUMN clients TEXT");
  const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;

  // First admin: until a user exists, /api/auth/setup accepts a one-time code printed to the server log.
  // The code is kept in the database so every server process (and restarts) share the same one.
  db.exec("CREATE TABLE IF NOT EXISTS auth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const storedCode = () => db.prepare("SELECT value FROM auth_settings WHERE key = 'setup_code'").get()?.value || null;
  if (!userCount()) {
    db.prepare("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('setup_code', ?)").run(crypto.randomBytes(5).toString("hex").toUpperCase());
    console.error(`no users yet: open /login and use setup code ${storedCode()} to create the first admin`);
  }

  const failures = new Map(); // ip -> { count, until }
  function limited(req) {
    const f = failures.get(clientIp(req));
    return f && f.count >= 8 && Date.now() < f.until;
  }
  function failed(req) {
    const ip = clientIp(req), f = failures.get(ip);
    const next = f && Date.now() < f.until ? { count: f.count + 1, until: f.until } : { count: 1, until: Date.now() + 15 * 60 * 1000 };
    failures.set(ip, next);
  }

  function startSession(req, res, user) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
      .run(sha256(token), user.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString());
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now.toISOString(), user.id);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? "; Secure" : ""}`);
  }

  function currentUser(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`).get(sha256(token), new Date().toISOString());
    return row || null;
  }

  // Blocks cross-site form posts: a browser always sends Origin on cross-origin writes.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  const readJson = async (req) => JSON.parse((await readBody(req, 20_000)).toString("utf8") || "{}");
  const validName = (s) => String(s || "").trim().slice(0, 60);

  // Returns true when the request was an auth/users request and has been answered.
  async function handle(req, res, pathname) {
    if (!pathname.startsWith("/api/auth/") && !pathname.startsWith("/api/users")) return false;
    if (req.method !== "GET" && !sameOrigin(req)) return sendJson(res, 403, { error: "cross-site request blocked" }), true;
    const me = currentUser(req);

    if (req.method === "GET" && pathname === "/api/auth/me") {
      if (!me) sendJson(res, 401, { error: "signed out", setupNeeded: !userCount() });
      else sendJson(res, 200, { user: publicUser(me) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      if (limited(req)) return sendJson(res, 429, { error: "Too many attempts. Try again in 15 minutes." }), true;
      const { username, password } = await readJson(req);
      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim().toLowerCase());
      if (!user || user.disabled || !checkPassword(String(password || ""), user.password_hash)) {
        failed(req);
        return sendJson(res, 401, { error: "Wrong username or password." }), true;
      }
      failures.delete(clientIp(req));
      startSession(req, res, user);
      return sendJson(res, 200, { user: publicUser(user) }), true;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const token = cookies(req)[COOKIE];
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return sendJson(res, 200, { ok: true }), true;
    }

    if (req.method === "POST" && pathname === "/api/auth/setup") {
      const setupCode = storedCode();
      if (userCount() || !setupCode) return sendJson(res, 409, { error: "Setup is already done. Sign in instead." }), true;
      if (limited(req)) return sendJson(res, 429, { error: "Too many attempts. Try again in 15 minutes." }), true;
      const body = await readJson(req);
      if (String(body.code || "").trim().toUpperCase() !== setupCode) {
        failed(req);
        return sendJson(res, 403, { error: "That setup code is not right. It is in the server log." }), true;
      }
      const error = checkNew(body);
      if (error) return sendJson(res, 400, { error }), true;
      const user = insertUser({ ...body, role: "admin" });
      db.prepare("DELETE FROM auth_settings WHERE key = 'setup_code'").run();
      startSession(req, res, user);
      return sendJson(res, 200, { user: publicUser(user) }), true;
    }

    if (!me) return sendJson(res, 401, { error: "signed out" }), true;

    if (req.method === "POST" && pathname === "/api/auth/password") {
      const { current, next } = await readJson(req);
      if (!checkPassword(String(current || ""), me.password_hash)) return sendJson(res, 400, { error: "Your current password is not right." }), true;
      if (String(next || "").length < 8) return sendJson(res, 400, { error: "Use at least 8 characters." }), true;
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(next)), me.id);
      const token = cookies(req)[COOKIE];
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(me.id, sha256(token || ""));
      return sendJson(res, 200, { ok: true }), true;
    }

    // ---- user management (admins only) ----
    if (me.role !== "admin") return sendJson(res, 403, { error: "Only admins can manage users." }), true;

    if (req.method === "GET" && pathname === "/api/users") {
      const users = db.prepare("SELECT * FROM users ORDER BY disabled, role, name").all().map(publicUser);
      return sendJson(res, 200, { users }), true;
    }

    if (req.method === "POST" && pathname === "/api/users") {
      const body = await readJson(req);
      const error = checkNew(body) || (!ROLES.includes(body.role) ? "Pick a role." : null) || (body.clients !== undefined && body.clients !== null && cleanClients(body.clients) === undefined ? "Pick at least one client, or All clients." : null);
      if (error) return sendJson(res, 400, { error }), true;
      return sendJson(res, 200, { user: publicUser(insertUser(body)) }), true;
    }

    const match = pathname.match(/^\/api\/users\/(\d+)$/);
    if (match) {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(match[1]));
      if (!user) return sendJson(res, 404, { error: "User not found." }), true;
      const self = user.id === me.id;
      const lastAdmin = user.role === "admin" && !user.disabled && activeAdmins() <= 1;

      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (body.role !== undefined && !ROLES.includes(body.role)) return sendJson(res, 400, { error: "Pick a role." }), true;
        if ((body.role && body.role !== "admin" || body.disabled) && (self || lastAdmin)) {
          return sendJson(res, 400, { error: self ? "You cannot remove your own admin access." : "Keep at least one active admin." }), true;
        }
        if (body.password !== undefined && String(body.password).length < 8) return sendJson(res, 400, { error: "Use at least 8 characters." }), true;
        const clients = body.clients !== undefined ? cleanClients(body.clients) : "keep";
        if (clients === undefined) return sendJson(res, 400, { error: "Pick at least one client, or All clients." }), true;
        if (clients !== "keep") db.prepare("UPDATE users SET clients = ? WHERE id = ?").run(clients === null ? null : JSON.stringify(clients), user.id);
        const name = body.name !== undefined ? validName(body.name) : user.name;
        if (!name) return sendJson(res, 400, { error: "Enter a name." }), true;
        db.prepare("UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?")
          .run(name, body.role || user.role, body.disabled !== undefined ? (body.disabled ? 1 : 0) : user.disabled, user.id);
        if (body.password !== undefined) db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(body.password)), user.id);
        // a reset password or a disabled account signs that person out everywhere
        if (body.password !== undefined || body.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        return sendJson(res, 200, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) }), true;
      }

      if (req.method === "DELETE") {
        if (self || lastAdmin) return sendJson(res, 400, { error: self ? "You cannot delete your own account." : "Keep at least one active admin." }), true;
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  }

  function checkNew(body) {
    const username = String(body.username || "").trim().toLowerCase();
    if (!validName(body.name)) return "Enter a name.";
    if (!USERNAME.test(username)) return "Username: 3–32 characters, letters, numbers, dot, dash or underscore.";
    if (String(body.password || "").length < 8) return "Use at least 8 characters for the password.";
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return "That username is taken.";
    return null;
  }
  function insertUser(body) {
    const clients = cleanClients(body.clients ?? null);
    const info = db.prepare("INSERT INTO users (username, name, role, password_hash, created_at, clients) VALUES (?,?,?,?,?,?)")
      .run(String(body.username).trim().toLowerCase(), validName(body.name), body.role, hashPassword(String(body.password)), new Date().toISOString(), clients ? JSON.stringify(clients) : null);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid));
  }

  return { currentUser, handle, setupNeeded: () => !userCount() };
}
