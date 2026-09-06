'use strict';
/**
 * The invoice document — one renderer, the PDF.
 *
 * The PDF is the document: what the freelancer downloads and sends themselves (S-7), stamped
 * DRAFT before issue and VOID after a void. The /doc link shows the PDF's own pages as
 * pictures, so the preview and the file cannot disagree — same pagination, same fonts, same
 * numbers — and an agent looking through solo_get_document sees the same pages again.
 * The logo is branding, not a fact: read live, never from the frozen blocks.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const H = require('./db.js');

// The PDF embeds Liberation Sans (metric-compatible with Helvetica, full Latin coverage) so
// Czech, Hungarian or Māori names print as typed; the 14 built-in fonts cannot draw them.
// pdf.js ships the files, so they are already on every install. Falls back to Helvetica if not.
const FONT_DIR = (() => { try { return path.dirname(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')); } catch { return null; } })();
const FONT = FONT_DIR ? path.join(FONT_DIR, 'LiberationSans-Regular.ttf') : 'Helvetica';
const FONT_B = FONT_DIR ? path.join(FONT_DIR, 'LiberationSans-Bold.ttf') : 'Helvetica-Bold';

// Money and dates print in the invoice's currency and the space's locale (0.2): a New Zealand
// space shows "$2,700.00" and "10 May 2026"; a US space billing in CZK shows "CZK 2,700.00".
const moneyFor = (inv) => (c) => H.money(c, inv.currency || 'USD', inv.locale || 'en-US');
const dateFor = (inv) => (iso) => H.fmtDate(iso, inv.locale || 'en-US');
const taxRowLabel = (inv) => `${inv.tax_label || 'Tax'}${inv.tax_rate_display ? ' ' + inv.tax_rate_display : ''}`;
const dueLabel = (inv, base) => `${base}${inv.show_currency ? ` (${inv.currency || 'USD'})` : ''}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const reasonOf = (inv) => inv.void_reason ? String(inv.void_reason).trim().replace(/[.\s]+$/, '') : '';
// "Net 30" is a term people recognise; "Net 41" is not — then only the due date speaks.
const STD_TERMS = { 0: 'Due on receipt', 7: 'Net 7', 10: 'Net 10', 14: 'Net 14', 15: 'Net 15', 21: 'Net 21', 30: 'Net 30', 45: 'Net 45', 60: 'Net 60', 90: 'Net 90' };
// Letter is a North American habit; everyone else prints on A4.
const paperFor = (country) => (['US', 'CA', 'MX'].includes(country || 'US') ? 'LETTER' : 'A4');
// A line's description: the first line is the title, anything after it prints smaller beneath.
const splitDesc = (d) => { const parts = String(d || '').split(/\r?\n/); return { title: parts[0], detail: parts.slice(1).join('\n').trim() }; };

/** The document as a PDF. Drafts render stamped DRAFT, void invoices stamped VOID. Resolves to a Buffer. */
function renderInvoicePdf(inv, logo) {
  return new Promise((resolve, reject) => {
    const s = inv.seller, c = inv.customer || {};
    const money = moneyFor(inv), longDate = dateFor(inv);
    const draft = inv.status === 'draft', voided = inv.status === 'void';
    const showRef = inv.lines.some(l => l.ref), showTax = inv.tax_registered || inv.tax_total > 0;
    const taxIdLabel = inv.tax_id_label || 'Tax ID';
    const NAVY = '#16304f', INK = '#182a44', MUTED = '#777777', RULE = '#e6e6e6';
    const doc = new PDFDocument({ size: paperFor(s && s.country), margins: { top: 50, bottom: 50, left: 52, right: 52 },
      info: { Title: `${inv.id} — ${s ? s.name : 'Invoice'}`, Author: s ? s.name : 'Saybooks' } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right, W = R - L;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    // Head: logo + seller left, INVOICE + number right
    let y = doc.page.margins.top;
    const m = logo ? /^data:image\/(png|jpeg);base64,(.+)$/s.exec(logo) : null;   // pdfkit draws PNG/JPEG; SVG/WebP logos print on the HTML only
    if (m) { try { doc.image(Buffer.from(m[2], 'base64'), L, y, { fit: [150, 42] }); y += 50; } catch { /* a logo that will not decode is not a reason to fail the invoice */ } }
    doc.fillColor(NAVY).font(FONT_B).fontSize(24).text(inv.tax_invoice ? 'TAX INVOICE' : 'INVOICE', L, doc.page.margins.top, { width: W, align: 'right', characterSpacing: 1.5 });
    doc.fillColor(MUTED).font(FONT).fontSize(11).text(inv.id, L, doc.page.margins.top + 30, { width: W, align: 'right' });
    if (draft || voided) {
      const label = draft ? 'DRAFT — NOT YET ISSUED' : 'VOID — NOT PAYABLE';
      doc.fillColor(draft ? '#7a5a00' : '#8a1c1c').font(FONT_B).fontSize(8.5).text(label, L, doc.page.margins.top + 47, { width: W, align: 'right', characterSpacing: 0.8 });
      const word = draft ? 'DRAFT' : 'VOID';
      doc.save().rotate(-28, { origin: [doc.page.width / 2, doc.page.height * 0.42] }).fillColor(draft ? '#b45309' : '#b41e1e').opacity(draft ? 0.08 : 0.10).font(FONT_B).fontSize(120);
      const sw = doc.widthOfString(word, { characterSpacing: 10 });
      doc.text(word, doc.page.width / 2 - sw / 2, doc.page.height * 0.42 - 70, { lineBreak: false, characterSpacing: 10 }).restore().opacity(1);
    }
    if (s) {
      doc.fillColor(INK).font(FONT_B).fontSize(12.5).text(s.name, L, y, { width: W * 0.55 });
      doc.font(FONT).fontSize(9.5).fillColor(INK);
      if (s.address) doc.text(s.address, { width: W * 0.55 });
      if (s.tax_id) doc.text(`${taxIdLabel} ${s.tax_id}`, { width: W * 0.55 });
    }
    y = Math.max(doc.y, doc.page.margins.top + 58) + 22;

    // Bill to / details
    const label = (t, x, w, align) => { doc.fillColor(MUTED).font(FONT_B).fontSize(7.5).text(t.toUpperCase(), x, y, { width: w, align, characterSpacing: 1.2 }); };
    label('Bill to', L, W / 2, 'left'); label('Details', L + W / 2, W / 2, 'right');
    const topY = y + 13;
    doc.fillColor(INK).font(FONT_B).fontSize(10).text(c.name || inv.customer_name || '', L, topY, { width: W / 2 });
    doc.font(FONT).fontSize(9.5);
    if (c.address) doc.text(c.address, { width: W / 2 });
    if (c.tax_id) doc.text(`${taxIdLabel} ${c.tax_id}`, { width: W / 2 });
    if (c.email) doc.text(c.email, { width: W / 2 });
    const leftEnd = doc.y;
    const days = inv.due_in_days ?? 30;
    doc.font(FONT).fontSize(9.5).fillColor(INK).text(draft ? 'Issue date: set at issue' : `Issue date: ${longDate(inv.issued_at)}`, L + W / 2, topY, { width: W / 2, align: 'right' });
    if (STD_TERMS[days]) doc.text(`Terms: ${STD_TERMS[days]}`, { width: W / 2, align: 'right' });
    doc.text(draft ? `Payment due: ${days === 0 ? 'on receipt' : `${days} days from issue`}` : `Payment due: ${longDate(inv.due_at)}`, { width: W / 2, align: 'right' });
    y = Math.max(leftEnd, doc.y) + 22;
    if (inv.subject) { label('Subject', L, W, 'left'); doc.fillColor(INK).font(FONT).fontSize(9.5).text(inv.subject, L, y + 13, { width: W }); y = doc.y + 14; }

    // Lines: the ref column appears only when a line carries one, the tax column only when the scheme has tax.
    const refW = showRef ? 66 : 0, taxW = showTax ? 46 : 0;
    const cols = [{ w: 18, a: 'right' }, ...(showRef ? [{ w: refW, a: 'left' }] : []), { w: W - 18 - refW - 40 - 72 - taxW - 82, a: 'left' }, { w: 40, a: 'right' }, { w: 72, a: 'right' }, ...(showTax ? [{ w: taxW, a: 'right' }] : []), { w: 82, a: 'right' }];
    const heads = ['#', ...(showRef ? ['Ref'] : []), 'Description', 'Qty', 'Rate', ...(showTax ? [inv.tax_label || 'Tax'] : []), 'Amount'];
    const cellH = (t, w) => {
      if (t && typeof t === 'object') { let h = doc.font(FONT).fontSize(9.5).heightOfString(t.title, { width: w }); if (t.detail) h += 2 + doc.fontSize(8).heightOfString(t.detail, { width: w }); return h; }
      return doc.heightOfString(String(t), { width: w });
    };
    const drawCell = (t, x, w, align) => {
      if (t && typeof t === 'object') {
        doc.font(FONT).fontSize(9.5).fillColor(INK).text(t.title, x, y, { width: w, align });
        if (t.detail) doc.fontSize(8).fillColor(MUTED).text(t.detail, x, doc.y + 2, { width: w, align });
      } else doc.text(String(t), x, y, { width: w, align });
    };
    const rowHeight = (cells, opts = {}) => { doc.font(opts.bold ? FONT_B : FONT).fontSize(opts.size || 9.5); return Math.max(...cells.map((t, i) => cellH(t, cols[i].w - 6))); };
    const row = (cells, opts = {}) => {
      let x = L; const startY = y; const h = rowHeight(cells, opts);
      doc.font(opts.bold ? FONT_B : FONT).fontSize(opts.size || 9.5).fillColor(opts.color || INK);
      cells.forEach((t, i) => { doc.font(opts.bold ? FONT_B : FONT).fontSize(opts.size || 9.5).fillColor(opts.color || INK); drawCell(t, x + 3, cols[i].w - 6, cols[i].a); x += cols[i].w; });
      y = startY + h + 7;
    };
    const header = () => { row(heads, { bold: true, size: 7.5, color: MUTED }); doc.moveTo(L, y - 3).lineTo(R, y - 3).lineWidth(1.5).strokeColor(NAVY).stroke(); y += 5; };
    header();
    inv.lines.forEach((l, i) => {
      const cells = [i + 1, ...(showRef ? [l.ref || ''] : []), splitDesc(l.description), l.qty, money(l.rate), ...(showTax ? [l.tax_rate_bp ? (l.tax_rate_bp / 100).toFixed(2).replace(/\.?0+$/, '') + '%' : '-'] : []), money(l.amount)];
      if (y + rowHeight(cells) > bottom() - 20) { doc.addPage(); y = doc.page.margins.top; header(); }
      row(cells);
      doc.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
    });

    // Totals — kept together with the foot when there is room, else on a fresh page.
    const totalsRows = 2 + (showTax ? 1 : 0) + (inv.applied ? 1 : 0) + (voided ? 1 : 0);
    if (y + totalsRows * 15 + 40 > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    y += 6; const tx = R - 240;
    const tot = (k, v, bold) => { doc.font(bold ? FONT_B : FONT).fontSize(bold ? 11.5 : 9.5).fillColor(INK).text(k, tx, y, { width: 130 }).text(v, tx + 130, y, { width: 110, align: 'right' }); y += bold ? 18 : 14; };
    tot('Subtotal', money(inv.subtotal)); if (showTax) tot(taxRowLabel(inv), money(inv.tax_total || 0));
    if (inv.applied) tot('Paid', '-' + money(inv.applied));
    doc.moveTo(tx, y + 1).lineTo(R, y + 1).lineWidth(1.5).strokeColor(INK).stroke(); y += 8;
    if (voided) { tot('Total (void)', money(inv.total)); tot(dueLabel(inv, 'Amount payable'), money(0), true); }
    else tot(dueLabel(inv, inv.applied ? 'Balance due' : 'Total due'), money(inv.open), true);

    // Foot: payment instructions + notes, then the footer line and the void reason.
    const footNeeded = (inv.payment_instructions || inv.notes) ? 70 : 0;
    y += 22; if (y + footNeeded > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    const colW = (W - 30) / 2; let footEnd = y;
    if (inv.payment_instructions) { label('Payment instructions', L, colW, 'left'); doc.fillColor(INK).font(FONT).fontSize(9).text(inv.payment_instructions, L, y + 13, { width: colW }); footEnd = Math.max(footEnd, doc.y); }
    if (inv.notes) { label('Notes', L + colW + 30, colW, 'left'); doc.fillColor(INK).font(FONT).fontSize(9).text(inv.notes, L + colW + 30, y + 13, { width: colW }); footEnd = Math.max(footEnd, doc.y); }
    const fine = [];
    if (s && s.footer_note) fine.push({ t: s.footer_note, color: MUTED });
    if (draft) fine.push({ t: 'Preview of the draft as recorded. Numbers can still change; this link becomes the invoice when it is issued.', color: MUTED });
    if (voided) fine.push({ t: `Voided${reasonOf(inv) ? ': ' + reasonOf(inv) : ''}. Kept for the record; nothing on it is payable and the number is not reused.`, color: '#8a1c1c' });
    let fy = footEnd + 26;
    for (const f of fine) {
      doc.font(FONT).fontSize(8.5);
      const h = doc.heightOfString(f.t, { width: W, align: 'center' });
      if (fy + h > bottom()) { doc.addPage(); fy = doc.page.margins.top; }
      doc.fillColor(f.color).text(f.t, L, fy, { width: W, align: 'center' }); fy = doc.y + 6;
    }
    doc.end();
  });
}

/**
 * The /doc page: the PDF's pages as pictures, so the preview is the file. `pages` is the
 * page count; each image is served by the same route at /p<N>.png. Print goes through the
 * PDF itself, which is what a browser prints faithfully.
 */
function renderDocumentPage(inv, pages) {
  const s = inv.seller;
  const draft = inv.status === 'draft', voided = inv.status === 'void';
  const base = inv.doc_path;
  const imgs = Array.from({ length: Math.max(1, pages | 0) }, (_, i) => `<img class="pg" src="${esc(base)}/p${i + 1}.png" alt="${esc(inv.id)} page ${i + 1}" width="1240" height="${paperFor(s && s.country) === 'A4' ? 1754 : 1605}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${draft ? 'DRAFT ' : ''}${esc(inv.id)} — ${esc(s ? s.name : 'Invoice')}</title><style>
    body{margin:0;background:#eef0f3;font:14px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:hsl(215 40% 16%)}
    .bar{max-width:820px;margin:18px auto 0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 10px}
    .bar .st{font-size:13px;color:#555} .bar .st b{color:hsl(215 40% 16%)} .bar .st .v{color:#8a1c1c;font-weight:600} .bar .st .d{color:#7a5a00;font-weight:600}
    .bar a,.bar button{font:600 13px -apple-system,'Segoe UI',sans-serif;padding:8px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;color:hsl(215 40% 16%);text-decoration:none;cursor:pointer}
    .pages{max-width:820px;margin:14px auto 40px;padding:0 10px} .pg{display:block;width:100%;height:auto;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:18px}
    .fine{max-width:820px;margin:0 auto 30px;text-align:center;font-size:12px;color:#888}
  </style></head><body>
    <div class="bar"><div class="st"><b>${esc(inv.id)}</b> · ${esc(inv.customer_name || '')} · ${esc(inv.total_display)}${draft ? ' · <span class="d">DRAFT</span>' : voided ? ' · <span class="v">VOID</span>' : inv.status === 'paid' ? ' · paid' : ''}${pages > 1 ? ` · ${pages} pages` : ''}</div>
      <div><a href="${esc(base)}.pdf" target="_blank" rel="noopener">${draft ? 'Draft PDF' : 'Download PDF'}</a> <button onclick="window.open('${esc(base)}.pdf','_blank')">Print</button></div></div>
    <div class="pages">${imgs}</div>
    ${draft ? '<div class="fine">Preview of the draft as recorded — the very pages the PDF will have. Numbers can still change; this link becomes the invoice when it is issued.</div>' : ''}
    ${voided ? `<div class="fine">Voided${reasonOf(inv) ? `: ${esc(reasonOf(inv))}` : ''}. Kept for the record; nothing on it is payable and the number is not reused.</div>` : ''}
  </body></html>`;
}

/**
 * The PDF as a picture: one page rasterized with pdf.js, glyphs drawn as paths so no system
 * fonts are needed. This is how an agent SEES the document — the image is the PDF by
 * construction, never a third layout. ~1.6x scale ≈ 115 dpi: legible, 100–200 KB a page.
 */
let pdfjsPromise = null;
async function rasterizePdf(pdfBuf, pageNo = 1, scale = 1.6) {
  pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const { createCanvas } = require('@napi-rs/canvas');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf), disableFontFace: true, isEvalSupported: false,
    standardFontDataUrl: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep,
  }).promise;
  const n = Math.min(Math.max(1, pageNo | 0), doc.numPages);
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  const png = canvas.toBuffer('image/png');
  await doc.destroy();
  return { png, page: n, pages: doc.numPages, width: canvas.width, height: canvas.height };
}

module.exports = { renderInvoicePdf, renderDocumentPage, rasterizePdf, paperFor };
