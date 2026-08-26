"use strict";

const { Router } = require("express");
const auth = require("../middleware/auth");
const { createJob, getJob } = require("../lib/job-store");
const { enqueueJob } = require("../lib/worker");
const { extractStyles } = require("../lib/style-extractor");

const router = Router();
router.use(auth);

/**
 * Render endpoints. All three return { jobId } immediately and the
 * actual Puppeteer / pdf-lib / S3 work happens in worker.js on the
 * event loop's next tick. Client polls GET /api/pdf/status/:jobId.
 *
 * Body shape per kind:
 *   generate     { html, paperSize?, customDims?, allPages?, s3Key? }
 *   bulk         { jobs: [{ html, paperSize?, customDims?, allPages? }, ...], s3Key? }
 *   buyer-guide  { srcPdfBase64, input: {...}, s3Key? }
 *
 * paperSize default is "standard" (4.25"x11" addendum). s3Key is the
 * canonical key da-platform wants the output uploaded to; if absent the
 * worker writes to pdf-service/YYYY-MM-DD/<jobId>.pdf so the result is
 * still retrievable.
 */

router.post("/generate", (req, res) => {
  const { html, s3Key } = req.body ?? {};
  if (typeof html !== "string" || html.length === 0) {
    return res.status(400).json({ error: "html (string) is required" });
  }
  const job = createJob();
  job.kind = "generate";
  job.s3Key = s3Key ?? null;
  enqueueJob(job, req.body);
  res.json({ jobId: job.id });
});

router.post("/bulk", (req, res) => {
  const { jobs: vehicleJobs, s3Key } = req.body ?? {};
  if (!Array.isArray(vehicleJobs) || vehicleJobs.length === 0) {
    return res.status(400).json({ error: "jobs (non-empty array) is required" });
  }
  for (let i = 0; i < vehicleJobs.length; i++) {
    if (typeof vehicleJobs[i]?.html !== "string" || !vehicleJobs[i].html) {
      return res.status(400).json({ error: `jobs[${i}].html is required` });
    }
  }
  const job = createJob();
  job.kind = "bulk";
  job.count = vehicleJobs.length;
  job.s3Key = s3Key ?? null;
  enqueueJob(job, req.body);
  res.json({ jobId: job.id });
});

router.post("/buyer-guide", (req, res) => {
  const { srcPdfBase64, input, s3Key } = req.body ?? {};
  // Pre-printed-label mode renders data-only on blank pages — no background
  // bytes needed. Full mode still requires the FTC source PDF.
  const isPreprinted = Boolean(input && typeof input === "object" && input.preprinted);
  if (!isPreprinted && (typeof srcPdfBase64 !== "string" || srcPdfBase64.length === 0)) {
    return res.status(400).json({ error: "srcPdfBase64 (string) is required" });
  }
  if (!input || typeof input !== "object" || !input.warranty || !input.dealer || !input.vehicle) {
    return res.status(400).json({ error: "input.{warranty, dealer, vehicle} required" });
  }
  const job = createJob();
  job.kind = "buyer-guide";
  job.s3Key = s3Key ?? null;
  enqueueJob(job, req.body);
  res.json({ jobId: job.id });
});

/**
 * "Match from URL" (2026-07-17): load a dealer's live page and return the
 * computed styles of the button whose text matches. SYNCHRONOUS (no job
 * store) — the page load is bounded to ~25 s inside the extractor, and the
 * caller (da-platform match-from-url) holds the request open. SSRF guards
 * (private-IP DNS gate, redirect cap, byte/time caps) live in the extractor.
 */
router.post("/extract-styles", async (req, res) => {
  const { url, buttonText } = req.body ?? {};
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url (string) is required" });
  }
  if (typeof buttonText !== "string" || !buttonText.trim() || buttonText.length > 120) {
    return res.status(400).json({ error: "buttonText (string, ≤120 chars) is required" });
  }
  try {
    const result = await extractStyles(url.trim(), buttonText.trim());
    if (result.error) {
      return res.status(result.blocked ? 422 : 404).json({ error: result.error, blocked: !!result.blocked });
    }
    return res.json(result);
  } catch (e) {
    console.error("[extract-styles] failed:", e);
    return res.status(500).json({ error: "Extraction failed" });
  }
});

router.get("/status/:jobId", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  const out = { jobId: job.id, status: job.status };
  if (job.status === "complete") {
    out.s3Key = job.s3Key;
    out.signedUrl = job.signedUrl;
    // Bulk: surface per-item s3Keys + signedUrls so da-platform can
    // skip its own uploadPdf and just record print_history rows.
    if (Array.isArray(job.items)) {
      const { signedGetUrl } = require("../lib/s3");
      out.items = await Promise.all(job.items.map(async (it) => {
        if (it.s3Key) return { s3Key: it.s3Key, signedUrl: await signedGetUrl(it.s3Key) };
        if (it.error) return { s3Key: null, error: it.error };
        return { s3Key: null };
      }));
    }
  } else if (job.status === "failed") {
    out.error = job.error;
  }
  res.json(out);
});

module.exports = router;
