// server/routes/auth.js
//
// User-account authentication routes:
//   POST /api/auth/invite/redeem — validate invite code, create user, return JWT
//   POST /api/auth/login         — email + password → JWT
//   GET  /api/auth/me            — verify JWT, return user info

import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getPool } from "../db.js";
import { verifyToken } from "../auth.js";

const router = Router();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error("JWT_SECRET env var is not set.");
  }
  return secret.trim();
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    getJwtSecret(),
    { expiresIn: "30d" }
  );
}

// ── POST /api/auth/invite/redeem ──────────────────────────────────────────────
// Body: { code, email, password }
// Validates invite code (not used, not expired), creates user, returns JWT.
router.post("/invite/redeem", async (req, res) => {
  const { code, email, password } = req.body ?? {};

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "code (string) is required." });
  }
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "email (string) is required." });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters." });
  }

  try {
    const pool = getPool();

    // Look up invite code
    const inviteRes = await pool.query(
      "SELECT * FROM invite_codes WHERE code = $1",
      [code.trim()]
    );
    if (inviteRes.rowCount === 0) {
      return res.status(404).json({ error: "Invite code not found." });
    }
    const invite = inviteRes.rows[0];

    if (invite.used_at) {
      return res.status(409).json({ error: "This invite code has already been used." });
    }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: "This invite code has expired." });
    }

    // Check if email already registered
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );
    if (existingUser.rowCount > 0) {
      return res.status(409).json({ error: "An account with this email already exists. Please log in." });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userRes = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'viewer')
       RETURNING id, email, role, created_at`,
      [email.trim().toLowerCase(), passwordHash]
    );
    const user = userRes.rows[0];

    // Mark invite as used
    await pool.query(
      "UPDATE invite_codes SET used_by_user_id = $1, used_at = NOW() WHERE id = $2",
      [user.id, invite.id]
    );

    // Create a personal bot_token for the new user
    const personalApiKey = crypto.randomBytes(32).toString("hex");
    const emailSlug = email.trim().toLowerCase().split("@")[0].replace(/[^a-z0-9]+/g, "-");
    const personalBotId = `${emailSlug}-${crypto.randomBytes(2).toString("hex")}`;
    await pool.query(
      `INSERT INTO bot_tokens (bot_id, api_key, display_name, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id) DO NOTHING`,
      [personalBotId, personalApiKey, `${email.trim().toLowerCase()}'s token`, user.id]
    );
    // Set the user's default_bot_id
    await pool.query("UPDATE users SET default_bot_id = $1 WHERE id = $2", [personalBotId, user.id]);

    const token = signToken(user);

    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      bot_token: personalApiKey,
    });
  } catch (err) {
    console.error("[POST /api/auth/invite/redeem] error:", err.message);
    return res.status(500).json({ error: "Failed to redeem invite." });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Body: { email, password }
// Returns JWT on success.
router.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required." });
  }
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "password is required." });
  }

  try {
    const pool = getPool();

    const userRes = await pool.query(
      "SELECT id, email, role, password_hash FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );
    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const user = userRes.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signToken(user);

    // Fetch the user's personal bot token (linked via user_id on bot_tokens)
    const botTokenResult = await pool.query(
      "SELECT api_key, bot_id FROM bot_tokens WHERE user_id = $1 LIMIT 1",
      [user.id]
    );
    const userBotToken = botTokenResult.rows[0]?.api_key ?? null;

    return res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      bot_token: userBotToken,
    });
  } catch (err) {
    console.error("[POST /api/auth/login] error:", err.message);
    return res.status(500).json({ error: "Login failed." });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Requires Authorization: Bearer <jwt>
// Returns { id, email, role } for the authenticated user.
router.get("/me", async (req, res) => {
  const authHeader = req.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }
  const token = authHeader.slice(7).trim();

  try {
    const payload = jwt.verify(token, getJwtSecret());
    return res.json({ id: payload.id, email: payload.email, role: payload.role });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
});

// ── GET /api/auth/me/token ────────────────────────────────────────────────────
// Requires Authorization: Bearer <jwt>
// Returns the user's personal bot token.
// { bot_token: <api_key or null>, bot_id: <bot_id or null> }
router.get("/me/token", verifyToken, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT api_key, bot_id FROM bot_tokens WHERE user_id = $1 LIMIT 1",
      [req.user.id]
    );
    const row = result.rows[0];
    return res.json({
      bot_token: row?.api_key ?? null,
      bot_id: row?.bot_id ?? null,
    });
  } catch (err) {
    console.error("[GET /api/auth/me/token] error:", err.message);
    return res.status(500).json({ error: "Failed to fetch bot token." });
  }
});

export default router;
