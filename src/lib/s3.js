"use strict";

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/**
 * Thin S3 wrapper. Same bucket as the main app (dealer-addendums). AWS
 * creds come from env (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY); the
 * shared IAM identity has PutObject + GetObject on this bucket.
 *
 * Signed-URL TTL is 15 minutes — long enough for the polling client to
 * pick up the URL and start the download, short enough that a leaked
 * URL doesn't grant indefinite access. da-platform can re-sign if
 * needed by hitting GET /api/pdf/status/:jobId again.
 */

const REGION = process.env.AWS_REGION || "us-west-1";
const BUCKET = process.env.S3_BUCKET || "dealer-addendums";

const client = new S3Client({ region: REGION });

const SIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * @param {string} key
 * @param {Buffer} buffer
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.tags]  Object tag set to attach to
 *   the PutObject. Becomes the S3 `Tagging` query-string. Used to drive
 *   lifecycle rules — e.g. { doc_type: "addendum" } → expires in 180d,
 *   { doc_type: "buyer_guide" } → expires in 1d. PutObject Tagging
 *   REPLACES any prior tag set on the object, so every uploader that
 *   wants the lifecycle behavior must include the tag explicitly.
 */
async function uploadPdf(key, buffer, opts = {}) {
  const params = {
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "application/pdf",
  };
  if (opts.tags && Object.keys(opts.tags).length > 0) {
    // Tagging is a URL-encoded "key=value&key2=value2" string.
    params.Tagging = Object.entries(opts.tags)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }
  await client.send(new PutObjectCommand(params));
  return { bucket: BUCKET, key };
}

async function signedGetUrl(key, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: ttlSeconds },
  );
}

module.exports = { uploadPdf, signedGetUrl, BUCKET };
