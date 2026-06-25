"use strict";

const puppeteer = require("puppeteer");

/**
 * HTML → PDF renderer. Ported verbatim from
 * da-platform/lib/pdf-renderer.ts so output is byte-identical between
 * the two services (so the rollout can be A/B'd if needed).
 *
 * Paper size vocabulary matches the Builder's: 'standard' (4.25" addendum),
 * 'narrow' (3.125" addendum), 'infosheet' (8.5" full sheet), 'buyers_guide'
 * (8.5"). Custom sizes pass widthIn / heightIn directly.
 *
 * deviceScaleFactor 1.5625 is the legacy value that calibrates the on-screen
 * CSS px → printed inch ratio for the existing widget coordinates. Changing
 * it shifts every widget on every template — don't touch without re-anchoring.
 */

const KNOWN_WIDTHS = {
  standard:     "4.25in",
  narrow:       "3.125in",
  infosheet:    "8.5in",
  buyers_guide: "8.5in",
};

const KNOWN_CSS_WIDTHS = {
  standard:     408,
  narrow:       300,
  infosheet:    816,
  buyers_guide: 816,
};

const KNOWN_CSS_HEIGHTS = {
  standard:     1056,
  narrow:       1056,
  infosheet:    1056,
  buyers_guide: 1056,
};

/**
 * Launch a single Chrome instance for use across many renders. Caller is
 * responsible for closing it (`await browser.close()`).
 * --disable-dev-shm-usage avoids the small /dev/shm OOM that bites under
 * load in container/EC2 environments.
 */
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

async function renderPdf(html, paperSize, opts = {}) {
  const { customDims, allPages = false, browser: sharedBrowser } = opts;

  let widthStr;
  let cssW;
  let cssH;
  if (customDims) {
    widthStr = `${customDims.widthIn}in`;
    cssW = Math.round(customDims.widthIn * 96);
    cssH = Math.round(customDims.heightIn * 96);
  } else {
    widthStr = KNOWN_WIDTHS[paperSize] ?? "4.25in";
    cssW = KNOWN_CSS_WIDTHS[paperSize] ?? 408;
    cssH = KNOWN_CSS_HEIGHTS[paperSize] ?? 1056;
  }
  const heightStr = customDims ? `${customDims.heightIn}in` : "11in";

  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser ?? await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: cssW, height: cssH, deviceScaleFactor: 1.5625 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // External <img>s (e.g. product-brand logos served from S3) load over the
    // network *after* the DOM is parsed. domcontentloaded fires before they
    // finish, so capturing immediately renders them blank (the KARR logo bug).
    // Wait for every image to settle (load or error), capped at 15s so one hung
    // request can't stall the job. Base64-inlined images (logo/QR/photo) are
    // already complete and resolve instantly.
    await Promise.race([
      page.evaluate(() => Promise.all(
        Array.from(document.images).map((img) =>
          img.complete ? null : new Promise((res) => {
            img.addEventListener("load", res, { once: true });
            img.addEventListener("error", res, { once: true });
          })
        )
      )),
      new Promise((res) => setTimeout(res, 15_000)),
    ]).catch(() => {});
    const pdfBuffer = await page.pdf({
      width: widthStr,
      height: heightStr,
      printBackground: true,
      ...(allPages ? {} : { pageRanges: "1" }),
    });
    await page.close();
    return Buffer.from(pdfBuffer);
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

module.exports = { renderPdf, launchBrowser };
