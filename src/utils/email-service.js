/**
 * Email Service for Meeting Summaries
 * 
 * Handles sending meeting summaries, transcripts, and metrics via email
 * Supports multiple email providers (Gmail, SendGrid, SMTP)
 */

const nodemailer = require('nodemailer');
const fs = require('fs-extra');
const path = require('path');
const { formatDateLong } = require('./timezone');

/**
 * Create email transporter based on configuration
 * @returns {Object} Nodemailer transporter
 */
function createTransporter() {
    const emailProvider = process.env.EMAIL_PROVIDER || 'smtp';
    
    switch (emailProvider.toLowerCase()) {
        case 'gmail':
            return nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD // Use App Password for Gmail
                }
            });
        
        case 'sendgrid':
            // Use SMTP relay for SendGrid
            return nodemailer.createTransport({
                host: 'smtp.sendgrid.net',
                port: 587,
                secure: false,
                auth: {
                    user: 'apikey',
                    pass: process.env.SENDGRID_API_KEY || ''
                }
            });
        
        case 'smtp':
        default:
            return nodemailer.createTransport({
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT) || 587,
                secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD
                }
            });
    }
}

/**
 * Format metrics for email display
 * @param {Object} metrics - Meeting metrics object
 * @returns {string} HTML formatted metrics
 */
function formatMetricsHTML(metrics) {
    if (!metrics) return '<p>No metrics available</p>';
    
    let html = '<div style="font-family: Arial, sans-serif; color: #333;">';
    
    // Timezone info
    if (metrics.timezone) {
        html += `<p style="color: #475569; font-size: 12px;">
            <strong>Zona Horaria:</strong> ${metrics.timezone.displayName} (${metrics.timezone.name})
        </p>`;
    }
    
    // Duration
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">📊 Duración</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.duration.totalMinutes} minutos (${formatTime(metrics.duration.totalSeconds)})</li>`;
    html += `<li><strong>Inicio:</strong> ${metrics.duration.startTimeFormatted || 'N/A'}</li>`;
    html += `<li><strong>Fin:</strong> ${metrics.duration.endTimeFormatted || 'N/A'}</li>`;
    html += '</ul>';
    
    // Participation
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">👥 Participación</h3>';
    html += '<ul>';
    html += `<li><strong>Total de participantes:</strong> ${metrics.participation.totalParticipants}</li>`;
    html += `<li><strong>Participantes:</strong> ${metrics.participation.speakers.join(', ')}</li>`;
    html += '</ul>';
    
    // Talk Time
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">🗣️ Tiempo de Conversación</h3>';
    html += '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">';
    html += '<tr style="background-color: #eef9ff;">';
    html += '<th style="padding: 8px; text-align: left; border: 1px solid #e6f0fb;">Participante</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #e6f0fb;">Tiempo</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #e6f0fb;">Porcentaje</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #e6f0fb;">Intervenciones</th>';
    html += '</tr>';
    
    const sortedSpeakers = Object.entries(metrics.talkTime.byParticipant || {})
        .sort(([, a], [, b]) => b.totalMs - a.totalMs);
    
    sortedSpeakers.forEach(([speaker, data]) => {
        const barWidth = data.percentage;
        html += '<tr>';
        html += `<td style="padding: 8px; border: 1px solid #e6f0fb;">${speaker}</td>`;
        html += `<td style="padding: 8px; text-align: center; border: 1px solid #e6f0fb;">${data.totalMinutes}min</td>`;
        html += `<td style="padding: 8px; border: 1px solid #e6f0fb;">
            <div style="background-color: #e6f0fb; width: 100%; border-radius: 3px;">
                <div style="background-color: #2563eb; width: ${barWidth}%; padding: 2px 5px; color: white; border-radius: 3px; text-align: center; min-width: 40px;">
                    ${data.percentage.toFixed(1)}%
                </div>
            </div>
        </td>`;
        html += `<td style="padding: 8px; text-align: center; border: 1px solid #e6f0fb;">${data.segmentCount}</td>`;
        html += '</tr>';
    });
    
    html += '</table>';
    
    // Interruptions
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">⚡ Interrupciones</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.interruptions.total}</li>`;
    if (metrics.interruptions.total > 0) {
        const avgGap = metrics.interruptions.details.reduce((sum, d) => sum + d.gapMs, 0) / metrics.interruptions.total;
        html += `<li><strong>Tiempo promedio entre interrupciones:</strong> ${Math.round(avgGap)}ms</li>`;
    }
    html += '</ul>';
    
    // Silence
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">🤫 Silencios</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.silence.totalMinutes} minutos (${metrics.silence.totalSeconds}s)</li>`;
    html += `<li><strong>Períodos de silencio:</strong> ${metrics.silence.periods.length}</li>`;
    if (metrics.silence.periods.length > 0) {
        const longest = Math.max(...metrics.silence.periods.map(p => p.durationMs));
        html += `<li><strong>Silencio más largo:</strong> ${Math.round(longest / 1000)}s</li>`;
    }
    html += '</ul>';
    
    // Keywords
    html += '<h3 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 5px;">🔑 Palabras Clave</h3>';
    html += '<ul>';
    html += `<li><strong>Total de menciones:</strong> ${metrics.keywords.total}</li>`;
    if (metrics.keywords.total > 0) {
        html += '<li><strong>Palabras más mencionadas:</strong><ul>';
        const topKeywords = Object.entries(metrics.keywords.byKeyword || {})
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);
        
        topKeywords.forEach(([keyword, count]) => {
            html += `<li>${keyword}: ${count}x</li>`;
        });
        html += '</ul></li>';
    }
    html += '</ul>';
    
    html += '</div>';
    return html;
}

/**
 * Format time in HH:MM:SS
 */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Send meeting summary email
 * @param {Object} options - Email options
 * @param {string} options.botId - Bot ID
 * @param {string} options.meetUrl - Meeting URL
 * @param {string} options.recipients - Comma-separated email addresses
 * @param {string} options.runtimeRoot - Runtime directory path
 * @returns {Promise<Object>} Email result
 */
async function sendMeetingSummaryEmail(options) {
    const { botId, meetUrl, recipients, runtimeRoot, shareUrl, isShareRequest } = options;
    
    if (!recipients || !process.env.EMAIL_USER) {
        console.log(`[${botId}] ⚠️ Email not configured or no recipients specified`);
        return { success: false, message: 'Email not configured' };
    }
    
    // Normalize recipients: handle both string and array, clean up whitespace
    let normalizedRecipients;
    if (Array.isArray(recipients)) {
        // If it's an array, join with comma
        normalizedRecipients = recipients.map(email => email.trim()).filter(email => email).join(', ');
    } else if (typeof recipients === 'string') {
        // If it's a string, split by comma, trim, and rejoin to clean up
        normalizedRecipients = recipients
            .split(',')
            .map(email => email.trim())
            .filter(email => email)
            .join(', ');
    } else {
        console.log(`[${botId}] ⚠️ Invalid recipients format`);
        return { success: false, message: 'Invalid recipients format' };
    }
    
    if (!normalizedRecipients) {
        console.log(`[${botId}] ⚠️ No valid email recipients after normalization`);
        return { success: false, message: 'No valid email recipients' };
    }
    
    try {
        console.log(`[${botId}] 📧 Preparing email for: ${normalizedRecipients}`);
        
        const botDir = path.join(runtimeRoot, botId);
        const summaryFile = path.join(botDir, 'summary.txt');
        const metricsFile = path.join(botDir, 'MeetingMetrics.json');
    const captionsFile = path.join(botDir, 'transcripts', 'captions.json');
        
    // Load data
        let summary = 'No summary available';
        let metrics = null;
    let captions = null;
        let meetingTitle = 'Google Meet Recording';
        
        if (fs.existsSync(summaryFile)) {
            summary = await fs.readFile(summaryFile, 'utf8');
        }
        
        if (fs.existsSync(metricsFile)) {
            const metricsData = await fs.readFile(metricsFile, 'utf8');
            metrics = JSON.parse(metricsData);
        }

        // Load captions (transcript) if available
        if (fs.existsSync(captionsFile)) {
            try {
                const captionsData = await fs.readFile(captionsFile, 'utf8');
                captions = JSON.parse(captionsData);
                if (Array.isArray(captions) && captions.length > 0) {
                    // Try to derive a human-friendly meeting title from the first caption timestamp
                    if (captions[0].timestampMs) {
                        meetingTitle = `Reunión - ${formatDateLong(new Date(Number(captions[0].timestampMs)))}`;
                    }
                }
            } catch (err) {
                console.warn(`[${botId}] Could not parse captions file: ${err.message}`);
                captions = null;
            }
        }
        
        // Create transporter
        const transporter = createTransporter();
        
        // Prepare attachments
        const attachments = [];
        
        if (fs.existsSync(summaryFile)) {
            attachments.push({
                filename: 'resumen.txt',
                path: summaryFile
            });
        }
        
        if (fs.existsSync(metricsFile)) {
            attachments.push({
                filename: 'metricas.json',
                path: metricsFile
            });
        }
        
        if (fs.existsSync(captionsFile)) {
            attachments.push({
                filename: 'transcripcion.json',
                path: captionsFile
            });
        }
        
        // Prepare email HTML
        const formatCaptionsHTML = (captionsArray) => {
            if (!captionsArray || !Array.isArray(captionsArray) || captionsArray.length === 0) {
                return '<p style="color: #6b7280;">No transcript available</p>';
            }

            // Build HTML blocks per utterance
            let html = '<div style="max-height: 400px; overflow:auto; background:#fff; border:1px solid #e6eef6; padding:12px; border-radius:8px;">';
            html += '<div style="font-family: Arial, sans-serif; color: #333;">';

            captionsArray.forEach((item, idx) => {
                // Defensive property checks
                const speaker = item.speaker || item.name || item.spk || 'Speaker';
                const text = (item.text || item.content || item.caption || item.line || '').toString();
                const tsMs = item.timestampMs || item.startTimeMs || item.start || item.t || null;
                const seconds = tsMs ? Math.floor(Number(tsMs) / 1000) : (item.startOffset ? Math.floor(Number(item.startOffset)) : null);
                const timeLabel = seconds !== null ? formatTime(seconds) : '';

                html += `<div style="padding:8px 0; border-bottom:1px solid #f1f5f9;">`;
                html += `<div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">`;
                html += `<div style="font-weight:600; color:#0f172a;">${escapeHtml(speaker)}</div>`;
                html += `<div style="font-size:12px; color:#64748b;">${timeLabel}</div>`;
                html += `</div>`;
                html += `<div style="margin-top:6px; white-space:pre-wrap; color:#111827;">${escapeHtml(text)}</div>`;
                html += `</div>`;
            });

            html += '</div></div>';
            return html;
        };

        // Simple HTML escape to avoid breaking the email
        const escapeHtml = (unsafe) => {
            if (!unsafe) return '';
            return unsafe
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const emailHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background-color: #2563eb; color: white; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .header h1 { margin: 0; font-size: 24px; }
        .section { margin-bottom: 30px; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 2px solid #ddd; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Resumen de Reunión</h1>
        <p style="margin: 5px 0 0 0;">${meetingTitle}</p>
    </div>
    
    ${shareUrl ? `
    <div class="section" style="background: #f0f9ff; border: 2px solid #2563eb; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
        <h2 style="color: #2563eb; margin-top: 0;">🔗 View Online</h2>
        <p style="margin-bottom: 15px; color: #2563eb;">Access the complete meeting recording, transcript, and interactive features:</p>
        <a href="${shareUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
            📺 View Meeting Recording
        </a>
        <p style="font-size: 12px; color: #475569; margin-top: 10px;">Click the link above to access the full interactive meeting experience with video playback and searchable transcript.</p>
    </div>
    ` : ''}
    
    <div class="section">
        <h2 style="color: #2563eb;">📝 Resumen</h2>
        <div style="background-color: #f8fbff; padding: 15px; border-left: 4px solid #2563eb; white-space: pre-wrap;">${summary}</div>
    </div>
    
    <div class="section">
        <h2 style="color: #2563eb;">📈 Métricas de la Reunión</h2>
        ${formatMetricsHTML(metrics)}
    </div>
    
    ${captions ? `
    <div class="section">
    <h2 style="color: #2563eb;">🔉 Transcripción</h2>
        ${formatCaptionsHTML(captions)}
    </div>
    ` : ''}
    
    <div class="section">
    <h2 style="color: #2563eb;">📎 Archivos Adjuntos</h2>
        <p>Esta reunión incluye los siguientes archivos:</p>
        <ul>
            <li><strong>resumen.txt</strong> - Resumen textual de la reunión</li>
            <li><strong>metricas.json</strong> - Métricas detalladas (duración, tiempo de conversación, interrupciones, etc.)</li>
            <li><strong>transcripcion.json</strong> - Transcripción completa con marcas de tiempo</li>
        </ul>
    </div>
    
    <div class="footer">
        <p><strong>CXFlow Meeting Bot</strong></p>
        <p>Este es un correo automático generado por el sistema de grabación de reuniones.</p>
        <p>URL de la reunión: <a href="${meetUrl}">${meetUrl}</a></p>
        <p>ID del Bot: ${botId}</p>
    </div>
</body>
</html>
        `;
        
        // Send email
        const emailSubject = isShareRequest 
            ? `🔗 Shared: ${meetingTitle} - Meeting Summary & Recording`
            : `📊 Resumen de Reunión - ${meetingTitle}`;
            
        const mailOptions = {
            from: `"CXFlow AI Summary" <contacto@cxflow.io>`,
            replyTo: 'contacto@cxflow.io',
            to: normalizedRecipients, // Nodemailer supports comma-separated string for multiple recipients
            subject: emailSubject,
            html: emailHTML,
            attachments: attachments
        };
        
        const info = await transporter.sendMail(mailOptions);
        
        console.log(`[${botId}] ✅ Email sent successfully to: ${normalizedRecipients}`);
        console.log(`[${botId}] Message ID: ${info.messageId}`);
        
        return {
            success: true,
            messageId: info.messageId,
            recipients: normalizedRecipients,
            attachments: attachments.length
        };
        
    } catch (error) {
        console.error(`[${botId}] ❌ Error sending email:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Verify email configuration
 * @returns {Promise<Object>} Verification result
 */
async function verifyEmailConfig() {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
            return {
                configured: false,
                message: 'EMAIL_USER or EMAIL_PASSWORD not set'
            };
        }
        
        const transporter = createTransporter();
        await transporter.verify();
        
        return {
            configured: true,
            message: 'Email configuration verified successfully',
            provider: process.env.EMAIL_PROVIDER || 'smtp',
            user: process.env.EMAIL_USER
        };
    } catch (error) {
        return {
            configured: false,
            message: `Email configuration error: ${error.message}`
        };
    }
}

/**
 * Send email verification email
 * @param {Object} options - Email options
 * @param {string} options.email - User email address
 * @param {string} options.verificationToken - Verification token
 * @param {string} options.baseUrl - Base URL for verification link
 * @returns {Promise<Object>} Email result
 */
async function sendVerificationEmail(options) {
    const { email, verificationToken, baseUrl } = options;
    
    if (!process.env.EMAIL_USER) {
        console.log('⚠️ Email not configured for verification');
        return { success: false, message: 'Email not configured' };
    }
    
    try {
        console.log(`📧 Sending verification email to: ${email}`);
        
        const verificationUrl = `${baseUrl}/api/verify-email?token=${verificationToken}`;
        
        // Create transporter
        const transporter = createTransporter();
        
                // Prepare email HTML (table-based, inline styles for compatibility)
                const emailHTML = `
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Welcome to CXFlow</title>
    <style>body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse!important}img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none}a{text-decoration:none}</style>
</head>
<body style="margin:0;padding:0;background-color:#f5fbff;">
    <!--[if mso]><style type="text/css"> .fallback-font { font-family: Arial, sans-serif !important; } </style><![endif]-->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5fbff;padding:20px 0;width:100%;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:600px;background:#ffffff;">
                    <tr>
                        <td align="center" style="background:#2563eb;padding:26px 20px;color:#fff;">
                            <div style="font-family:Arial,sans-serif;font-size:20px;font-weight:700;">Welcome to CXFlow!</div>
                            <div style="font-family:Arial,sans-serif;font-size:14px;margin-top:6px;">You're one step away — verify your email to get started</div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px;">
                            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                                <tr>
                                    <td style="font-family:Arial,sans-serif;color:#333;font-size:15px;line-height:1.5;">
                                        <p style="margin:0 0 12px 0;">Hello,</p>
                                        <p style="margin:0 0 12px 0;">Thanks for creating an account. Click the button below to verify your email and activate your account.</p>

                                        <!-- Button -->
                                        <table cellpadding="0" cellspacing="0" role="presentation" style="margin:18px auto;">
                                            <tr>
                                                <td align="center" bgcolor="#2563eb" style="border-radius:6px;">
                                                    <!--[if mso]>
                                                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${verificationUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="8%" stroke="f" fillcolor="#2563eb">
                                                        <w:anchorlock/>
                                                        <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:600;">Verify Email Address</center>
                                                    </v:roundrect>
                                                    <![endif]-->
                                                    <!--[if !mso]><!-- -->
                                                    <a href="${verificationUrl}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:600;border-radius:6px;">Verify Email Address</a>
                                                    <!--<![endif]-->
                                                </td>
                                            </tr>
                                        </table>

                                        <p style="margin:0 0 12px 0;">If the button doesn't work, copy and paste this link into your browser:</p>
                                        <p style="word-break:break-all;margin:0 0 12px 0;"><a href="${verificationUrl}" style="color:#2563eb;">${verificationUrl}</a></p>

                                        <div style="background:#f0f9ff;border:1px solid #dff3ff;padding:12px;border-radius:6px;color:#2563eb;font-family:Arial,sans-serif;font-size:13px;">This verification link will expire in 24 hours.</div>
                                        <div style="margin-top:14px;font-family:Arial,sans-serif;font-size:13px;color:#6b7280;">If you didn't create this account, you can safely ignore this email.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:16px;background:#f8fafc;font-family:Arial,sans-serif;font-size:13px;color:#6b7280;text-align:center;">
                            <div style="font-weight:600;color:#374151;">CXFlow</div>
                            <div style="margin-top:6px;">Automated meeting transcription and AI-powered analysis</div>
                            <div style="margin-top:8px;font-size:12px;color:#2563eb;">Need help? <a href="mailto:contacto@cxflow.io" style="color:#2563eb;">contacto@cxflow.io</a></div>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
                `;
        
        // Send email
        const mailOptions = {
            from: `"CXFlow" <contacto@cxflow.io>`,
            replyTo: 'contacto@cxflow.io',
            to: email,
            subject: '🎉 Welcome to CXFlow! Please verify your account',
            html: emailHTML
        };
        
        const info = await transporter.sendMail(mailOptions);
        
        console.log(`✅ Verification email sent successfully to: ${email}`);
        console.log(`Message ID: ${info.messageId}`);
        console.log(`Email Provider: ${process.env.EMAIL_PROVIDER || 'smtp'}`);
        console.log(`From Address: ${process.env.EMAIL_USER}`);
        console.log(`Verification URL: ${verificationUrl}`);
        
        return {
            success: true,
            messageId: info.messageId,
            email: email
        };
        
    } catch (error) {
        console.error(`❌ Error sending verification email:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Send password reset email
 * @param {string} email - User's email address
 * @param {string} resetToken - Password reset token
 * @param {string} baseUrl - Base URL for the application
 */
async function sendPasswordResetEmail(email, resetToken, baseUrl = 'http://localhost:3000') {
    try {
        console.log(`📧 Preparing to send password reset email to: ${email}`);

        // Defensive check: ensure email exists in database before sending reset link
        const { userOps } = require('../database');
        const user = userOps.findByEmail(email);
        if (!user) {
            console.warn(`⚠️  Attempted password reset for unknown email: ${email}`);
            return { success: false, error: 'No account found with this email' };
        }

        const transporter = createTransporter();
        const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
        
                const emailHTML = `
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Reset Your Password - CXFlow</title>
    <style>
        /* Client-specific CSS resets */
        body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
        table { border-collapse:collapse !important; }
        img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
        a { text-decoration:none; }
    </style>
</head>
<body style="margin:0; padding:0; background-color:#f5fbff;">
    <!--[if mso]>
    <style type="text/css"> .fallback-font { font-family: Arial, sans-serif !important; } </style>
    <![endif]-->

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f5fbff; padding:20px 0; width:100%;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:100%; max-width:600px; background:#ffffff;">
                    <tr>
                        <td align="center" style="background-color:#2563eb; padding:28px 20px; color:#ffffff;">
                            <div style="font-family: Arial, sans-serif; font-size:20px; font-weight:700;">Reset Your Password</div>
                            <div style="font-family: Arial, sans-serif; font-size:14px; margin-top:6px;">We received a request to reset your password</div>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:28px 24px;">
                            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                                <tr>
                                    <td style="font-family: Arial, sans-serif; font-size:15px; color:#333333; line-height:1.5;">
                                        <p style="margin:0 0 12px 0;">Hello,</p>
                                        <p style="margin:0 0 12px 0;">We received a request to reset the password for your CXFlow account associated with <strong>${email}</strong>.</p>
                                        <p style="margin:0 0 18px 0;">If you requested this, click the button below to reset your password. This link expires in 1 hour for security reasons.</p>

                                        <!-- Button : BEGIN -->
                                        <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto 18px auto;">
                                            <tr>
                                                <td align="center" bgcolor="#2563eb" style="border-radius:6px;">
                                                    <!--[if mso]>
                                                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${resetUrl}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="8%" stroke="f" fillcolor="#2563eb">
                                                        <w:anchorlock/>
                                                        <center style="color:#ffffff;font-family:Arial, sans-serif;font-size:16px;font-weight:600;">Reset My Password</center>
                                                    </v:roundrect>
                                                    <![endif]-->
                                                    <!--[if !mso]><!-- -->
                                                    <a href="${resetUrl}" style="display:inline-block; padding:12px 28px; background-color:#2563eb; color:#ffffff; font-family: Arial, sans-serif; font-size:16px; font-weight:600; border-radius:6px;">Reset My Password</a>
                                                    <!--<![endif]-->
                                                </td>
                                            </tr>
                                        </table>
                                        <!-- Button : END -->

                                        <p style="margin:0 0 12px 0;">If the button doesn't work, copy and paste this link into your browser:</p>
                                        <p style="word-break:break-all; margin:0 0 12px 0;"><a href="${resetUrl}" style="color:#2563eb;">${resetUrl}</a></p>

                                        <div style="background:#eef9ff; border:1px solid #dff3ff; padding:12px; border-radius:6px; font-family: Arial, sans-serif; font-size:13px; color:#03436a; margin-top:10px;">
                                            This link will expire in 1 hour and can only be used once.
                                        </div>

                                        <div style="margin-top:18px; font-family: Arial, sans-serif; font-size:13px; color:#6b7280;">
                                            If you didn't request this password reset, you can safely ignore this email.
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:18px 24px; background-color:#f8fafc; font-family: Arial, sans-serif; font-size:13px; color:#6b7280;">
                            <div style="text-align:center;">
                                <div style="font-weight:600; color:#374151;">CXFlow</div>
                                <div style="margin-top:6px;">Automated meeting transcription and AI-powered analysis</div>
                                <div style="margin-top:8px; font-size:12px; color:#2563eb;">Need help? <a href="mailto:contacto@cxflow.io" style="color:#2563eb;">contacto@cxflow.io</a></div>
                            </div>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
                `;
        
        // Send email
        const mailOptions = {
            from: `"CXFlow" <contacto@cxflow.io>`,
            replyTo: 'contacto@cxflow.io',
            to: email,
            subject: '🔐 Reset your CXFlow password',
            html: emailHTML
        };
        
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Password reset email sent successfully');
        console.log('Message ID:', info.messageId);
        console.log('✅ Password reset email sent to:', email);
        
        return { success: true, messageId: info.messageId };
        
    } catch (error) {
        console.error('❌ Error sending password reset email:', error);
        throw error;
    }
}

module.exports = {
    sendMeetingSummaryEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    verifyEmailConfig,
    createTransporter
};

