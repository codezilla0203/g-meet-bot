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
            return nodemailer.createTransporter({
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
        html += `<p style="color: #666; font-size: 12px;">
            <strong>Zona Horaria:</strong> ${metrics.timezone.displayName} (${metrics.timezone.name})
        </p>`;
    }
    
    // Duration
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">📊 Duración</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.duration.totalMinutes} minutos (${formatTime(metrics.duration.totalSeconds)})</li>`;
    html += `<li><strong>Inicio:</strong> ${metrics.duration.startTimeFormatted || 'N/A'}</li>`;
    html += `<li><strong>Fin:</strong> ${metrics.duration.endTimeFormatted || 'N/A'}</li>`;
    html += '</ul>';
    
    // Participation
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">👥 Participación</h3>';
    html += '<ul>';
    html += `<li><strong>Total de participantes:</strong> ${metrics.participation.totalParticipants}</li>`;
    html += `<li><strong>Participantes:</strong> ${metrics.participation.speakers.join(', ')}</li>`;
    html += '</ul>';
    
    // Talk Time
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">🗣️ Tiempo de Conversación</h3>';
    html += '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">';
    html += '<tr style="background-color: #f0f0f0;">';
    html += '<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">Participante</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #ddd;">Tiempo</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #ddd;">Porcentaje</th>';
    html += '<th style="padding: 8px; text-align: center; border: 1px solid #ddd;">Intervenciones</th>';
    html += '</tr>';
    
    const sortedSpeakers = Object.entries(metrics.talkTime.byParticipant || {})
        .sort(([, a], [, b]) => b.totalMs - a.totalMs);
    
    sortedSpeakers.forEach(([speaker, data]) => {
        const barWidth = data.percentage;
        html += '<tr>';
        html += `<td style="padding: 8px; border: 1px solid #ddd;">${speaker}</td>`;
        html += `<td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${data.totalMinutes}min</td>`;
        html += `<td style="padding: 8px; border: 1px solid #ddd;">
            <div style="background-color: #e0e0e0; width: 100%; border-radius: 3px;">
                <div style="background-color: #2A9ACA; width: ${barWidth}%; padding: 2px 5px; color: white; border-radius: 3px; text-align: center; min-width: 40px;">
                    ${data.percentage.toFixed(1)}%
                </div>
            </div>
        </td>`;
        html += `<td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${data.segmentCount}</td>`;
        html += '</tr>';
    });
    
    html += '</table>';
    
    // Interruptions
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">⚡ Interrupciones</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.interruptions.total}</li>`;
    if (metrics.interruptions.total > 0) {
        const avgGap = metrics.interruptions.details.reduce((sum, d) => sum + d.gapMs, 0) / metrics.interruptions.total;
        html += `<li><strong>Tiempo promedio entre interrupciones:</strong> ${Math.round(avgGap)}ms</li>`;
    }
    html += '</ul>';
    
    // Silence
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">🤫 Silencios</h3>';
    html += '<ul>';
    html += `<li><strong>Total:</strong> ${metrics.silence.totalMinutes} minutos (${metrics.silence.totalSeconds}s)</li>`;
    html += `<li><strong>Períodos de silencio:</strong> ${metrics.silence.periods.length}</li>`;
    if (metrics.silence.periods.length > 0) {
        const longest = Math.max(...metrics.silence.periods.map(p => p.durationMs));
        html += `<li><strong>Silencio más largo:</strong> ${Math.round(longest / 1000)}s</li>`;
    }
    html += '</ul>';
    
    // Keywords
    html += '<h3 style="color: #2A9ACA; border-bottom: 2px solid #2A9ACA; padding-bottom: 5px;">🔑 Palabras Clave</h3>';
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
    
    try {
        console.log(`[${botId}] 📧 Preparing email for: ${recipients}`);
        
        const botDir = path.join(runtimeRoot, botId);
        const summaryFile = path.join(botDir, 'summary.txt');
        const metricsFile = path.join(botDir, 'MeetingMetrics.json');
        const captionsFile = path.join(botDir, 'transcripts', 'captions.json');
        
        // Load data
        let summary = 'No summary available';
        let metrics = null;
        let meetingTitle = 'Google Meet Recording';
        
        if (fs.existsSync(summaryFile)) {
            summary = await fs.readFile(summaryFile, 'utf8');
        }
        
        if (fs.existsSync(metricsFile)) {
            const metricsData = await fs.readFile(metricsFile, 'utf8');
            metrics = JSON.parse(metricsData);
            
            // Extract meeting title from first caption if available
            if (fs.existsSync(captionsFile)) {
                const captions = JSON.parse(await fs.readFile(captionsFile, 'utf8'));
                if (captions.length > 0) {
                    meetingTitle = `Reunión - ${formatDateLong(new Date(captions[0].timestampMs))}`;
                }
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
        const emailHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { background-color: #2A9ACA; color: white; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
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
    <div class="section" style="background: #f0f9ff; border: 2px solid #0ea5e9; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
        <h2 style="color: #0369a1; margin-top: 0;">🔗 View Online</h2>
        <p style="margin-bottom: 15px; color: #0369a1;">Access the complete meeting recording, transcript, and interactive features:</p>
        <a href="${shareUrl}" style="display: inline-block; background: #0ea5e9; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
            📺 View Meeting Recording
        </a>
        <p style="font-size: 12px; color: #64748b; margin-top: 10px;">Click the link above to access the full interactive meeting experience with video playback and searchable transcript.</p>
    </div>
    ` : ''}
    
    <div class="section">
        <h2 style="color: #2A9ACA;">📝 Resumen</h2>
        <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #2A9ACA; white-space: pre-wrap;">${summary}</div>
    </div>
    
    <div class="section">
        <h2 style="color: #2A9ACA;">📈 Métricas de la Reunión</h2>
        ${formatMetricsHTML(metrics)}
    </div>
    
    <div class="section">
        <h2 style="color: #2A9ACA;">📎 Archivos Adjuntos</h2>
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
            from: `"Alerts (CXFlow)" <contacto@cxflow.io>`,
            replyTo: 'contacto@cxflow.io',
            to: recipients,
            subject: emailSubject,
            html: emailHTML,
            attachments: attachments
        };
        
        const info = await transporter.sendMail(mailOptions);
        
        console.log(`[${botId}] ✅ Email sent successfully to: ${recipients}`);
        console.log(`[${botId}] Message ID: ${info.messageId}`);
        
        return {
            success: true,
            messageId: info.messageId,
            recipients: recipients,
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
        
        // Prepare email HTML
        const emailHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Account Successfully Created - Welcome to CXFlow!</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Poppins', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f7f6; }
        .container { background: white; overflow: hidden; }
        .header { background-color: #667eea; color: white; padding: 40px 30px; text-align: center; }
        .success-badge { background-color: #8b9cf7; display: inline-block; padding: 8px 16px; font-size: 14px; font-weight: 500; margin-bottom: 15px; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .header p { margin: 15px 0 0 0; color: #e6e9ff; font-size: 16px; }
        .content { padding: 40px 30px; }
        .welcome-section { text-align: center; margin-bottom: 35px; }
        .welcome-section h2 { color: #1f2937; margin: 0 0 15px 0; font-size: 24px; }
        .welcome-section p { color: #4b5563; font-size: 16px; margin: 0; }
        .steps-container { margin: 30px 0; }
        .step { margin: 25px 0; }
        .step-number { background-color: #667eea; color: white; width: 35px; height: 35px; text-align: center; line-height: 35px; font-weight: 600; font-size: 16px; }
        .step-title { margin: 0 0 8px 0; color: #1f2937; font-size: 18px; font-weight: 600; }
        .step-text { margin: 0; color: #4b5563; font-size: 15px; }
        .verification-box { background: #f0f9ff; border: 2px solid #3b82f6; padding: 25px; text-align: center; margin: 30px 0; }
        .verification-box h3 { color: #1e40af; margin: 0 0 15px 0; font-size: 20px; }
        .button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; font-weight: 600; margin: 15px 0; font-size: 16px; }
        .button:hover { opacity: 0.9; }
        .feature { background-color: #f0f9ff; padding: 15px; text-align: center; width: 100%; }
        .feature-icon { font-size: 24px; margin-bottom: 8px; }
        .feature-text { font-size: 14px; font-weight: 500; color: #1e40af; }
        .warning-box { background: #fef3c7; border: 1px solid #f59e0b; padding: 15px; margin: 25px 0; text-align: center; }
        .warning-box p { margin: 0; color: #92400e; font-size: 14px; }
        .footer { background: #f4f7f6; padding: 25px; text-align: center; font-size: 12px; color: #777; border-top: 1px solid #e5e7eb; }
        .logo { width: 28px; height: 28px; vertical-align: middle; margin-right: 10px; }
        .divider { height: 1px; background-color: #e5e7eb; margin: 30px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="success-badge">🎉 Account Successfully Created!</div>
            <h1><img src="https://www.cxflow.io/app/images/logo.png" alt="CXFlow Logo" class="logo">Welcome to CXFlow!</h1>
            <p>You're just one step away from revolutionizing your meetings</p>
        </div>
        
        <div class="content">
            <div class="welcome-section">
                <h2>Let's Get You Started! 🚀</h2>
                <p>Follow these 3 simple steps to activate your account and start creating amazing meeting bots:</p>
            </div>
            
            <div class="steps-container">
                <table width="100%" cellpadding="0" cellspacing="0" class="step">
                    <tr>
                        <td width="50" style="padding: 20px 15px 20px 20px; background-color: #f8fafc; border-left: 4px solid #667eea;">
                            <div class="step-number">1</div>
                        </td>
                        <td style="padding: 20px; background-color: #f8fafc;">
                            <h3 class="step-title">📧 Verify Your Email</h3>
                            <p class="step-text">Click the button to confirm and activate your account.</p>
                        </td>
                    </tr>
                </table>
                
                <table width="100%" cellpadding="0" cellspacing="0" class="step">
                    <tr>
                        <td width="50" style="padding: 20px 15px 20px 20px; background-color: #f8fafc; border-left: 4px solid #667eea;">
                            <div class="step-number">2</div>
                        </td>
                        <td style="padding: 20px; background-color: #f8fafc;">
                            <h3 class="step-title">🔐 Sign In</h3>
                            <p class="step-text">Log in to access your dashboard.</p>
                        </td>
                    </tr>
                </table>
                
                <table width="100%" cellpadding="0" cellspacing="0" class="step">
                    <tr>
                        <td width="50" style="padding: 20px 15px 20px 20px; background-color: #f8fafc; border-left: 4px solid #667eea;">
                            <div class="step-number">3</div>
                        </td>
                        <td style="padding: 20px; background-color: #f8fafc;">
                            <h3 class="step-title">🤖 Create Your First Bot</h3>
                            <p class="step-text">Build your bot for your next Google Meet.</p>
                        </td>
                    </tr>
                </table>
            </div>
            
            <div class="verification-box">
                <h3>Ready to Verify? 👆</h3>
                <p style="margin-bottom: 20px;">Click the button below to verify your email and unlock all features:</p>
                <a href="${verificationUrl}" class="button">✅ Verify Email Address</a>
                <p style="color: #6b7280; font-size: 13px; margin-top: 15px;">
                    Button not working? Copy this link: <br>
                    <a href="${verificationUrl}" style="color: #667eea; word-break: break-all; font-size: 12px;">${verificationUrl}</a>
                </p>
            </div>
            
            <div class="divider"></div>
            
            <h3 style="text-align: center; color: #1f2937; margin-bottom: 20px;">What You'll Get Access To:</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin: 25px 0;">
                <tr>
                    <td width="50%" style="padding: 5px;">
                        <div class="feature">
                            <div class="feature-icon">🤖</div>
                            <div class="feature-text">Smart Meeting Bots</div>
                        </div>
                    </td>
                    <td width="50%" style="padding: 5px;">
                        <div class="feature">
                            <div class="feature-icon">📊</div>
                            <div class="feature-text">AI-Powered Summaries</div>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td width="50%" style="padding: 5px;">
                        <div class="feature">
                            <div class="feature-icon">📝</div>
                            <div class="feature-text">Real-time Transcripts</div>
                        </div>
                    </td>
                    <td width="50%" style="padding: 5px;">
                        <div class="feature">
                            <div class="feature-icon">📧</div>
                            <div class="feature-text">Email Sharing</div>
                        </div>
                    </td>
                </tr>
            </table>
            
            <div class="warning-box">
                <p>
                    ⏰ <strong>Important:</strong> This verification link expires in 24 hours. 
                    Don't wait - verify now to secure your account!
                </p>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; text-align: center; margin-top: 30px;">
                Questions? We're here to help! Reply to this email or visit our support center.<br>
                If you didn't create this account, you can safely ignore this email.
            </p>
        </div>
        
        <div class="footer">
            <p style="margin: 0 0 10px 0;"><strong>CXFlow Meeting Bot</strong></p>
            <p style="margin: 0 0 10px 0;">Automated meeting transcription and AI-powered analysis</p>
            <p style="margin: 0;">© ${new Date().getFullYear()} CXFlow. All rights reserved. | <a href="https://www.cxflow.io" style="color: #667eea;">www.cxflow.io</a></p>
        </div>
    </div>
</body>
</html>
        `;
        
        // Send email
        const mailOptions = {
            from: `"Alerts (CXFlow)" <contacto@cxflow.io>`,
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
        console.log(`📧 Sending password reset email to: ${email}`);
        
        const transporter = createTransporter();
        const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
        
        const emailHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - CXFlow</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Poppins', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f4f7f6;
            padding: 20px;
        }
        
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.3);
        }
        
        .email-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 30px;
            text-align: center;
            color: white;
        }
        
        .logo-container {
            text-align: center;
            margin-bottom: 20px;
        }
        
        .logo {
            width: 80px;
            height: 80px;
            background: white;
            border-radius: 50%;
            margin: 0 auto;
            display: inline-block;
            text-align: center;
            line-height: 80px;
            font-size: 32px;
            font-weight: 700;
            color: #667eea;
            vertical-align: middle;
        }
        
        .email-header h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .email-header p {
            font-size: 16px;
            opacity: 0.9;
        }
        
        .email-body {
            padding: 40px 30px;
        }
        
        .email-body h2 {
            font-size: 24px;
            font-weight: 600;
            color: #1e293b;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .email-body p {
            font-size: 16px;
            color: #64748b;
            margin-bottom: 20px;
            line-height: 1.6;
        }
        
        .reset-button {
            display: block;
            width: fit-content;
            margin: 30px auto;
            padding: 16px 32px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-weight: 600;
            font-size: 16px;
            text-align: center;
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
        }
        
        .security-notice {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 20px;
            margin: 30px 0;
        }
        
        .security-notice h3 {
            font-size: 16px;
            font-weight: 600;
            color: #374151;
            margin-bottom: 10px;
        }
        
        .security-notice ul {
            padding-left: 20px;
            color: #64748b;
            font-size: 14px;
        }
        
        .security-notice li {
            margin-bottom: 5px;
        }
        
        .email-footer {
            background: #f8fafc;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #e2e8f0;
        }
        
        .email-footer p {
            font-size: 14px;
            color: #94a3b8;
            margin-bottom: 10px;
        }
        
        .email-footer a {
            color: #667eea;
            text-decoration: none;
        }
        
        .expiry-notice {
            background: #fef3cd;
            border: 1px solid #fbbf24;
            border-radius: 8px;
            padding: 15px;
            margin: 20px 0;
            text-align: center;
        }
        
        .expiry-notice p {
            color: #92400e;
            font-size: 14px;
            font-weight: 500;
            margin: 0;
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="email-header">
            <div class="logo-container">
                <div class="logo">CX</div>
            </div>
            <h1>Reset Your Password</h1>
            <p>We received a request to reset your password</p>
        </div>
        
        <div class="email-body">
            <h2>🔐 Password Reset Request</h2>
            
            <p>Hello,</p>
            
            <p>We received a request to reset the password for your CXFlow account associated with <strong>${email}</strong>.</p>
            
            <p>If you made this request, click the button below to reset your password:</p>
            
            <a href="${resetUrl}" class="reset-button">Reset My Password</a>
            
            <div class="expiry-notice">
                <p>⏰ This link will expire in 1 hour for security reasons</p>
            </div>
            
            <div class="security-notice">
                <h3>🛡️ Security Information</h3>
                <ul>
                    <li>This link can only be used once</li>
                    <li>If you didn't request this reset, you can safely ignore this email</li>
                    <li>Your password won't change until you create a new one</li>
                    <li>For security, we recommend using a strong, unique password</li>
                </ul>
            </div>
            
            <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #667eea; font-size: 14px;">${resetUrl}</p>
            
            <p>If you didn't request a password reset, please ignore this email or contact our support team if you have concerns.</p>
        </div>
        
        <div class="email-footer">
            <p>This email was sent by CXFlow</p>
            <p>Need help? Contact us at <a href="mailto:contacto@cxflow.io">contacto@cxflow.io</a></p>
            <p style="margin-top: 20px;">
                <a href="https://www.cxflow.io">www.cxflow.io</a>
            </p>
        </div>
    </div>
</body>
</html>
        `;
        
        // Send email
        const mailOptions = {
            from: `"Alerts (CXFlow)" <contacto@cxflow.io>`,
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

