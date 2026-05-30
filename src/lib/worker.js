"use strict";

const { randomUUID } = require("crypto");
const { PDFDocument } = require("pdf-lib");

const { updateJob } = require("./job-store");
const { renderPdf, launchBrowser } = require("./renderer");
const { applyBuyerGuideOverlay } = require("./buyer-guide-overlay");
const { uploadPdf, signedGetUrl } = require("./s3");

/**
 * Fire-and-forget dispatch for each render job.
 *
 * Job kinds:
 *   "generate"     — one HTML → one PDF
 *   "bulk"         — N HTMLs → merged PDF
 *   "buyer-guide"  — pdf-lib overlay onto a provided FTC background
 *
 * Caller (the POST route) creates the job in the store with status
 * 'pending', then awaits this call. We immediately flip to 'running',
 * do the work, and end in 'complete' or 'failed'. da-platform polls
 * GET /api/pdf/status/:jobId so it never blocks the user-facing flow.
 *
 * S3 key strategy: caller can pass a canonical key in `s3Key` so the
 * bucket layout stays in da-platform's control. If absent, we fall
 * back to a uuid prefix so the upload still succeeds and the URL is
 * still retrievable.
 */

function defaultKey(jobId) {
  return `pdf-service/${new Date().toISOString().slice(0, 10)}/${jobId}.pdf`;
}

async function runGenerate(job, body) {
  const { html, paperSize = "standard", customDims, allPages = false } = body;
  const buf = await renderPdf(html, paperSize, { customDims, allPages });
  const key = body.s3Key || defaultKey(job.id);
  await uploadPdf(key, buf);
  return { key };
}

async function runBulk(job, body) {
  const { jobs: items } = body;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("bulk: jobs[] empty");
  }
  // One shared Chrome process for the whole batch — launching one
  // browser per vehicle was the legacy hot-spot.
  const browser = await launchBrowser();
  const perItemResults = []; // { s3Key, error? } parallel to items
  let merged;
  try {
    const individualPdfs = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { html, paperSize = "standard", customDims, allPages = false, s3Key: itemKey } = item;
      try {
        const buf = await renderPdf(html, paperSize, { customDims, allPages, browser });
        individualPdfs.push(buf);
        // Upload per-item if caller supplied a per-vehicle key. Lets
        // da-platform skip its own uploadPdf in the bulk DB-logging
        // pipeline.
        if (itemKey) {
          await uploadPdf(itemKey, buf);
          perItemResults.push({ s3Key: itemKey });
        } else {
          perItemResults.push({ s3Key: null });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker bulk] item ${i} failed:`, message);
        perItemResults.push({ s3Key: null, error: message });
      }
    }
    if (individualPdfs.length === 0) {
      throw new Error("bulk: every item failed to render");
    }
    merged = await PDFDocument.create();
    for (const buf of individualPdfs) {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const out = Buffer.from(await merged.save());
  const key = body.s3Key || defaultKey(job.id);
  await uploadPdf(key, out);
  // Stash per-item results on the job so the status endpoint can return
  // them alongside the merged signedUrl when status === "complete".
  job.items = perItemResults;
  return { key };
}

async function runBuyerGuide(job, body) {
  const { srcPdfBase64, input } = body;
  if (!srcPdfBase64) throw new Error("buyer-guide: srcPdfBase64 required");
  if (!input) throw new Error("buyer-guide: input required");
  const srcBytes = Buffer.from(srcPdfBase64, "base64");
  const out = await applyBuyerGuideOverlay(srcBytes, input);
  const key = body.s3Key || defaultKey(job.id);
  await uploadPdf(key, out);
  return { key };
}

const DISPATCH = {
  generate:     runGenerate,
  bulk:         runBulk,
  "buyer-guide": runBuyerGuide,
};

function enqueueJob(job, body) {
  // Mark running synchronously so a fast poll right after the POST
  // doesn't briefly observe "pending → complete" without the
  // intermediate state.
  updateJob(job.id, { status: "running" });
  // setImmediate yields the event loop so the HTTP response goes out
  // first.
  setImmediate(async () => {
    try {
      const handler = DISPATCH[job.kind];
      if (!handler) throw new Error(`unknown job kind: ${job.kind}`);
      const { key } = await handler(job, body);
      const signedUrl = await signedGetUrl(key);
      updateJob(job.id, { status: "complete", s3Key: key, signedUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] job ${job.id} (${job.kind}) failed:`, message);
      updateJob(job.id, { status: "failed", error: message });
    }
  });
}

module.exports = { enqueueJob };
