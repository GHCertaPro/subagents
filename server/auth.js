// server/auth.js
//
// Multi-tenant API key auth.
//
// requireApiKey:
//   Looks up x-api-key in the bot_tokens DB table (with 60-second in-memory
//   cache to avoid DB round-trips on every request). Attaches req.bot_id and
//   req.displayName on success.
//
//   Fallback: if the DB lookup fails for any reason (e.g. table not yet
//   migrated), falls back to the BOT_KEYS env var so the server stays live
//   during the migration window.
//
// requireAdmin:
//   Checks x-api-key against process.env.ADMIN_KEY. Attaches req.isAdmin = true.

import { getPool } from "./db.js";
import jwt from "jsonwebtoken";

// ── In-memory cache for DB-backed token lookups ──────────────────────────────
// Key: api_key string → Value: { bot_id, display_name, cachedAt }
const tokenCache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCached(apiKey) {
  const entry = tokenCache.get(apiKey);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    tokenCache.delete(apiKey);
    return null;
  }
  return entry;
}

function setCached(apiKey, botId, displayName) {
  tokenCache.set(apiKey, { bot_id: botId, display_name: displayName, cachedAt: Date.now() });
}

// ── BOT_KEYS env fallback (backward compat during migration window) ──────────
function loadBotKeysFromEnv() {
  const raw = process.env.BOT_KEYS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed; // { bot_id: key, ... }
      }
    } catch {
      // ignore parse errors
    }
  }
  const legacyKey = process.env.API_KEY;
  if (legacyKey && legacyKey.trim()) {
    return { cos: legacyKey.trim() };
  }
  return null;
}

// ── requireApiKey ─────────────────────────────────────────────────────────────
export async function requireApiKey(req, res, next) {
  const provided = req.get("x-api-key");
  if (!provided) {
    return res.status(401).json({ error: "Unauthorized: missing x-api-key header." });
  }

  // 1. Check in-memory cache
  const cached = getCached(provided);
  if (cached) {
    req.bot_id = cached.bot_id;
    req.displayName = cached.display_name;
    return next();
  }

  // 2. Try DB lookup
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT bot_id, display_name FROM bot_tokens WHERE api_key = $1",
      [provided]
    );
    if (result.rowCount > 0) {
      const { bot_id, display_name } = result.rows[0];
      setCached(provided, bot_id, display_name);
      req.bot_id = bot_id;
      req.displayName = display_name;
      return next();
    }
  } catch (err) {
    // DB unavailable or table missing — fall through to env-var fallback
    console.warn("[auth] DB lookup failed, falling back to BOT_KEYS env:", err.message);
  }

  // 3. Env-var fallback
  const botKeys = loadBotKeysFromEnv();
  if (botKeys) {
    const botId = Object.keys(botKeys).find((id) => botKeys[id] === provided);
    if (botId) {
      req.bot_id = botId;
      req.displayName = null;
      return next();
    }
  }

  return res.status(401).json({ error: "Unauthorized: invalid x-api-key." });
}

// ── verifyToken ──────────────────────────────────────────────────────────────
// JWT-based auth middleware for user-session protected routes.
// Reads Authorization: Bearer <jwt> or __auth_token cookie.
// Attaches req.user = { id, email, role } on success.
export function verifyToken(req, res, next) {
  let token = null;

  const authHeader = req.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (req.cookies && req.cookies.__auth_token) {
    token = req.cookies.__auth_token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    return res.status(500).json({ error: "JWT_SECRET is not configured." });
  }

  try {
    req.user = jwt.verify(token, secret.trim());
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ── requireAdmin ──────────────────────────────────────────────────────────────
export function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !adminKey.trim()) {
    return res.status(503).json({ error: "Admin access not configured." });
  }
  const provided = req.get("x-api-key");
  if (!provided || provided !== adminKey.trim()) {
    return res.status(401).json({ error: "Unauthorized: invalid admin key." });
  }
  req.isAdmin = true;
  next();
}
