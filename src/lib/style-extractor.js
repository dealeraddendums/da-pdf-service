"use strict";

const dns = require("dns").promises;
const net = require("net");
// Lazy so the pure guard helpers stay requireable without puppeteer installed.
const getLaunchBrowser = () => require("./renderer").launchBrowser;

/**
 * Live-page button style extraction ("Match from URL", 2026-07-17).
 *
 * Loads a dealer's page in the shared Puppeteer Chrome, finds the visible
 * element whose text matches `buttonText`, and returns its computed styles
 * (plus a best-effort :hover diff captured by actually hovering it).
 *
 * SSRF posture — this endpoint fetches operator-supplied URLs from inside
 * the VPC, so every request the page makes is gated:
 *   - http/https only, both on the input URL and every sub-request
 *   - every hostname is DNS-resolved and private / loopback / link-local /
 *     CGN / metadata ranges are aborted (IP literals included; results
 *     cached per host for the page's lifetime)
 *   - main-frame redirect chains cap at 5 hops
 *   - cumulative response bytes cap at 20 MB, wall clock caps at 25 s
 */

const MAX_REDIRECTS = 5;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 15000;
const HARD_TIMEOUT_MS = 25000;

/** True when the IP must never be fetched (private/loopback/link-local/etc.). */
function isForbiddenIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:a.b.c.d) — recheck as v4
    const v4 = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? isForbiddenIp(v4[1]) : false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;          // this-net, private, loopback
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGN
  if (a >= 224) return true;                                  // multicast/reserved
  return false;
}

/** Resolve a hostname and decide if it's safe to fetch. Cached per-extraction. */
async function hostAllowed(hostname, cache) {
  if (cache.has(hostname)) return cache.get(hostname);
  let allowed = false;
  try {
    if (net.isIP(hostname)) {
      allowed = !isForbiddenIp(hostname);
    } else {
      const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
      allowed = addrs.length > 0 && addrs.every((a) => !isForbiddenIp(a.address));
    }
  } catch {
    allowed = false; // unresolvable — nothing to fetch anyway
  }
  cache.set(hostname, allowed);
  return allowed;
}

/** Validate the top-level URL shape before any network work. */
function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: "Invalid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "Only http(s) URLs are supported" };
  }
  return { url: u };
}

const STYLE_PROPS = [
  "background-color", "color",
  "font-family", "font-size", "font-weight", "letter-spacing", "text-transform",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-top-style", "border-top-color", "border-radius",
  "box-shadow", "display", "text-align", "line-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "text-decoration-line",
];

// Runs inside the page: find visible candidates whose text matches, score them.
function findCandidatesInPage(needle, props) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(needle);
  const els = [...document.querySelectorAll("a, button, [role=button], input[type=submit], input[type=button]")];
  const seen = new Set();
  const domEls = [];
  const out = [];
  for (const el of els) {
    const text = norm(el.innerText || el.value);
    if (!text || !(text === target || text.includes(target))) continue;
    if (el.offsetParent === null) continue; // hidden
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const bg = cs.getPropertyValue("background-color");
    const padY = parseFloat(cs.getPropertyValue("padding-top")) + parseFloat(cs.getPropertyValue("padding-bottom"));
    const padX = parseFloat(cs.getPropertyValue("padding-left")) + parseFloat(cs.getPropertyValue("padding-right"));
    const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    // Most-button-like scoring: exact text > substring; painted background and
    // real padding are what separate a styled CTA from a plain text link.
    let score = 0;
    if (text === target) score += 4;
    if (hasBg) score += 4;
    if (padY >= 8) score += 2;
    if (padX >= 12) score += 1;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 1;
    const styles = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);
    const parentW = el.parentElement ? el.parentElement.getBoundingClientRect().width : 0;
    domEls.push(el);
    out.push({
      index: out.length, score,
      tag: el.tagName.toLowerCase(),
      className: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 160),
      text: (el.innerText || el.value || "").trim().slice(0, 80),
      rectWidth: Math.round(rect.width), rectHeight: Math.round(rect.height),
      parentWidth: Math.round(parentW),
      fullWidth: parentW > 40 && rect.width / parentW > 0.93,
      styles,
      outerHTML: el.outerHTML.slice(0, 500),
    });
    if (out.length >= 10) break;
  }
  out.sort((a, b) => b.score - a.score);
  // Tag the winner on the live DOM so the hover pass can find it by selector.
  if (out.length) domEls[out[0].index].setAttribute("data-da-style-winner", "1");
  return out;
}

/**
 * Extract computed styles for the button matching `buttonText` on `url`.
 * Returns { match, candidates } or { error, blocked? }.
 */
async function extractStyles(url, buttonText) {
  const v = validateUrl(url);
  if (v.error) return { error: v.error, blocked: true };
  const target = v.url;

  const dnsCache = new Map();
  if (!(await hostAllowed(target.hostname, dnsCache))) {
    return { error: "This address can't be fetched", blocked: true };
  }

  const browser = await getLaunchBrowser()();
  let totalBytes = 0;
  let aborted = null;
  const watchdog = setTimeout(() => {
    aborted = aborted || "timed out";
    browser.close().catch(() => {});
  }, HARD_TIMEOUT_MS);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 2200 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      (async () => {
        try {
          const u = new URL(req.url());
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            // allow data:/blob: (in-page assets), block everything else exotic
            if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return req.continue();
            return req.abort("blockedbyclient");
          }
          if (req.isNavigationRequest() && req.redirectChain().length >= MAX_REDIRECTS) {
            aborted = aborted || "too many redirects";
            return req.abort("blockedbyclient");
          }
          if (!(await hostAllowed(u.hostname, dnsCache))) {
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
              aborted = aborted || "destination not allowed";
            }
            return req.abort("blockedbyclient");
          }
          return req.continue();
        } catch {
          return req.abort("blockedbyclient").catch(() => {});
        }
      })().catch(() => {});
    });
    page.on("response", (res) => {
      const len = Number(res.headers()["content-length"] || 0);
      if (len > 0) totalBytes += len;
      if (totalBytes > MAX_TOTAL_BYTES) {
        aborted = aborted || "page too large";
        page.close().catch(() => {});
      }
    });

    try {
      await page.goto(target.href, { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT_MS });
    } catch (e) {
      // Slow dealer sites often never reach networkidle — proceed with whatever
      // rendered unless the page itself is gone or a guard fired.
      if (aborted) return { error: `Could not load the page (${aborted})`, blocked: aborted !== "timed out" };
      if (page.isClosed()) return { error: "Could not load the page" };
    }
    if (aborted) return { error: `Could not load the page (${aborted})`, blocked: aborted !== "timed out" };
    await new Promise((r) => setTimeout(r, 2500)); // late JS-injected CTAs

    const candidates = await page.evaluate(findCandidatesInPage, buttonText, STYLE_PROPS);
    if (!candidates || candidates.length === 0) {
      return { error: "No visible element with that text was found on the page" };
    }
    const match = candidates[0];

    // Best-effort hover diff: physically hover the winner and re-read the
    // props that hover states usually change.
    let hoverStyles = null;
    try {
      const handle = await page.$("[data-da-style-winner]");
      if (handle) {
        await handle.hover();
        await new Promise((r) => setTimeout(r, 350)); // let transitions settle
        hoverStyles = await page.evaluate((el) => {
          const cs = getComputedStyle(el);
          const grab = ["background-color", "color", "border-top-color", "box-shadow", "text-decoration-line"];
          const o = {};
          for (const p of grab) o[p] = cs.getPropertyValue(p);
          return o;
        }, handle);
        const changed = {};
        for (const [k, val] of Object.entries(hoverStyles)) {
          if (match.styles[k] !== undefined && match.styles[k] !== val) changed[k] = val;
        }
        hoverStyles = Object.keys(changed).length ? changed : null;
      }
    } catch { hoverStyles = null; }

    return {
      match: { ...match, hoverStyles },
      candidates: candidates.map(({ tag, className, text, score, fullWidth }) => ({ tag, className, text, score, fullWidth })),
    };
  } catch (e) {
    if (aborted) return { error: `Could not load the page (${aborted})`, blocked: aborted !== "timed out" };
    return { error: e && e.message ? e.message : "Extraction failed" };
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }
}

module.exports = { extractStyles, isForbiddenIp, validateUrl };
