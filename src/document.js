'use strict';
/**
 * The invoice document — one layout, two formats.
 *
 * HTML is what the /doc link renders (drafts stamped DRAFT, issued as the invoice). PDF is
 * the same document for issued invoices only: the file the freelancer attaches and sends
 * themselves (S-7). Both read the same invoiceView so they cannot disagree on a number.
 * The logo is branding, not a fact: read live, never from the frozen blocks.
 */
const path = require('path');
const PDFDocument = require('pdfkit');

const money = (c) => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const termsOf = (inv) => inv.due_in_days === 0 ? 'Due on receipt' : `Net ${inv.due_in_days ?? 30}`;
const reasonOf = (inv) => inv.void_reason ? String(inv.void_reason).trim().replace(/[.\s]+$/, '') : '';
const longDate = (iso) => iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';

function renderInvoiceHtml(inv, logo) {
  const s = inv.seller, c = inv.customer || {};
  const draft = inv.status === 'draft', voided = inv.status === 'void';
  const stamp = draft ? 'DRAFT' : voided ? 'VOID' : null;
  const rows = inv.lines.map((l, i) => `<tr><td class="n muted">${i + 1}</td><td>${esc(l.description)}</td><td class="n">${l.qty}</td><td class="n">${money(l.rate)}</td>
    <td class="n">${l.tax_rate_bp ? (l.tax_rate_bp / 100).toFixed(2) + '%' : '—'}</td><td class="n">${money(l.amount)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${draft ? 'DRAFT ' : ''}${esc(inv.id)} — ${esc(s ? s.name : 'Invoice')}</title><style>
    body{margin:0;background:#eef0f3;font:14px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:hsl(215 40% 16%)}
    .page{max-width:800px;margin:32px auto;background:#fff;padding:56px 64px;box-shadow:0 2px 12px rgba(0,0,0,.08);position:relative}
    .stamp{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);font-size:110px;font-weight:800;color:rgba(180,83,9,.08);letter-spacing:.1em;pointer-events:none}
    .stamp.void{color:rgba(180,30,30,.10)} .status.void{background:#fde2e2;color:#8a1c1c}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:2em}
    .head img{height:56px;display:block;margin-bottom:12px}
    .seller{font-size:14px;line-height:1.5} .seller b{font-size:17px;display:block}
    .title{text-align:right} .title h1{margin:0;font-size:34px;letter-spacing:.06em;color:hsl(215 60% 22%)}
    .title .no{font-size:15px;color:#555;margin-top:6px}
    .status{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:12px;background:#fff3cd;color:#7a5a00;font-size:12px;font-weight:600}
    .meta{display:flex;justify-content:space-between;margin-top:40px;font-size:14px;line-height:1.55;gap:2em}
    h4{margin:0 0 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#888;font-weight:600}
    .meta .r{text-align:right}
    table{width:100%;border-collapse:collapse;margin-top:36px}
    th{text-align:left;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#888;padding:8px 6px;border-bottom:2px solid hsl(215 60% 22%)}
    td{padding:10px 6px;border-bottom:1px solid #e6e6e6} .n{text-align:right} .muted{color:#888}
    .totals{margin:12px 0 0 auto;width:20em} .totals td{border:none;padding:4px 6px} .totals .due td{border-top:2px solid hsl(215 40% 16%);font-weight:700;font-size:16px;padding-top:8px}
    .foot{display:flex;gap:3em;margin-top:44px;font-size:13.5px;line-height:1.55} .foot>div{flex:1}
    .fine{margin-top:44px;text-align:center;font-size:12px;color:#888}
    .bar{max-width:800px;margin:20px auto -20px;text-align:right} .bar button{font:600 13px -apple-system,'Segoe UI',sans-serif;padding:8px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
    @media print{body{background:#fff}.page{margin:0;max-width:none;box-shadow:none;padding:24px 8px}.bar{display:none}}
  </style></head><body>
    <div class="bar">${!draft && inv.pdf_path ? `<a href="${esc(inv.pdf_path)}" style="margin-right:8px;font-size:13px">Download PDF</a>` : ''}<button onclick="window.print()">Print</button></div>
    <div class="page">
      ${stamp ? `<div class="stamp${voided ? ' void' : ''}">${stamp}</div>` : ''}
      <div class="head">
        <div class="seller">${logo ? `<img src="${esc(logo)}" alt="">` : ''}${s ? `<b>${esc(s.name)}</b>${nl(s.address || '')}${s.tax_id ? `<br>Tax ID ${esc(s.tax_id)}` : ''}` : ''}</div>
        <div class="title"><h1>INVOICE</h1><div class="no">${esc(inv.id)}</div>${draft ? '<span class="status">DRAFT — not yet issued</span>' : voided ? '<span class="status void">VOID — not payable</span>' : ''}</div>
      </div>
      <div class="meta">
        <div><h4>Bill to</h4><b>${esc(c.name || inv.customer_name)}</b>${c.address ? `<br>${nl(c.address)}` : ''}${c.tax_id ? `<br>Tax ID ${esc(c.tax_id)}` : ''}${c.email ? `<br>${esc(c.email)}` : ''}</div>
        <div class="r"><h4>Details</h4>${draft ? `Issue date: <i>set at issue</i><br>Terms: ${esc(termsOf(inv))}<br>Due: ${esc(inv.due_in_days ?? 30)} days from issue` : `Issue date: ${esc(longDate(inv.issued_at))}<br>Terms: ${esc(termsOf(inv))}<br>Due date: ${esc(longDate(inv.due_at))}`}</div>
      </div>
      <table><thead><tr><th class="n">#</th><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Tax</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="totals">
        <tr><td>Subtotal</td><td class="n">${money(inv.subtotal)}</td></tr>
        <tr><td>Tax</td><td class="n">${money(inv.tax_total || 0)}</td></tr>
        ${inv.applied ? `<tr><td>Paid</td><td class="n">−${money(inv.applied)}</td></tr>` : ''}
        ${voided ? `<tr><td>Total (void)</td><td class="n">${money(inv.total)}</td></tr><tr class="due"><td>Amount payable</td><td class="n">${money(0)}</td></tr>`
                 : `<tr class="due"><td>${inv.applied ? 'Balance due' : 'Total due'}</td><td class="n">${money(inv.open)}</td></tr>`}
      </table>
      <div class="foot">
        ${inv.payment_instructions ? `<div><h4>Payment instructions</h4>${nl(inv.payment_instructions)}</div>` : ''}
        ${inv.notes ? `<div><h4>Notes</h4>${nl(inv.notes)}</div>` : ''}
      </div>
      ${s && s.footer_note ? `<div class="fine">${nl(s.footer_note)}</div>` : ''}
      ${draft ? '<div class="fine">Preview of the draft as recorded. Numbers can still change; this link becomes the invoice when it is issued.</div>' : ''}
      ${voided ? `<div class="fine">Voided${reasonOf(inv) ? `: ${esc(reasonOf(inv))}` : ''}. Kept for the record; nothing on it is payable and the number is not reused.</div>` : ''}
    </div>
  </body></html>`;
}

/** Same document as a PDF. Issued invoices only — a draft has no final numbers. Resolves to a Buffer. */
function renderInvoicePdf(inv, logo) {
  return new Promise((resolve, reject) => {
    const s = inv.seller, c = inv.customer || {};
    const draft = inv.status === 'draft', voided = inv.status === 'void';
    const NAVY = '#16304f', INK = '#182a44', MUTED = '#777777', RULE = '#e6e6e6';
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: `${inv.id} — ${s ? s.name : 'Invoice'}`, Author: s ? s.name : 'Saybooks' } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right, W = R - L;

    // Head: logo + seller left, INVOICE + number right
    let y = doc.page.margins.top;
    const m = logo ? /^data:image\/(png|jpeg);base64,(.+)$/s.exec(logo) : null;   // pdfkit draws PNG/JPEG; SVG/WebP logos print on the HTML only
    if (m) { try { doc.image(Buffer.from(m[2], 'base64'), L, y, { fit: [160, 44] }); y += 54; } catch { /* a logo that will not decode is not a reason to fail the invoice */ } }
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text('INVOICE', L, doc.page.margins.top, { width: W, align: 'right', characterSpacing: 1.5 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(11).text(inv.id, L, doc.page.margins.top + 32, { width: W, align: 'right' });
    if (draft || voided) {
      const label = draft ? 'DRAFT — NOT YET ISSUED' : 'VOID — NOT PAYABLE';
      doc.fillColor(draft ? '#7a5a00' : '#8a1c1c').font('Helvetica-Bold').fontSize(9).text(label, L, doc.page.margins.top + 50, { width: W, align: 'right', characterSpacing: 0.8 });
      const word = draft ? 'DRAFT' : 'VOID';
      doc.save().rotate(-28, { origin: [doc.page.width / 2, doc.page.height * 0.42] }).fillColor(draft ? '#b45309' : '#b41e1e').opacity(draft ? 0.08 : 0.10).font('Helvetica-Bold').fontSize(120);
      const sw = doc.widthOfString(word, { characterSpacing: 10 });
      doc.text(word, doc.page.width / 2 - sw / 2, doc.page.height * 0.42 - 70, { lineBreak: false, characterSpacing: 10 }).restore().opacity(1);
    }
    if (s) {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(s.name, L, y, { width: W * 0.55 });
      doc.font('Helvetica').fontSize(10).fillColor(INK);
      if (s.address) doc.text(s.address, { width: W * 0.55 });
      if (s.tax_id) doc.text(`Tax ID ${s.tax_id}`, { width: W * 0.55 });
    }
    y = Math.max(doc.y, doc.page.margins.top + 60) + 28;

    // Bill to / details
    const label = (t, x, w, align) => { doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(t.toUpperCase(), x, y, { width: w, align, characterSpacing: 1.2 }); };
    label('Bill to', L, W / 2, 'left'); label('Details', L + W / 2, W / 2, 'right');
    const topY = y + 14;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(c.name || inv.customer_name || '', L, topY, { width: W / 2 });
    doc.font('Helvetica').fontSize(10);
    if (c.address) doc.text(c.address, { width: W / 2 });
    if (c.tax_id) doc.text(`Tax ID ${c.tax_id}`, { width: W / 2 });
    if (c.email) doc.text(c.email, { width: W / 2 });
    const leftEnd = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(draft ? 'Issue date: set at issue' : `Issue date: ${longDate(inv.issued_at)}`, L + W / 2, topY, { width: W / 2, align: 'right' })
      .text(`Terms: ${termsOf(inv)}`, { width: W / 2, align: 'right' })
      .text(draft ? `Due: ${inv.due_in_days ?? 30} days from issue` : `Due date: ${longDate(inv.due_at)}`, { width: W / 2, align: 'right' });
    y = Math.max(leftEnd, doc.y) + 30;

    // Lines
    const cols = [{ w: 22, a: 'right' }, { w: W - 22 - 50 - 80 - 55 - 85, a: 'left' }, { w: 50, a: 'right' }, { w: 80, a: 'right' }, { w: 55, a: 'right' }, { w: 85, a: 'right' }];
    const heads = ['#', 'Description', 'Qty', 'Rate', 'Tax', 'Amount'];
    const row = (cells, opts = {}) => {
      let x = L; const startY = y; let maxH = 0;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10).fillColor(opts.color || INK);
      cells.forEach((t, i) => { const h = doc.heightOfString(String(t), { width: cols[i].w - 6 }); maxH = Math.max(maxH, h); });
      cells.forEach((t, i) => { doc.text(String(t), x + 3, startY, { width: cols[i].w - 6, align: cols[i].a }); x += cols[i].w; });
      y = startY + maxH + 8;
    };
    doc.fillColor(MUTED); row(heads, { bold: true, size: 8, color: MUTED });
    doc.moveTo(L, y - 3).lineTo(R, y - 3).lineWidth(1.5).strokeColor(NAVY).stroke(); y += 6;
    inv.lines.forEach((l, i) => {
      if (y > doc.page.height - 160) { doc.addPage(); y = doc.page.margins.top; }
      row([i + 1, l.description, l.qty, money(l.rate), l.tax_rate_bp ? (l.tax_rate_bp / 100).toFixed(2) + '%' : '—', money(l.amount)]);
      doc.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
    });

    // Totals
    y += 8; const tx = R - 200;
    const tot = (k, v, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(INK).text(k, tx, y, { width: 100 }).text(v, tx + 100, y, { width: 100, align: 'right' }); y += bold ? 18 : 15; };
    tot('Subtotal', money(inv.subtotal)); tot('Tax', money(inv.tax_total || 0));
    if (inv.applied) tot('Paid', '-' + money(inv.applied));
    doc.moveTo(tx, y + 1).lineTo(R, y + 1).lineWidth(1.5).strokeColor(INK).stroke(); y += 8;
    if (voided) { tot('Total (void)', money(inv.total)); tot('Amount payable', money(0), true); }
    else tot(inv.applied ? 'Balance due' : 'Total due', money(inv.open), true);

    // Foot: payment instructions + notes
    y += 26; if (y > doc.page.height - 140) { doc.addPage(); y = doc.page.margins.top; }
    const colW = (W - 30) / 2; let footEnd = y;
    if (inv.payment_instructions) { label('Payment instructions', L, colW, 'left'); doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(inv.payment_instructions, L, y + 14, { width: colW }); footEnd = Math.max(footEnd, doc.y); }
    if (inv.notes) { label('Notes', L + colW + 30, colW, 'left'); doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(inv.notes, L + colW + 30, y + 14, { width: colW }); footEnd = Math.max(footEnd, doc.y); }
    if (s && s.footer_note) { doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(s.footer_note, L, footEnd + 30, { width: W, align: 'center' }); footEnd = doc.y; }
    if (voided) { doc.fillColor('#8a1c1c').font('Helvetica').fontSize(8.5).text(`Voided${reasonOf(inv) ? ': ' + reasonOf(inv) : ''}. Kept for the record; nothing on it is payable and the number is not reused.`, L, footEnd + 16, { width: W, align: 'center' }); }
    doc.end();
  });
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

module.exports = { renderInvoiceHtml, renderInvoicePdf, rasterizePdf };
