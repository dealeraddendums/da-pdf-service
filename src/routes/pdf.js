"use strict";

const { Router } = require("express");
const auth = require("../middleware/auth");
const { createJob, getJob } = require("../lib/job-store");

const router = Router();
router.use(auth);

/**
 * POST /api/pdf/generate    — render a single addendum or infosheet to PDF.
 * POST /api/pdf/bulk         — render N vehicles into one combined PDF.
 * POST /api/pdf/buyer-guide  — overlay variable text onto an FTC BG PDF.
 *
 * All three return { jobId } immediately. The renderer runs async in the
 * worker (added in Phase C). Client polls GET /api/pdf/status/:jobId.
 *
 * For Phase B these are STUBS — they validate the auth + payload shape
 * and create a pending job that never transitions. Phase C wires in the
 * Puppeteer / pdf-lib renderer ported from da-platform.
 */

router.post("/generate", (req, res) => {
  const { html, s3KeyHint } = req.body ?? {};
  if (typeof html !== "string" || html.length === 0) {
    return res.status(400).json({ error: "html (string) is required" });
  }
  const job = createJob();
  job.kind = "generate";
  job.s3KeyHint = s3KeyHint ?? null;
  // Phase C will actually enqueue the render here. For now mark complete
  // with no output — purely a contract check.
  res.json({ jobId: job.id });
});

router.post("/bulk", (req, res) => {
  const { jobs: vehicleHtmlList, s3KeyHint } = req.body ?? {};
  if (!Array.isArray(vehicleHtmlList) || vehicleHtmlList.length === 0) {
    return res.status(400).json({ error: "jobs (array of {html}) is required" });
  }
  const job = createJob();
  job.kind = "bulk";
  job.count = vehicleHtmlList.length;
  job.s3KeyHint = s3KeyHint ?? null;
  res.json({ jobId: job.id });
});

router.post("/buyer-guide", (req, res) => {
  const { templateKey, fields, s3KeyHint } = req.body ?? {};
  if (typeof templateKey !== "string" || !fields || typeof fields !== "object") {
    return res.status(400).json({ error: "templateKey + fields are required" });
  }
  const job = createJob();
  job.kind = "buyer-guide";
  job.templateKey = templateKey;
  job.fieldCount = Object.keys(fields).length;
  job.s3KeyHint = s3KeyHint ?? null;
  res.json({ jobId: job.id });
});

/**
 * GET /api/pdf/status/:jobId
 *
 * Polled by da-platform after a successful POST to one of the render
 * endpoints. Returns one of:
 *   { jobId, status: "pending" | "running" }
 *   { jobId, status: "complete", s3Key, signedUrl }
 *   { jobId, status: "failed", error }
 *
 * 404 once the job ages out of the in-memory store (default 30 min).
 */
router.get("/status/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  const out = { jobId: job.id, status: job.status };
  if (job.status === "complete") {
    out.s3Key = job.s3Key;
    out.signedUrl = job.signedUrl;
  } else if (job.status === "failed") {
    out.error = job.error;
  }
  res.json(out);
});

module.exports = router;
