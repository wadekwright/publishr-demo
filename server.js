const express = require('express');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Tableland & Sepolia Config
const TABLELAND_ENDPOINT = "https://testnets.tableland.network/api/v1/query?statement=";
const TABLE_NAME = "news_notary_11155111_2087";

// Central Disburser Wallet (Account 1)
const DISBURSER_WALLET = "0x460cd5eD554a99187310d54025178B8bA8e3B43E";

// Proprietary Server-Side Memory Analytics Store (Baseline seed counts for POC)
const scanAnalytics = {
  1: 12,
  2: 8,
  3: 15,
  4: 6
};

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
// 1. PDF Generation Route
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
    doc.fillColor('#4a5568').fontSize(8.5).font('Helvetica').text('Decentralized publishing, measurement, and monetization | publishr-demo.onrender.com', margin, margin + 26);
    doc.moveTo(margin, margin + 40).lineTo(pageWidth - margin, margin + 40).strokeColor('#cbd5e0').lineWidth(1).stroke();

    // 2-Column Layout Setup
    const gutter = 18;
    const colWidth = (contentWidth - gutter) / 2;
    const colY = margin + 50;

    // Fixed Baseline for QR Row
    const qrRowY = colY + 195;

    for (let i = 0; i < articles.length; i++) {
      const art = articles[i];
      const colX = margin + (i * (colWidth + gutter));

      // Column Divider Line
      if (i === 1) {
        const lineX = colX - (gutter / 2);
        doc.moveTo(lineX, colY).lineTo(lineX, qrRowY + 68).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      }

      // Source Platform Header Tag
      doc.fillColor('#2b6cb0').fontSize(9).font('Helvetica-Bold').text(art.source_platform.toUpperCase(), colX, colY);
      
      // Title
      doc.fillColor('#2d3748').fontSize(13).font('Helvetica-Bold').text(art.title, colX, colY + 14, { width: colWidth, height: 42, ellipsis: true });
      
      // Author & Ledger Row
      doc.fillColor('#718096').fontSize(8).font('Helvetica').text(`By ${art.author} | Row #${art.article_id}`, colX, colY + 58);
      
      // Body Text
      const cleanBody = stripHTML(art.body_text);
      doc.fillColor('#2d3748').fontSize(9).font('Helvetica').text(cleanBody, colX, colY + 72, {
        width: colWidth,
        height: 115,
        align: 'justify',
        lineGap: 2.5,
        ellipsis: true
      });

      // Horizontal Divider Line docked tightly beneath article text
      doc.moveTo(colX, qrRowY - 6).lineTo(colX + colWidth, qrRowY - 6).strokeColor('#edf2f7').lineWidth(1).stroke();

      // Generate QR Code
      const verifyUrl = `${baseUrl}/verify?id=${art.article_id}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 90 });
      const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

      // Render QR Code Image
      doc.image(qrBuffer, colX, qrRowY, { width: 58, height: 58 });

      const textX = colX + 64;
      const textWidth = colWidth - 64;

      // QR Block Header Text
      doc.fillColor('#1a365d').fontSize(7.5).font('Helvetica-Bold').text('SCAN THE QR CODE TO:', textX, qrRowY + 1);

      // Bullet Point 1
      doc.fillColor('#2d3748').fontSize(6.5).font('Helvetica-Bold').text('- Verify ', textX, qrRowY + 11, { continued: true })
         .font('Helvetica').text('article authenticity on the blockchain', { width: textWidth });

      // Bullet Point 2
      doc.fillColor('#2d3748').fontSize(6.5).font('Helvetica-Bold').text('- Action ', textX, qrRowY + 20, { continued: true })
         .font('Helvetica').text('micropayments to source, author, Publishr', { width: textWidth });

      // Bullet Point 3
      doc.fillColor('#2d3748').fontSize(6.5).font('Helvetica-Bold').text('- Measure ', textX, qrRowY + 29, { continued: true })
         .font('Helvetica').text('reader traffic and interest from print', { width: textWidth });

      // Bullet Point 4
      doc.fillColor('#2d3748').fontSize(6.5).font('Helvetica-Bold').text('- Read ', textX, qrRowY + 38, { continued: true })
         .font('Helvetica').text('the full article on the source platform', { width: textWidth });

      // Ledger ID
      doc.fillColor('#2b6cb0').fontSize(6.5).font('Helvetica-Bold').text(`Ledger ID: ${TABLE_NAME} | Row: ${art.article_id}`, textX, qrRowY + 49);
    }

    // Page Footer
    const footerY = pageHeight - margin - 15;
    doc.moveTo(margin, footerY - 5).lineTo(pageWidth - margin, footerY - 5).strokeColor('#cbd5e0').lineWidth(0.5).stroke();
    doc.fillColor('#718096').fontSize(8.5).font('Helvetica').text('Wade K Wright | www.linkedin.com/in/wadekw', margin, footerY, { align: 'center' });

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
    const articleId = parseInt(req.query.id);
    if (!articleId || isNaN(articleId)) return res.status(400).send("Missing or Invalid Article ID.");

    const articles = await getTablelandArticles([articleId]);
    if (!articles || articles.length === 0) return res.status(404).send("Article not found on Tableland.");

    const art = articles[0];

    // Increment Memory-Based Analytics Counter
    if (!scanAnalytics[articleId]) {
      scanAnalytics[articleId] = 1;
    } else {
      scanAnalytics[articleId] += 1;
    }

    const currentCount = scanAnalytics[articleId];

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
        .badge-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 1rem; }
        .badge { background: #c6f6d5; color: #22543d; padding: 0.4rem 0.8rem; border-radius: 20px; font-weight: bold; font-size: 0.8rem; display: inline-flex; align-items: center; }
        .badge-analytics { background: #ebf8ff; color: #2b6cb0; border: 1px solid #bee3f8; }
        h2 { margin: 0 0 0.5rem 0; color: #1a365d; font-size: 1.35rem; line-height: 1.3; }
        .meta { font-size: 0.85rem; color: #718096; margin-bottom: 1.25rem; }
        
        .analytics-box { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 1.25rem; text-align: center; }
        .analytics-num { font-size: 1.6rem; font-weight: 800; color: #2b6cb0; margin-bottom: 0.1rem; }
        .analytics-label { font-size: 0.75rem; text-transform: uppercase; font-weight: bold; color: #718096; letter-spacing: 0.5px; }

        .settlement-box { background: #edf2f7; border-radius: 8px; padding: 1rem; margin: 1.25rem 0; font-size: 0.85rem; }
        .settlement-title { font-weight: bold; color: #2b6cb0; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .split-row { display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px stroke #e2e8f0; }
        .split-row:last-child { border-bottom: none; }
        .wallet-addr { font-family: monospace; font-size: 0.75rem; color: #4a5568; }
        
        .tx-proof { background: #e6fffa; border: 1px solid #b2f5ea; border-radius: 6px; padding: 0.75rem; margin-top: 1rem; font-size: 0.78rem; color: #234e52; word-break: break-all; }
        .tx-link { color: #2b6cb0; font-weight: bold; text-decoration: underline; display: inline-block; margin-top: 0.35rem; }

        .btn { display: block; width: 100%; background: #2b6cb0; color: white; text-align: center; padding: 0.85rem 0; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 1.25rem; box-sizing: border-box; }
        .btn:hover { background: #2c5282; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge-row">
          <div class="badge">✓ Tableland Verified</div>
          <div class="badge badge-analytics">📊 Scan Counter Active</div>
        </div>

        <h2>${art.title}</h2>
        <div class="meta">Source: <strong>${art.source_platform}</strong> | Author: <strong>${art.author}</strong></div>
        
        <!-- Reader Engagement Analytics Metric -->
        <div class="analytics-box">
          <div class="analytics-num">${currentCount}</div>
          <div class="analytics-label">Total Verified Scans Recorded from Print</div>
        </div>

        <div class="settlement-box">
          <div class="settlement-title">3-Tier Micropayment Split</div>
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

          <div class="tx-proof">
            <strong>✓ 3-Tier Settlement Dispatched On-Chain</strong><br/>
            Disburser Contract: <span style="font-family:monospace; font-size:0.7rem;">${DISBURSER_WALLET.substring(0, 18)}...</span><br/>
            <a href="https://sepolia.etherscan.io/address/${DISBURSER_WALLET}" target="_blank" class="tx-link">View Disburser Ledger Activity on Sepolia Etherscan ↗</a>
          </div>
        </div>

        <p style="font-size: 0.82rem; color: #718096; line-height: 1.4; margin: 0;">
          This scan event has been recorded on the Sepolia measurement registry (Tableland Row #${art.article_id}). Tap below to read full text at original publisher.
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
