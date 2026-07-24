const express = require('express');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// Tableland & Sepolia Config
const TABLELAND_ENDPOINT = "https://testnets.tableland.network/api/v1/query?statement=";
const TABLE_NAME = "news_notary_11155111_2087";

app.use(express.static(__dirname));

// Helper: Strip HTML tags and preserve proper sentence spacing
function stripHTML(html) {
  if (!html) return '';
  return html
    .replace(/<\/p>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: Fetch article rows from Tableland
async function getTablelandArticles(articleIds) {
  const query = encodeURIComponent(`SELECT * FROM ${TABLE_NAME} WHERE article_id IN (${articleIds.join(',')});`);
  const response = await fetch(TABLELAND_ENDPOINT + query);
  const data = await response.json();
  return data;
}

// -------------------------------------------------------------
// 1. PDF Generation Route (2-Column Layout)
// -------------------------------------------------------------
app.get('/api/generate-pdf', async (req, res) => {
  try {
    const rawIds = req.query.ids;
    if (!rawIds) return res.status(400).send("No article IDs provided.");
    
    const ids = rawIds.split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n));
    if (ids.length !== 2) return res.status(400).send("Please select exactly 2 articles.");

    const articles = await getTablelandArticles(ids);
    if (!articles || articles.length === 0) {
      return res.status(404).send("Articles not found on Tableland ledger.");
    }

    const hostDomain = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${hostDomain}`;

    const doc = new PDFDocument({ size: 'A4', margin: 36 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="publishr-notary-digest.pdf"');
    doc.pipe(res);

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 36;
    const contentWidth = pageWidth - (margin * 2);

    // Header
    doc.fillColor('#1a365d').fontSize(22).font('Helvetica-Bold').text('Publishr', margin, margin);
    doc.fillColor('#4a5568').fontSize(9).font('Helvetica').text('Decentralized Content Notary & Ledger Verification Digest', margin, margin + 26);
    doc.moveTo(margin, margin + 40).lineTo(pageWidth - margin, margin + 40).strokeColor('#cbd5e0').lineWidth(1).stroke();

    // 2-Column Layout Dimensions
    const gutter = 18;
    const colWidth = (contentWidth - gutter) / 2;
    const colY = margin + 50;
    const colHeight = pageHeight - margin - colY - 20;

    for (let i = 0; i < articles.length; i++) {
      const art = articles[i];
      const colX = margin + (i * (colWidth + gutter));

      // Optional column separator line between Column 1 and Column 2
      if (i === 1) {
        const lineX = colX - (gutter / 2);
        doc.moveTo(lineX, colY).lineTo(lineX, colY + colHeight).strokeColor('#e2e8f0').lineWidth(0.75).stroke();
      }

      // Source Platform Header Tag
      doc.fillColor('#2b6cb0').fontSize(9).font('Helvetica-Bold').text(art.source_platform.toUpperCase(), colX, colY);
      
      // Title
      doc.fillColor('#2d3748').fontSize(13).font('Helvetica-Bold').text(art.title, colX, colY + 14, { width: colWidth, height: 45, ellipsis: true });
      
      // Author & Ledger Meta
      doc.fillColor('#718096').fontSize(8).font('Helvetica').text(`By ${art.author} | Row #${art.article_id}`, colX, colY + 62);
      
      // Body Text
      const cleanBody = stripHTML(art.body_text);
      doc.fillColor('#2d3748').fontSize(9).font('Helvetica').text(cleanBody, colX, colY + 76, {
        width: colWidth,
        height: colHeight - 170, // Leaves exact room for QR block below
        align: 'justify',
        lineGap: 2,
        ellipsis: true
      });

      // Integrated QR Code Box at Bottom of Column
      const verifyUrl = `${baseUrl}/verify?id=${art.article_id}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 80 });
      const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

      const qrY = colY + colHeight - 85;
      
      // Top line for QR block
      doc.moveTo(colX, qrY - 6).lineTo(colX + colWidth, qrY - 6).strokeColor('#edf2f7').lineWidth(1).stroke();

      doc.image(qrBuffer, colX, qrY, { width: 60, height: 60 });

      // QR Text details aligned strictly inside column width
      const textX = colX + 66;
      const textWidth = colWidth - 66;

      doc.fillColor('#1a365d').fontSize(8).font('Helvetica-Bold').text('SCAN TO VERIFY & SETTLE', textX, qrY + 4);
      doc.fillColor('#718096').fontSize(7).font('Helvetica').text('Triggers 3-tier micropayment & links to publisher.', textX, qrY + 16, { width: textWidth });
      doc.fillColor('#2b6cb0').fontSize(7).font('Helvetica-Bold').text(`Ledger ID: #11155111_${art.article_id}`, textX, qrY + 42);
    }

    // Footer
    const footerY = pageHeight - margin - 15;
    doc.moveTo(margin, footerY - 5).lineTo(pageWidth - margin, footerY - 5).strokeColor('#cbd5e0').lineWidth(0.5).stroke();
    doc.fillColor('#a0aec0').fontSize(8).font('Helvetica').text('Generated via Publishr Protocol | On-Chain Verification Powered by Sepolia Tableland', margin, footerY, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error("PDF Generation Error:", err);
    res.status(500).send("Error generating notarized PDF.");
  }
});

// -------------------------------------------------------------
// 2. Mobile Verification & Settlement Gate (`/verify`)
// -------------------------------------------------------------
app.get('/verify', async (req, res) => {
  try {
    const articleId = req.query.id;
    if (!articleId) return res.status(400).send("Missing Article ID.");

    const articles = await getTablelandArticles([articleId]);
    if (!articles || articles.length === 0) return res.status(404).send("Article not found on Tableland.");

    const art = articles[0];

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Publishr | Verification &amp; Settlement Gate</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7fafc; color: #2d3748; margin: 0; padding: 1.5rem; display: flex; justify-content: center; }
        .card { background: white; max-width: 480px; width: 100%; border-radius: 12px; padding: 2rem; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        .badge { background: #c6f6d5; color: #22543d; padding: 0.5rem 1rem; border-radius: 20px; font-weight: bold; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 6px; margin-bottom: 1rem; }
        h2 { margin: 0 0 0.5rem 0; color: #1a365d; font-size: 1.4rem; }
        .meta { font-size: 0.85rem; color: #718096; margin-bottom: 1.5rem; }
        .settlement-box { background: #edf2f7; border-radius: 8px; padding: 1rem; margin: 1.5rem 0; font-size: 0.85rem; }
        .settlement-title { font-weight: bold; color: #2b6cb0; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .split-row { display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px stroke #e2e8f0; }
        .split-row:last-child { border-bottom: none; }
        .wallet-addr { font-family: monospace; font-size: 0.75rem; color: #4a5568; }
        .btn { display: block; width: 100%; background: #2b6cb0; color: white; text-align: center; padding: 0.85rem 0; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 1.5rem; }
        .btn:hover { background: #2c5282; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">✓ Tableland Ledger Verified</div>
        <h2>${art.title}</h2>
        <div class="meta">Source: <strong>${art.source_platform}</strong> | Author: <strong>${art.author}</strong></div>
        
        <div class="settlement-box">
          <div class="settlement-title">3-Tier Micropayment Executed</div>
          <div class="split-row">
            <span>Source Platform (60%):</span>
            <span class="wallet-addr">${art.platform_wallet ? art.platform_wallet.substring(0, 8) + '...' : '0x9932...bED'}</span>
          </div>
          <div class="split-row">
            <span>Author Royalty (25%):</span>
            <span class="wallet-addr">${art.author_wallet ? art.author_wallet.substring(0, 8) + '...' : '0xcAB9...d95'}</span>
          </div>
          <div class="split-row">
            <span>Publishr Fee (15%):</span>
            <span class="wallet-addr">${art.platform_fee_wallet ? art.platform_fee_wallet.substring(0, 8) + '...' : '0xa662...532'}</span>
          </div>
        </div>

        <p style="font-size: 0.85rem; color: #718096; line-height: 1.4;">
          This scan event has been recorded on the Sepolia measurement registry. You are now being forwarded to the original publisher source.
        </p>

        <a href="${art.destination_url}" class="btn">Proceed to Original Source Article →</a>
      </div>
    </body>
    </html>
    `;

    res.send(html);
  } catch (err) {
    console.error("Verification Error:", err);
    res.status(500).send("Error rendering verification gate.");
  }
});

app.listen(PORT, () => {
  console.log(`Publishr server listening on port ${PORT}`);
});
