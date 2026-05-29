"use strict";

const { randomUUID } = require("crypto");

/**
 * In-memory job store. Stable enough for a single PDF service instance
 * — the only consumer is da-platform polling /api/pdf/status/:jobId.
 * If we scale to multiple PDF service instances behind a load balancer
 * later, this becomes Redis or a Supabase table; the interface is kept
 * narrow so swapping is cheap.
 *
 * Job lifecycle:
 *   pending  → render queued
 *   running  → Puppeteer / pdf-lib active
 *   complete → s3Key + signedUrl available
 *   failed   → error string available
 *
 * Finished jobs (complete | failed) are garbage-collected after
 * JOB_TTL_MINUTES so memory stays bounded. The polling client should
 * see the terminal status within that window.
 */

const jobs = new Map();
const TTL_MS = (Number(process.env.JOB_TTL_MINUTES) || 30) * 60 * 1000;

function createJob() {
  const id = randomUUID();
  const job = {
    id,
    status: "pending",
    createdAt: Date.now(),
    s3Key: null,
    signedUrl: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) ?? null;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

/**
 * Periodically drop jobs that finished more than TTL_MS ago. Runs every
 * 5 minutes — cheap pass over a Map<jobId, job>.
 */
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if ((job.status === "complete" || job.status === "failed") && (job.updatedAt ?? job.createdAt) < cutoff) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = { createJob, getJob, updateJob };
