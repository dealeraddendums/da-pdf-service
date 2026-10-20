"use strict";

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

/**
 * Buyer's Guide overlay. Ported from da-platform/lib/buyers-guide-pdf.ts,
 * with one architectural difference: the source PDF background is passed
 * in as bytes (from the caller) instead of being fetched here. da-platform
 * fetches from Supabase Storage and ships the bytes over — this service
 * stays Supabase-free.
 *
 * All coordinate tables are copied byte-for-byte from the calibrated
 * da-platform code; the overlays must remain pixel-identical between the
 * two services so a cutover is invisible to the dealer.
 *
 * Coordinate space: PDF points, origin = bottom-left, page = 612 × 792.
 */

// ── Calibrated coordinates ───────────────────────────────────────────────────

const VROW_Y  = 646;
const MAKE_X  = 72;
const MODEL_X = 190;
const YEAR_X  = 310;
const VIN_X   = 390;

// Systems Covered / Duration sections. sysY/durY = first-line baseline; each
// box is word-wrapped to its width, lines step down by secPitch, and at most
// secLines lines fit above the Non-Dealer Warranties heading (measured from
// the FTC backgrounds at 288 dpi):
//   English: 5 writing rules 15pt apart (418.5 … 358.5) — one line per rule.
//   Spanish: no rules, ~50pt of open space — natural 10pt spacing.
// Rules run x 79–295 (systems) and 309.5–525 (duration).
const RULED_SECTION = { sysW: 227, durW: 210, secPitch: 15, secLines: 5 };
const OPEN_SECTION  = { sysW: 227, durW: 210, secPitch: 10, secLines: 5 };

const EN_P0 = {
  asIs:    { cx: 92, cy: 585, sz:  8 },
  dlrW:    { cx: 92, cy: 535, sz:  8 },
  full:    { cx: 99, cy: 510, sz:  4 },
  lim:     { cx: 99, cy: 492, sz:  4 },
  laborX:  280, laborY:  489,
  partsX:  370, partsY:  489,
  sysX:     68, sysY:    419,
  durX:    315, durY:    419,
  ...RULED_SECTION,
  mfrNew:  { cx: 85, cy: 325, sz: 4 },
  mfrUsed: { cx: 85, cy: 301, sz: 4 },
  othUsed: { cx: 85, cy: 285, sz: 4 },
  svcCont: { cx: 85, cy: 235, sz: 4 },
};

const EN_P1 = {
  implied: { cx: 92, cy: 586, sz:  8 },
  dlrW:    { cx: 92, cy: 536, sz:  8 },
  full:    { cx: 99, cy: 511, sz:  4 },
  lim:     { cx: 99, cy: 493, sz:  4 },
  laborX:  280, laborY:  490,
  partsX:  370, partsY:  490,
  // The IMPLIED page's sections sit 20pt lower (first rule at 398.5) and have
  // only 4 rules. Was 420 = on top of the "SYSTEMS COVERED:" heading.
  sysX:     68, sysY:    399,
  durX:    315, durY:    399,
  ...RULED_SECTION, secLines: 4,
  mfrNew:  { cx: 85, cy: 326, sz: 4 },
  mfrUsed: { cx: 85, cy: 302, sz: 4 },
  othUsed: { cx: 85, cy: 286, sz: 4 },
  svcCont: { cx: 85, cy: 236, sz: 4 },
};

const ES_P0 = {
  asIs:    { cx: 92, cy: 585, sz:  8 },
  dlrW:    { cx: 92, cy: 508, sz:  8 },
  full:    { cx: 99, cy: 510, sz:  4 },
  lim:     { cx: 99, cy: 465, sz:  4 },
  laborX:  312, laborY:  462,
  partsX:  402, partsY:  462,
  sysX:     68, sysY:    392,
  durX:    315, durY:    392,
  ...OPEN_SECTION,
  mfrNew:  { cx: 85, cy: 311, sz: 4 },
  mfrUsed: { cx: 85, cy: 292, sz: 4 },
  othUsed: { cx: 85, cy: 280, sz: 4 },
  svcCont: { cx: 85, cy: 235, sz: 4 },
};

const ES_P1 = {
  implied: { cx: 92, cy: 586, sz:  8 },
  dlrW:    { cx: 92, cy: 536, sz:  8 },
  full:    { cx: 99, cy: 511, sz:  4 },
  lim:     { cx: 99, cy: 493, sz:  4 },
  laborX:  280, laborY:  490,
  partsX:  370, partsY:  490,
  // Same section as ES_P0, 1pt lower on this page. Was 420 = in the paragraph above the heading.
  sysX:     68, sysY:    391,
  durX:    315, durY:    391,
  ...OPEN_SECTION,
  mfrNew:  { cx: 85, cy: 312, sz: 4 },
  mfrUsed: { cx: 85, cy: 293, sz: 4 },
  othUsed: { cx: 85, cy: 281, sz: 4 },
  svcCont: { cx: 85, cy: 236, sz: 4 },
};

const BACK = {
  nameX:  104, nameY:  197,
  addrX:  104, addrY:  175,
  phoneX: 104, phoneY: 152,
  emailX: 346, emailY: 152,
  complaintsX: 104, complaintsY: 128,
};

// ── Drawing helpers ──────────────────────────────────────────────────────────

function drawX(page, { cx, cy, sz }) {
  page.drawRectangle({ x: cx - sz - 1, y: cy - sz - 1, width: sz * 2 + 2, height: sz * 2 + 2, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: cx - sz, y: cy - sz }, end: { x: cx + sz, y: cy + sz }, thickness: 1.5, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: cx + sz, y: cy - sz }, end: { x: cx - sz, y: cy + sz }, thickness: 1.5, color: rgb(0, 0, 0) });
}

function drawTxt(page, font, x, y, text, size = 8) {
  const t = (text ?? "").toString().trim();
  if (!t) return;
  page.drawText(t, { x, y, size, font, color: rgb(0, 0, 0) });
}

const BLOCK_SIZE = 7.5;
const BLOCK_MIN_SIZE = 5.5;

/** Word-wrap to `width`, keeping the operator's own line breaks as hard breaks. */
function wrapBlock(font, text, size, width) {
  const fits = (s) => font.widthOfTextAtSize(s, size) <= width;
  const out = [];
  for (const para of text.replace(/\r\n?/g, "\n").trim().split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      // A single word wider than the box breaks by character.
      while (!fits(word)) {
        let n = word.length - 1;
        while (n > 1 && !fits(word.slice(0, n))) n--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      if (line && !fits(`${line} ${word}`)) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

/**
 * Multi-line text box (Systems Covered / Duration): wraps to `width`, one line
 * per `pitch`, never more than `maxLines`. Too long → shrink the font in 0.5pt
 * steps (down to BLOCK_MIN_SIZE) while that saves lines; still too long → cut
 * at the last line with "…".
 * Never draws outside the box.
 */
function drawBlock(page, font, x, y, text, width, pitch, maxLines) {
  const t = (text ?? "").toString().trim();
  if (!t) return;
  // Largest size that fits; if none does, the size with the fewest lines
  // (largest on a tie) — shrinking can't help typed-in extra lines.
  let size = BLOCK_SIZE;
  let lines = wrapBlock(font, t, size, width);
  for (let s = BLOCK_SIZE - 0.5; lines.length > maxLines && s >= BLOCK_MIN_SIZE; s -= 0.5) {
    const l = wrapBlock(font, t, s, width);
    if (l.length < lines.length) { size = s; lines = l; }
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last && font.widthOfTextAtSize(`${last}…`, size) > width) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  lines.forEach((ln, i) => {
    if (ln) page.drawText(ln, { x, y: y - i * pitch, size, font, color: rgb(0, 0, 0) });
  });
}

function drawPct(page, font, x, y, val) {
  if (val == null) return;
  page.drawText(String(val), { x, y, size: 9, font, color: rgb(0, 0, 0) });
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {Buffer|null} srcPdfBytes  The FTC background PDF da-platform fetched
 *                               from Supabase Storage (or its asset fallback).
 *                               Must have at least 2 pages (front + back).
 *                               May be null in pre-printed-label mode.
 * @param {Object} input         { language, vehicle, dealer, warranty,
 *                                 preprinted? }
 *
 * PRE-PRINTED-LABEL MODE (2026-08-25): when input.preprinted is set, the
 * dealer prints on their OWN FTC label stock, so the output is DATA-ONLY on
 * blank 612×792 pages (no background), with every field placed at its
 * calibrated default coordinate + the dealer's saved offsets:
 *   preprinted = { global: {x, y}, fields: { [key]: {x, y} } }   (PDF points)
 * Field keys: make, model, year, vin, asIs, implied, dlrW, full, lim, labor,
 * parts, systems, duration, mfrNew, mfrUsed, othUsed, svcCont (front);
 * name, addr, phone, email, complaints (back). The variable-field SET is
 * unchanged — repositioning only, never omission (compliance).
 */
async function applyBuyerGuideOverlay(srcPdfBytes, input) {
  const { language: lang, vehicle: v, dealer: d, warranty: w } = input;

  const pp = input.preprinted && typeof input.preprinted === "object" ? input.preprinted : null;
  const gx = pp ? Number(pp.global && pp.global.x) || 0 : 0;
  const gy = pp ? Number(pp.global && pp.global.y) || 0 : 0;
  const fo = (key) => (pp && pp.fields && pp.fields[key]) || {};
  const ox = (key, x) => x + gx + (Number(fo(key).x) || 0);
  const oy = (key, y) => y + gy + (Number(fo(key).y) || 0);
  const oCB = (key, cb) => (pp ? { ...cb, cx: ox(key, cb.cx), cy: oy(key, cb.cy) } : cb);

  const isAsIs    = w.warranty_type === "as_is";
  const isImplied = w.warranty_type === "implied_only";
  const isFull    = w.warranty_type === "full";
  const isLimited = w.warranty_type === "limited";
  const hasDealerW = isFull || isLimited;

  const outDoc = await PDFDocument.create();
  if (pp) {
    // Data-only: two blank US-Letter pages — the dealer's label stock IS the form.
    outDoc.addPage([612, 792]);
    outDoc.addPage([612, 792]);
  } else {
    const srcDoc = await PDFDocument.load(srcPdfBytes);
    const [front, back] = await outDoc.copyPages(srcDoc, [0, 1]);
    outDoc.addPage(front);
    outDoc.addPage(back);
  }

  const font     = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // Front page ────────────────────────────────────────────────────────────────
  const fp = outDoc.getPage(0);
  const C = lang === "es"
    ? (isImplied ? ES_P1 : ES_P0)
    : (isImplied ? EN_P1 : EN_P0);

  drawTxt(fp, font, ox("make", MAKE_X),   oy("make", VROW_Y),  v.make  ?? "");
  drawTxt(fp, font, ox("model", MODEL_X), oy("model", VROW_Y), v.model ?? "");
  drawTxt(fp, font, ox("year", YEAR_X),   oy("year", VROW_Y),  v.year  ?? "");
  drawTxt(fp, font, ox("vin", VIN_X),     oy("vin", VROW_Y),   v.vin   ?? "");

  if (isAsIs    && "asIs"    in C) drawX(fp, oCB("asIs", C.asIs));
  if (isImplied && "implied" in C) drawX(fp, oCB("implied", C.implied));
  if (hasDealerW) drawX(fp, oCB("dlrW", C.dlrW));

  if (isFull) drawX(fp, oCB("full", C.full));
  if (isLimited) {
    drawX(fp, oCB("lim", C.lim));
    drawPct(fp, fontBold, ox("labor", C.laborX), oy("labor", C.laborY), w.labor_pct);
    drawPct(fp, fontBold, ox("parts", C.partsX), oy("parts", C.partsY), w.parts_pct);
  }
  if (hasDealerW && w.systems_covered) drawBlock(fp, font, ox("systems", C.sysX), oy("systems", C.sysY), w.systems_covered, C.sysW, C.secPitch, C.secLines);
  if (hasDealerW && w.duration)        drawBlock(fp, font, ox("duration", C.durX), oy("duration", C.durY), w.duration, C.durW, C.secPitch, C.secLines);

  const ndw = w.non_dealer_warranties ?? [];
  if (ndw.includes("mfr_new"))    drawX(fp, oCB("mfrNew", C.mfrNew));
  if (ndw.includes("mfr_used"))   drawX(fp, oCB("mfrUsed", C.mfrUsed));
  if (ndw.includes("other_used")) drawX(fp, oCB("othUsed", C.othUsed));
  if (w.service_contract)         drawX(fp, oCB("svcCont", C.svcCont));

  // Back page ─────────────────────────────────────────────────────────────────
  const bp = outDoc.getPage(1);

  const dealerName  = d.name ?? "";
  const dealerAddr  = [d.address, [d.city, d.state, d.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const dealerPhone = d.phone ?? "";
  const dealerEmail = w.dealer_email ?? d.email ?? "";

  drawTxt(bp, font, ox("name", BACK.nameX),   oy("name", BACK.nameY),  dealerName,  8);
  drawTxt(bp, font, ox("addr", BACK.addrX),   oy("addr", BACK.addrY),  dealerAddr,  8);
  drawTxt(bp, font, ox("phone", BACK.phoneX), oy("phone", BACK.phoneY), dealerPhone, 8);
  if (dealerEmail)          drawTxt(bp, font, ox("email", BACK.emailX), oy("email", BACK.emailY), dealerEmail, 8);
  if (w.complaints_contact) drawTxt(bp, font, ox("complaints", BACK.complaintsX), oy("complaints", BACK.complaintsY), w.complaints_contact, 8);

  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}

module.exports = { applyBuyerGuideOverlay, wrapBlock };
