/**
 * PDF Export Utility
 * 
 * Generates PDF documents for meeting transcripts and summaries
 * Uses Puppeteer to render HTML to PDF
 */

const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const { formatDateLong } = require('./timezone');

/**
 * Generate PDF from meeting data
 * @param {Object} options - PDF generation options
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateMeetingPDF(options) {
    const {
        botId,
        title = 'Meeting Transcript',
        transcript = [],
        summary = '',
        metrics = null,
        meetUrl = '',
        createdAt = null
    } = options;

    console.log(`📄 Generating PDF for bot ${botId}...`);

    // Build HTML content
    const html = buildPDFHTML({
        title,
        transcript,
        summary,
        metrics,
        meetUrl,
        createdAt
    });

    // Launch headless browser
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        
        // Set content
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            margin: {
                top: '0.75in',
                right: '0.75in',
                bottom: '0.75in',
                left: '0.75in'
            },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
                <div style="font-size: 10px; color: #666; text-align: center; width: 100%; padding: 0 0.75in;">
                    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                </div>
            `
        });

        console.log(`✅ PDF generated: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

        return pdfBuffer;
    } finally {
        await browser.close();
    }
}

/**
 * Build HTML for PDF
 */
function buildPDFHTML(data) {
    const { title, transcript, summary, metrics, meetUrl, createdAt } = data;

    // Format date
    const dateStr = createdAt ? formatDateLong(new Date(createdAt)) : 'N/A';

    // Format summary with markdown-like conversion
    let formattedSummary = summary || 'No summary available';
    if (formattedSummary !== 'No summary available') {
        formattedSummary = formattedSummary
            .replace(/^# (.+)$/gm, '<h2>$1</h2>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^• (.+)$/gm, '<li>$1</li>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');
        
        formattedSummary = `<p>${formattedSummary}</p>`;
    }

    // Build metrics section
    let logoBase64 = fs.readFileSync(path.join(__dirname, '../../', 'public', 'isotipo.png'), 'base64');    let metricsHTML = '';
    if (metrics && metrics.duration) {
        metricsHTML = `
            <div class="metrics-grid">
                <img src="data:image/png;base64,${logoBase64}" alt="CXFlow Logo" class="metrics-logo">
                <div class="metrics-website">www.cxflow.io</div>
                <div class="metric-card">
                    <div class="metric-label">Duration</div>
                    <div class="metric-value">${metrics.duration.totalMinutes} min</div>
                </div>
                ${metrics.participation ? `
                <div class="metric-card">
                    <div class="metric-label">Participants</div>
                    <div class="metric-value">${metrics.participation.totalParticipants}</div>
                </div>
                ` : ''}
                ${metrics.interruptions ? `
                <div class="metric-card">
                    <div class="metric-label">Interruptions</div>
                    <div class="metric-value">${metrics.interruptions.total}</div>
                </div>
                ` : ''}
                ${metrics.keywords ? `
                <div class="metric-card">
                    <div class="metric-label">Keywords</div>
                    <div class="metric-value">${metrics.keywords.total}</div>
                </div>
                ` : ''}
            </div>
        `;
    }

    // Build transcript HTML
    let transcriptHTML = '';
    if (transcript && transcript.length > 0) {
        transcriptHTML = transcript.map(utt => `
            <div class="transcript-item">
                <div class="transcript-header">
                    <span class="speaker">${escapeHtml(utt.speaker)}</span>
                    <span class="timestamp">${formatTimestamp(utt.startOffset || 0)}</span>
                </div>
                <div class="transcript-text">${escapeHtml(utt.text)}</div>
            </div>
        `).join('');
    } else {
        transcriptHTML = '<p class="empty-state">No transcript available</p>';
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 11pt;
            line-height: 1.6;
            color: #111;
            background: #fff;
        }
        
        .header {
            border-bottom: 3px solid #2563eb;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        
        .header h1 {
            font-size: 24pt;
            font-weight: 700;
            color: #111;
            margin-bottom: 8px;
        }
        
        .header-meta {
            font-size: 10pt;
            color: #666;
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .header-meta-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .section {
            margin-bottom: 30px;
            page-break-inside: avoid;
        }
        
        .section-title {
            font-size: 16pt;
            font-weight: 600;
            color: #2563eb;
            margin-bottom: 12px;
            padding-bottom: 6px;
            border-bottom: 2px solid #e5e7eb;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .metrics-container {
            position: relative;
            margin-bottom: 20px;
        }
        
        .metrics-logo {
            position: absolute;
            top: 400px;
            left: 50%;
            transform: translateX(-50%);
            width: 200px;
            height: 200px;
            opacity: 0.8;
            z-index: 1;
        }
        
        .metrics-website {
            position: absolute;
            top: 620px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 12pt;
            color: black;
            font-weight: 500;
            text-align: center;
            z-index: 1;
        }
        
        .metric-card {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 12px;
            text-align: center;
            position: relative;
            z-index: 2;
        }
        
        .metric-label {
            font-size: 9pt;
            color: #6b7280;
            margin-bottom: 4px;
        }
        
        .metric-value {
            font-size: 18pt;
            font-weight: 700;
            color: #111;
        }
        
        .summary-content {
            background: #f9fafb;
            border-left: 4px solid #2563eb;
            padding: 16px;
            border-radius: 4px;
            font-size: 10pt;
            line-height: 1.7;
        }
        
        .summary-content h2 {
            font-size: 14pt;
            font-weight: 600;
            margin-top: 16px;
            margin-bottom: 8px;
            color: #111;
        }
        
        .summary-content h2:first-child {
            margin-top: 0;
        }
        
        .summary-content h3 {
            font-size: 12pt;
            font-weight: 600;
            margin-top: 12px;
            margin-bottom: 6px;
            color: #374151;
        }
        
        .summary-content h4 {
            font-size: 11pt;
            font-weight: 600;
            margin-top: 10px;
            margin-bottom: 4px;
            color: #6b7280;
        }
        
        .summary-content p {
            margin-bottom: 12px;
        }
        
        .summary-content ul, .summary-content ol {
            margin-left: 20px;
            margin-bottom: 12px;
        }
        
        .summary-content li {
            margin-bottom: 4px;
        }
        
        .transcript-item {
            margin-bottom: 16px;
            page-break-inside: avoid;
        }
        
        .transcript-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }
        
        .speaker {
            font-weight: 600;
            font-size: 10pt;
            color: #111;
        }
        
        .timestamp {
            font-size: 9pt;
            color: #6b7280;
            background: #f3f4f6;
            padding: 2px 8px;
            border-radius: 4px;
        }
        
        .transcript-text {
            font-size: 10pt;
            color: #374151;
            line-height: 1.6;
            padding-left: 12px;
            border-left: 2px solid #e5e7eb;
        }
        
        .empty-state {
            text-align: center;
            color: #9ca3af;
            padding: 40px 20px;
            font-style: italic;
        }
        
        .footer-note {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
            font-size: 9pt;
            color: #9ca3af;
            text-align: center;
        }
        
        @media print {
            body {
                print-color-adjust: exact;
                -webkit-print-color-adjust: exact;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${escapeHtml(title)}</h1>
        <div class="header-meta">
            <div class="header-meta-item">
                <span>Date:</span>
                <span>${dateStr}</span>
            </div>
            ${meetUrl ? `
            <div class="header-meta-item">
                <span>Meeting URL:</span>
                <span>${escapeHtml(meetUrl)}</span>
            </div>
            ` : ''}
            ${transcript.length > 0 ? `
            <div class="header-meta-item">
                <span>Utterances:</span>
                <span>${transcript.length}</span>
            </div>
            ` : ''}
        </div>
    </div>
    
    ${metricsHTML ? `
    <div class="section">
        <h2 class="section-title">Meeting Metrics</h2>
        ${metricsHTML}
    </div>
    ` : ''}
    
    <div class="section">
        <h2 class="section-title">Summary</h2>
        <div class="summary-content">
            ${formattedSummary}
        </div>
    </div>
    
    <div class="section" style="page-break-before: always;">
        <h2 class="section-title">Transcript</h2>
        ${transcriptHTML}
    </div>
    
    <div class="footer-note">
        Generated by CXFlow Meeting Bot • ${new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })}
    </div>
</body>
</html>
    `;
}

/**
 * Save PDF to file
 * @param {Buffer} pdfBuffer - PDF buffer
 * @param {string} outputPath - Output file path
 */
async function savePDF(pdfBuffer, outputPath) {
    await fs.writeFile(outputPath, pdfBuffer);
    console.log(`💾 PDF saved to: ${outputPath}`);
}

/**
 * Generate and save PDF for a bot
 * @param {string} botId - Bot ID
 * @param {string} runtimeRoot - Runtime root directory
 * @returns {Promise<{pdfPath: string, meetingTitle: string}>} Path to generated PDF and meeting title
 */
async function generateBotPDF(botId, runtimeRoot) {
    const botDir = path.join(runtimeRoot, botId);
    
    // Load data
    const summaryPath = path.join(botDir, 'summary.txt');
    const captionsPath = path.join(botDir, 'transcripts', 'captions.json');
    const metricsPath = path.join(botDir, 'MeetingMetrics.json');
    const metadataPath = path.join(botDir, 'bot_metadata.json');
    
    let summary = '';
    let transcript = [];
    let metrics = null;
    let metadata = null;
    
    // Load metadata to get meeting title
    if (fs.existsSync(metadataPath)) {
        try {
            metadata = await fs.readJson(metadataPath);
        } catch (e) {
            console.warn(`⚠️  Could not parse metadata for ${botId}:`, e.message);
        }
    }
    
    if (fs.existsSync(summaryPath)) {
        summary = await fs.readFile(summaryPath, 'utf8');
    }
    
    if (fs.existsSync(captionsPath)) {
        const captions = JSON.parse(await fs.readFile(captionsPath, 'utf8'));
        const { buildUtterances } = require('../openai-service');
        transcript = buildUtterances(captions);
    }
    
    if (fs.existsSync(metricsPath)) {
        metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
    }
    
    // Determine meeting title: prefer metadata title, fallback to default format
    let meetingTitle = `Meeting ${botId.slice(0, 8)}`;
    if (metadata && metadata.title && metadata.title.trim()) {
        meetingTitle = metadata.title.trim();
    }
    
    // Get meetUrl from metadata or metrics
    const meetUrl = metadata?.meetUrl || metrics?.meetUrl || '';
    
    // Generate PDF
    const pdfBuffer = await generateMeetingPDF({
        botId,
        title: meetingTitle,
        transcript,
        summary,
        metrics,
        meetUrl: meetUrl,
        createdAt: metadata?.createdAt || metrics?.duration?.startTime
    });
    
    // Sanitize title for filename (remove invalid characters)
    const sanitizeFilename = (text) => {
        return text.replace(/[^\w\-_.() ]/g, '_').replace(/\s+/g, '_').substring(0, 80);
    };
    const sanitizedTitle = sanitizeFilename(meetingTitle);
    
    // Save PDF with meeting title in filename (include botId for uniqueness)
    const pdfPath = path.join(botDir, `meeting-transcript-${sanitizedTitle}-${botId.slice(0, 8)}.pdf`);
    await savePDF(pdfBuffer, pdfPath);
    
    return { pdfPath, meetingTitle };
}

/**
 * Format timestamp for display
 */
function formatTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

/**
 * Escape HTML characters
 */
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = {
    generateMeetingPDF,
    generateBotPDF,
    savePDF
};

