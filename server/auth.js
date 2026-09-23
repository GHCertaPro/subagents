// server/auth.js
//
// Multi-tenant API key auth for write routes (POST/PATCH).
//
// Primary config: BOT_KEYS env var = JSON string like:
//   {"cos":"<key1>","dispatch":"<key2>"}
//
// The incoming x-api-key header is looked up in this map; the matching
// bot_id is attached to req.bot_id and passed through to route handlers.
//
// Backward compat: if BOT_KEYS is not set but API_KEY is, treat that
// as {"cos": API_KEY} so existing deployments continue to work unchanged.
//
// If neither is set: fail closed (500) to prevent unauthenticated writes.

function loadBotKeys() {
  const raw = process.env.BOT_KEYS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed; // { bot_id: key, ... }
      }
      console.error("[auth] BOT_KEYS is set but is not a valid JSON object — ignoring.");
    } catch (e) {
      console.error("[auth] BOT_KEYS is set but is not valid JSON:", e.message);
    }
  }

  // Fall back to legacy single-key mode
  const legacyKey = process.env.API_KEY;
  if (legacyKey && legacyKey.trim()) {
    return { cos: legacyKey.trim() };
  }

  return null; // neither set — fail closed
}

export function requireApiKey(req, res, next) {
  const botKeys = loadBotKeys();

  if (!botKeys) {
    return res.status(500).json({
      error: "Server misconfigured: neither BOT_KEYS nor API_KEY is set.",
    });
  }

  const provided = req.get("x-api-key");
  if (!provided) {
    return res.status(401).json({ error: "Unauthorized: missing x-api-key header." });
  }

  // Look up the provided key across all bots
  const botId = Object.keys(botKeys).find((id) => botKeys[id] === provided);
  if (!botId) {
    return res.status(401).json({ error: "Unauthorized: invalid x-api-key." });
  }

  req.bot_id = botId;
  next();
}
