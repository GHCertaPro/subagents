// server/db.js
//
// Single shared pg Pool, reading its connection string from
// process.env.DATABASE_URL. Never hardcode a connection string here.

import pg from "pg";

let pool = null;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !connectionString.trim()) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill in a " +
        "real Neon connection string."
    );
  }

  pool = new pg.Pool({
    connectionString,
    // Neon requires SSL; most Neon connection strings already include
    // ?sslmode=require, but this is a harmless belt-and-suspenders default
    // for environments that strip query params.
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}
