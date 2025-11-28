const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs-extra');
const { getCurrentTimestamp } = require('./timezone');
// Import configOps to read user's saved webhook_url if needed
const { configOps, userOps } = require('../database');

async function sendWebhook(eventName, data = {}, overrideUrl = null) {
    // Resolve webhook URL priority:
    // 1) overrideUrl argument
    // 2) data.webhookUrl or data.webhook_url
    // 3) runtime/<botId>/bot_metadata.json (if bot_id or meeting_id can be matched)
    // 4) process.env.WEBHOOK_URL
    let resolvedUrl = null;
    try {
        if (overrideUrl && String(overrideUrl).trim()) resolvedUrl = String(overrideUrl).trim();

        // Short-circuit if payload includes an explicit webhook
        if (!resolvedUrl) {
            if (data && (data.webhookUrl || data.webhook_url)) {
                resolvedUrl = data.webhookUrl || data.webhook_url;
            }
        }

        const RUNTIME_ROOT = path.join(__dirname, '..', 'runtime');

        // Helper: try read runtime metadata for a given candidate id
        const tryMetadataForId = async (candidateId) => {
            if (!candidateId) return null;
            try {
                const metaPath = path.join(RUNTIME_ROOT, candidateId, 'bot_metadata.json');
                if (await fs.pathExists(metaPath)) {
                    const meta = await fs.readJson(metaPath).catch(() => null);
                    if (meta) return meta;
                }
            } catch (e) {}
            return null;
        };

        // Helper: get user email from userId
        const getUserEmail = (userId) => {
            if (!userId) return null;
            try {
                const user = userOps.findById(userId);
                return user ? user.email : null;
            } catch (e) {
                return null;
            }
        };

        // Helper: get account email from bot metadata
        const getAccountEmailFromMetadata = async (metadata) => {
            if (!metadata) return null;
            const userId = metadata.userId || metadata.user_id || null;
            if (!userId) return null;
            return getUserEmail(userId);
        };

        // If still unresolved, check for bot_id or botId in payload
        let botMetadata = null;
        if (!resolvedUrl && data) {
            const botId = data.bot_id || data.botId || null;
            if (botId) {
                const byBot = await tryMetadataForId(botId);
                if (byBot) {
                    botMetadata = byBot;
                    resolvedUrl = byBot.webhookUrl || byBot.webhook_url || null;
                }
            }
        }

        // If meeting id/url provided, try to extract id and map to runtime metadata; else scan runtime entries
        if (!resolvedUrl && data) {
            const meetingId = data.meeting_id || data.meetingId || null;
            const meetingUrl = data.meeting_url || data.meetUrl || data.meet_url || null;

            // If meetingId present, try direct folder
            if (meetingId && !botMetadata) {
                const byMeeting = await tryMetadataForId(meetingId);
                if (byMeeting) {
                    botMetadata = byMeeting;
                    resolvedUrl = byMeeting.webhookUrl || byMeeting.webhook_url || null;
                }
            }

            // If still unresolved and meetingUrl provided, try extract id from URL
            if (!resolvedUrl && meetingUrl) {
                try {
                    const u = new URL(meetingUrl);
                    const parts = u.pathname.split('/').filter(Boolean);
                    if (parts.length) {
                        const candidate = parts[0];
                        const byCandidate = await tryMetadataForId(candidate);
                        if (byCandidate && !botMetadata) {
                            botMetadata = byCandidate;
                            resolvedUrl = byCandidate.webhookUrl || byCandidate.webhook_url || null;
                        }
                    }
                } catch (e) {
                    // ignore
                }
            }

            // Fallback: scan runtime/*/bot_metadata.json looking for meeting_id or meetUrl matches
            if (!resolvedUrl && (meetingId || meetingUrl)) {
                try {
                    const dirs = await fs.readdir(RUNTIME_ROOT).catch(() => []);
                    for (const d of dirs) {
                        try {
                            const metaPath = path.join(RUNTIME_ROOT, d, 'bot_metadata.json');
                            if (!await fs.pathExists(metaPath)) continue;
                            const meta = await fs.readJson(metaPath).catch(() => null);
                            if (!meta) continue;
                            if (meetingId && (meta.meeting_id === meetingId || meta.meetingId === meetingId || String(meta.meetUrl || meta.meet_url || '').includes(meetingId))) {
                                if (!botMetadata) botMetadata = meta;
                                resolvedUrl = meta.webhookUrl || meta.webhook_url || null;
                                if (resolvedUrl) break;
                            }
                            if (meetingUrl && (String(meta.meetUrl || meta.meet_url || '').includes(meetingUrl) || (meta.meeting_id && meetingUrl.includes(String(meta.meeting_id))))) {
                                if (!botMetadata) botMetadata = meta;
                                resolvedUrl = meta.webhookUrl || meta.webhook_url || null;
                                if (resolvedUrl) break;
                            }
                        } catch (e) { continue; }
                    }
                } catch (e) {}
            }
        }

        // Final fallback to env
        if (!resolvedUrl) resolvedUrl = process.env.WEBHOOK_URL || null;

        if (!resolvedUrl) {
            // nothing to do
            return;
        }

        // Get account email from metadata if available
        let accountEmail = null;
        if (botMetadata) {
            accountEmail = await getAccountEmailFromMetadata(botMetadata);
        }
        // If still no email and no metadata found yet, try to get it from meeting_id or bot_id in data
        if (!accountEmail && data) {
            const candidateId = data.meeting_id || data.meetingId || data.bot_id || data.botId || null;
            if (candidateId) {
                const metadata = await tryMetadataForId(candidateId);
                if (metadata) {
                    accountEmail = await getAccountEmailFromMetadata(metadata);
                }
            }
        }

        // Build payload and make request
        const ts = getCurrentTimestamp ? getCurrentTimestamp() : { iso: new Date().toISOString(), formatted: new Date().toISOString(), timezone: process.env.TIMEZONE || 'UTC' };
        const payload = Object.assign({}, data, {
            timestamp_iso: ts.iso,
            timestamp: ts.formatted,
            timezone: ts.timezone
        });
        
        // Add account email to payload if available
        if (accountEmail) {
            payload.account = accountEmail;
        }
        const postData = JSON.stringify({ event: eventName, data: payload });

        const u = new URL(resolvedUrl);
        const lib = u.protocol === 'https:' ? https : http;

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
            try { req.write(postData); } catch (e) {}
            req.end();
        });

        console.log(`✅ Webhook '${eventName}' sent to ${resolvedUrl}`);
    } catch (err) {
        console.warn(`⚠️ Failed to send webhook '${eventName}': ${err && err.message ? err.message : err}`);
    }
}

module.exports = { sendWebhook };
