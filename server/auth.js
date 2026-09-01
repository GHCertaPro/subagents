// server/auth.js
//
// Simple shared-secret auth for write routes (POST/PATCH). Not meant to be
// sophisticated — just enough that this isn't a fully open write endpoint
// on the public internet. Reads the expected value from process.env.API_KEY.

export function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected || !expected.trim()) {
    // Fail closed: if the operator hasn't configured a key, refuse writes
    // rather than silently running unauthenticated.
    return res.status(500).json({
      error: "Server misconfigured: API_KEY is not set.",
    });
  }

  const provided = req.get("x-api-key");
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid x-api-key header." });
  }

  next();
}
