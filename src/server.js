"use strict";

require("dotenv").config();

const express = require("express");

const healthRouter = require("./routes/health");
const pdfRouter = require("./routes/pdf");

const app = express();

// 100 MB ceiling — bulk PDFs that combine 200+ vehicle pages can easily
// blow past Express's 1 MB default. Body is HTML + base64 logos; the
// produced PDF goes straight to S3, not back through the wire.
app.use(express.json({ limit: "100mb" }));

app.use("/api/health", healthRouter);
app.use("/api/pdf", pdfRouter);

// Catch-all 404 so unknown paths don't crash on unhandled rejection.
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Express default error handler returns HTML; we want JSON for an API.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal error" });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log(`[da-pdf-service] listening on :${port} (api-key=${process.env.PDF_SERVICE_API_KEY ? "set" : "MISSING"})`);
});
