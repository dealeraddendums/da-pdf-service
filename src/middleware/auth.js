"use strict";

const { timingSafeEqual } = require("crypto");

/**
 * Shared-secret auth. da-platform calls every endpoint with
 * `X-API-Key: $PDF_SERVICE_API_KEY`. Fail-closed: if the env var isn't
 * set on the server, every request 503s — never accept anonymous.
 */
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

module.exports = function apiKeyAuth(req, res, next) {
  const expected = process.env.PDF_SERVICE_API_KEY;
  if (!expected) {
    console.error("[auth] PDF_SERVICE_API_KEY not set — refusing all requests");
    return res.status(503).json({ error: "PDF service not configured" });
  }
  const got = req.header("X-API-Key");
  if (!got || !safeEqual(got, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};
