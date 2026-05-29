"use strict";

const { Router } = require("express");

const router = Router();

/**
 * GET /api/health
 *
 * Unauthenticated. Used by:
 *   - da-platform deploy checks  (curl http://172.31.18.195:3001/api/health)
 *   - Future load balancer health probe if we scale horizontally.
 *
 * Reports versions + whether the AWS / API-key env is configured, so a
 * mis-deploy that loses .env can be spotted quickly. Does NOT echo the
 * key itself — boolean only.
 */
router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "da-pdf-service",
    version: require("../../package.json").version,
    node: process.version,
    uptime_seconds: Math.round(process.uptime()),
    configured: {
      api_key: Boolean(process.env.PDF_SERVICE_API_KEY),
      aws: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
      s3_bucket: process.env.S3_BUCKET ?? null,
    },
  });
});

module.exports = router;
