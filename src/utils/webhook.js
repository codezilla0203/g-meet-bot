const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs-extra');
const { getCurrentTimestamp } = require('./timezone');
// Import configOps to read user's saved webhook_url if needed
const { configOps } = require('../database');

/**
 * sendWebhook(eventName, data)
 * Best-effort POST to configured WEBHOOK_URL.
 * Automatically augments payload with timestamp fields (iso + formatted + timezone).
 */
// Helper: try to extract a meeting/bot id from a full meet URL or path
function extractMeetingIdFromUrl(u) {
    if (!u) return null;
    try {
        const parsed = new URL(u);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length === 0) return null;
        // heuristic: Google Meet ids are path segments like abc-defg-hij or long tokens
        for (const p of parts) {
            if (/^[a-z0-9-]{6,}$/i.test(p)) return p;
        }
        return parts[0];
    } catch (e) {
        // not a full URL, try simple segment extraction
        const parts = String(u).split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : null;
    }
}

async function resolveWebhookUrl(overrideUrl, data) {
    // Priority: explicit override -> env WEBHOOK_URL -> runtime metadata -> DB user config
    if (overrideUrl) return overrideUrl;

    try {
        // Try to resolve by meeting_id or meeting_url fields in data
        const meetingId = data && (data.meeting_id || (data.meeting_url && extractMeetingIdFromUrl(data.meeting_url)));
        if (meetingId) {
            const metadataPath = path.join(__dirname, '..', 'runtime', String(meetingId), 'bot_metadata.json');
            if (await fs.pathExists(metadataPath)) {
                try {
                    const meta = await fs.readJson(metadataPath);
                    if (meta) {
                        if (meta.webhookUrl) return meta.webhookUrl;
                        if (meta.userId) {
                            try {
                                const cfg = configOps.getByUserId(meta.userId);
                                if (cfg && (cfg.webhook_url || cfg.webhookUrl)) return cfg.webhook_url;
                            } catch (e) {}
                        }
                    }
                } catch (e) {
                    // ignore and continue to DB fallback
                }
            }
        }
    } catch (e) {
        // ignore errors and try DB fallback below
    }

    // As a last resort, if data includes user_id, try DB directly
    try {
        const userId = data && (data.user_id || data.userId);
        if (userId) {
            const cfg = configOps.getByUserId(userId);
            if (cfg && (cfg.webhook_url || cfg.webhookUrl)) return cfg.webhook_url || cfg.webhookUrl;
        }
    } catch (e) {}

    return null;
}

async function sendWebhook(eventName, data = {}, overrideUrl = null) {
    const url = await resolveWebhookUrl(overrideUrl, data);
    if (!url) return;

    try {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const ts = getCurrentTimestamp ? getCurrentTimestamp() : { iso: new Date().toISOString(), formatted: new Date().toISOString(), timezone: process.env.TIMEZONE || 'UTC' };

        const payload = Object.assign({}, data, {
            timestamp_iso: ts.iso,
            timestamp: ts.formatted,
            timezone: ts.timezone
        });

        const postData = JSON.stringify({ event: eventName, data: payload });

        const opts = {
            method: 'POST',
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: Number(process.env.WEBHOOK_TIMEOUT_MS || 5000)
        };

        await new Promise((resolve, reject) => {
            const req = lib.request(opts, (res) => {
                let body = '';
                res.on('data', (d) => body += d);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
                    return reject(new Error(`Webhook responded ${res.statusCode}: ${body}`));
                });
            });
            req.on('error', (err) => reject(err));
            req.on('timeout', () => { req.destroy(new Error('Webhook request timeout')); });
            req.write(postData);
            req.end();
        });

        console.log(`✅ Webhook '${eventName}' sent to ${url}`);
    } catch (err) {
        console.warn(`⚠️ Failed to send webhook '${eventName}': ${err && err.message ? err.message : err}`);
    }
}

module.exports = { sendWebhook };
