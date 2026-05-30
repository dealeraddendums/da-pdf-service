"use strict";

const { Router } = require("express");
const auth = require("../middleware/auth");
const { createJob, getJob } = require("../lib/job-store");
const { enqueueJob } = require("../lib/worker");

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
  if (typeof srcPdfBase64 !== "string" || srcPdfBase64.length === 0) {
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
