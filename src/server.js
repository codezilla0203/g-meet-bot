const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bot } = require('./bot');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
const RUNTIME_DIR = path.join(__dirname, '../runtime/bots');
fs.ensureDirSync(RUNTIME_DIR);
const RUNTIME_ROOT = path.join(__dirname, '../runtime');
fs.ensureDirSync(RUNTIME_ROOT);

// Maximum lifetime for a single bot (minutes). After this TTL the bot is
// force-stopped even if still in a meeting or recording.
const BOT_MAX_LIFETIME_MINUTES = Number(process.env.BOT_MAX_LIFETIME_MINUTES || 90);
const BOT_MAX_LIFETIME_MS = BOT_MAX_LIFETIME_MINUTES * 60 * 1000;
// In-memory storage for active bots
const activeBots = new Map();

// Kill leftover Chrome processes from previous crash/restart
async function cleanupLeftoverBrowsers() {
    try {
        const files = await fs.readdir(RUNTIME_DIR);
        const pidFiles = files.filter(f => f.endsWith('.pid'));
        for (const f of pidFiles) {
            const full = path.join(RUNTIME_DIR, f);
            try {
                const pidStr = await fs.readFile(full, 'utf8');
                const pid = parseInt(pidStr.trim(), 10);
                if (!isNaN(pid)) {
                    try { process.kill(pid, 'SIGTERM'); } catch {}
                    // Give a short moment then force kill if needed
                    await new Promise(r => setTimeout(r, 300));
                    try { process.kill(pid, 'SIGKILL'); } catch {}
                }
            } catch {}
            try { await fs.remove(full); } catch {}
        }
    } catch {}
}

/**
 * SIMPLE LOCAL TESTING API
 * 
 * Endpoints:
 * GET    /health           - Health check
 * POST   /v1/bots          - Create recording bot  
 * GET    /v1/bots          - List all bots
 * GET    /v1/bots/:id      - Get bot status
 * DELETE /v1/bots/:id      - Stop bot
 * GET    /v1/recordings    - List recordings
 * GET    /v1/recordings/:id - Download recording
 */

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeBots: activeBots.size
    });
});

/**
 * Create and start recording bot
 */
app.post('/v1/bots', async (req, res) => {
    try {
        const {
            meeting_url,
            bot_name = "AI Notetaker"
        } = req.body;

        // Validate required fields
        if (!meeting_url) {
            return res.status(400).json({ 
                error: 'meeting_url is required',
                example: {
                    meeting_url: "https://meet.google.com/abc-defg-hij",
                    bot_name: "AI Notetaker",
                    transcription: { enabled: true }
                }
            });
        }

        // Validate meeting URL format
        if (!meeting_url.includes('meet.google.com')) {
            return res.status(400).json({ 
                error: 'Invalid Google Meet URL format',
                expected: 'https://meet.google.com/xxx-xxxx-xxx'
            });
        }

        const botId = uuidv4();
        console.log(`🤖 Creating bot ${botId} for: ${meeting_url}`);

        // Create bot cleanup callback
        const onLeaveCallback = async () => {
            console.log(`🧹 Bot ${botId} finished`);
            const botData = activeBots.get(botId);
            if (botData) {
                botData.status = 'completed';
                botData.endTime = new Date().toISOString();
                if (botData.ttlTimer) {
                    clearTimeout(botData.ttlTimer);
                    botData.ttlTimer = null;
                }
            }

            // If a recording file exists, extract audio to runtime/<botId>/audio
            try {
                const botInstance = botData?.bot;
                if (botInstance && typeof botInstance.getStats === 'function') {
                    const stats = botInstance.getStats();
                    const recordingFile = stats.recordingFile || stats.recordingPath;
                    if (recordingFile) {
                        await extractAudioForBot(botId, recordingFile);
                    }
                }
            } catch (e) {
                console.error(`❌ Error extracting audio for bot ${botId}:`, e && e.message ? e.message : e);
            }

            // Remove bot instance to free memory
            if (activeBots.has(botId)) {
                activeBots.delete(botId);
                console.log(`🗑️  Bot ${botId} removed from active list`);
            }

            // If no active bots remain, just log; keep HTTP server running for future requests
            if (activeBots.size === 0) {
                console.log('📴 No active bots remaining – HTTP server remains running');
            }
        };

        // Create bot
    const bot = new Bot(botId, bot_name, onLeaveCallback);
        
        // Store bot data
        const botData = {
            botId,
            bot,
            meetingUrl: meeting_url,
            botName: bot_name,
            status: 'starting',
            createdAt: new Date().toISOString(),
            outputFile: `${botId}.webm`,
            ttlTimer: null,
        };
        
        activeBots.set(botId, botData);

        // Per-bot hard TTL: force stop after BOT_MAX_LIFETIME_MS even if
        // recording is still in progress. This prevents orphaned bots.
        botData.ttlTimer = setTimeout(async () => {
            try {
                const current = activeBots.get(botId);
                if (!current) return;
                console.log(`⏱️ Bot ${botId} reached TTL of ${BOT_MAX_LIFETIME_MINUTES} minutes, forcing shutdown...`);
                if (current.bot && typeof current.bot.leaveMeet === 'function') {
                    await current.bot.leaveMeet().catch(() => {});
                }
                activeBots.delete(botId);
            } catch (e) {
                console.error(`❌ Error during TTL shutdown for bot ${botId}:`, e);
            }
        }, BOT_MAX_LIFETIME_MS);

        // Start bot (async, don't wait)
        bot.joinMeet(meeting_url)
            .then(() => {
                console.log(`✅ Bot ${botId} started successfully`);
                botData.status = 'recording';
            })
            .catch(async (error) => {
                console.error(`❌ Bot ${botId} failed:`, error.message);
                botData.status = 'failed';
                botData.error = error.message;

                // Ensure we don't leave any Chrome/Playwright processes running
                try {
                    if (bot && typeof bot.leaveMeet === 'function') {
                        await bot.leaveMeet().catch(() => {});
                    }
                } catch {}
            });

        // Return immediate response
        res.json({
            success: true,
            bot_id: botId,
            meeting_url,
            bot_name,
            status: 'starting',
            output_file: `${botId}.webm`,
            created_at: botData.createdAt
        });

    } catch (error) {
        console.error('❌ Failed to create bot:', error);
        res.status(500).json({ 
            error: error.message,
            details: 'Check server logs for more information'
        });
    }
});

/**
 * List all bots
 */
app.get('/v1/bots', (req, res) => {
    const bots = Array.from(activeBots.values()).map(botData => ({
        bot_id: botData.botId,
        meeting_url: botData.meetingUrl,
        bot_name: botData.botName,
        status: botData.status,
        created_at: botData.createdAt,
        end_time: botData.endTime,
        output_file: botData.outputFile,
        error: botData.error,
        stats: botData.bot?.getStats()
    }));

    res.json({
        bots,
        total: bots.length,
        active: bots.filter(b => b.status === 'recording').length,
        completed: bots.filter(b => b.status === 'completed').length,
        failed: bots.filter(b => b.status === 'failed').length
    });
});

/**
 * Get specific bot status
 */
app.get('/v1/bots/:botId', (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);

    if (!botData) {
        return res.status(404).json({ 
            error: 'Bot not found',
            bot_id: botId
        });
    }

    const stats = botData.bot?.getStats() || {};
    
    res.json({
        bot_id: botId,
        meeting_url: botData.meetingUrl,
        bot_name: botData.botName,
        status: botData.status,
        created_at: botData.createdAt,
        end_time: botData.endTime,
        output_file: botData.outputFile,
        error: botData.error,
        stats
    });
});

/**
 * Participants diagnostics for a bot
 */
app.get('/v1/bots/:botId/participants', async (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);
    if (!botData) {
        return res.status(404).json({ error: 'Bot not found', bot_id: botId });
    }
    try {
        const diag = await botData.bot.getParticipantsDiagnostics();
        res.json({ bot_id: botId, ...diag });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Stop and remove bot
 */
app.delete('/v1/bots/:botId', async (req, res) => {
    const { botId } = req.params;
    const botData = activeBots.get(botId);

    if (!botData) {
        return res.status(404).json({ 
            error: 'Bot not found',
            bot_id: botId
        });
    }

    try {
        console.log(`🛑 Stopping bot ${botId}...`);

        if (botData.ttlTimer) {
            clearTimeout(botData.ttlTimer);
            botData.ttlTimer = null;
        }

        if (botData.bot && botData.status === 'recording') {
            await botData.bot.leaveMeet();
        }

        // Ensure cleanup
        activeBots.delete(botId);

        res.json({
            success: true,
            message: `Bot ${botId} stopped and removed`,
            bot_id: botId,
            status: 'stopped'
        });

    } catch (error) {
        console.error(`❌ Error stopping bot ${botId}:`, error);
        res.status(500).json({ 
            error: error.message,
            bot_id: botId
        });
    }
});

/**
 * List all recordings
 */
app.get('/v1/recordings', async (req, res) => {
    try {
        const recordings = [];
        // Look for recordings saved under runtime/<botId>/video/*.webm
        try {
            const botDirs = await fs.readdir(RUNTIME_ROOT);
            for (const d of botDirs) {
                const botDir = path.join(RUNTIME_ROOT, d);
                // Only consider directories that look like bot folders (skip 'bots' dir)
                const stat = await fs.stat(botDir).catch(() => null);
                if (!stat || !stat.isDirectory()) continue;
                if (d === 'bots') continue;

                const videoDir = path.join(botDir, 'video');
                if (!(await fs.pathExists(videoDir))) continue;

                const files = await fs.readdir(videoDir).catch(() => []);
                const webmFiles = files.filter(f => f.endsWith('.webm'));
                for (const file of webmFiles) {
                    try {
                        const fullPath = path.join(videoDir, file);
                        const stats = await fs.stat(fullPath);
                        const botId = d;
                        const botData = activeBots.get(botId);

                        recordings.push({
                            recording_id: botId,
                            filename: path.join('runtime', botId, 'video', file),
                            size: stats.size,
                            size_mb: (stats.size / 1024 / 1024).toFixed(2),
                            created_at: stats.birthtime.toISOString(),
                            modified_at: stats.mtime.toISOString(),
                            bot_name: botData?.botName || 'Unknown',
                            meeting_url: botData?.meetingUrl || 'Unknown'
                        });
                    } catch (e) {
                        console.warn(`Warning: Could not get stats for ${file} in ${videoDir}`);
                    }
                }
            }
        } catch (e) {
            console.warn('Warning: could not scan runtime recordings:', e && e.message ? e.message : e);
        }
        
        // Sort by creation time (newest first)
        recordings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        res.json({
            recordings,
            total: recordings.length,
            total_size_mb: recordings.reduce((sum, r) => sum + parseFloat(r.size_mb), 0).toFixed(2)
        });
        
    } catch (error) {
        console.error('❌ Error listing recordings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Download recording
 */
app.get('/v1/recordings/:recordingId', async (req, res) => {
    const { recordingId } = req.params;
    try {
        const contentType = 'video/webm';

        // Primary: look under runtime/<botId>/video/<botId>.webm
        const candidate = path.join(RUNTIME_ROOT, recordingId, 'video', `${recordingId}.webm`);
        if (await fs.pathExists(candidate)) {
            const stats = await fs.stat(candidate);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', stats.size);
            res.setHeader('Content-Disposition', `attachment; filename="${recordingId}.webm"`);
            const stream = fs.createReadStream(candidate);
            return stream.pipe(res);
        }

        // Fallback: check root (legacy)
        const legacy = `${recordingId}.webm`;
        if (await fs.pathExists(legacy)) {
            const stats = await fs.stat(legacy);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', stats.size);
            res.setHeader('Content-Disposition', `attachment; filename="${recordingId}.webm"`);
            const stream = fs.createReadStream(legacy);
            return stream.pipe(res);
        }

        return res.status(404).json({ 
            error: 'Recording not found',
            recording_id: recordingId,
            attempted_paths: [candidate, legacy]
        });
    } catch (error) {
        console.error(`❌ Error downloading ${req.params.recordingId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get live captions for a bot
 */
app.get('/v1/transcripts/:botId', async (req, res) => {
    const { botId } = req.params;
    try {
        const botRootDir = path.join(RUNTIME_ROOT, botId);
        const captionsPath = path.join(botRootDir, 'transcripts', 'captions.json');

        let captions = null;

        if (await fs.pathExists(captionsPath)) {
            try {
                const raw = await fs.readFile(captionsPath, 'utf8');
                captions = JSON.parse(raw);
            } catch {}
        }

        res.json({
            bot_id: botId,
            captions,
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get environment info
 */
app.get('/v1/info', (req, res) => {
    res.json({
        server: 'Google Meet Recording Bot API',
        version: '1.0.0',
        features: {
            webrtc_recording: true,
                webhooks: false,
                ws_audio_streaming: false,
                server_side_asr: false,
                sse_monitoring: false
        },
        environment: {
            node_version: process.version,
            port: PORT
        },
        endpoints: {
            'POST /v1/bots': 'Create recording bot',
            'GET /v1/bots': 'List all bots',
            'GET /v1/bots/:id': 'Get bot status',
            'DELETE /v1/bots/:id': 'Stop bot',
            'GET /v1/recordings': 'List recordings',
            'GET /v1/recordings/:id': 'Download recording',
            'GET /v1/transcripts/:id': 'Get live captions for a bot',
            'GET /v1/bots/:id/participants': 'Diagnostics for participant counting'
        }
    });
});

/**
 * Download extracted audio (WAV) for a bot
 */
app.head('/v1/bots/:botId/audio', async (req, res) => {
    const { botId } = req.params;
    try {
        const audioPath = path.join(RUNTIME_ROOT, botId, 'audio', `${botId}.wav`);
        if (!(await fs.pathExists(audioPath))) {
            return res.status(404).end();
        }
        const stats = await fs.stat(audioPath);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', stats.size);
        res.status(200).end();
    } catch (error) {
        res.status(500).end();
    }
});

app.get('/v1/bots/:botId/audio', async (req, res) => {
    const { botId } = req.params;
    try {
        const audioPath = path.join(RUNTIME_ROOT, botId, 'audio', `${botId}.wav`);
        if (!(await fs.pathExists(audioPath))) {
            return res.status(404).json({
                error: 'Audio not found',
                bot_id: botId
            });
        }
        const stats = await fs.stat(audioPath);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', `attachment; filename="${botId}.wav"`);
        const stream = fs.createReadStream(audioPath);
        stream.pipe(res);
    } catch (error) {
        console.error(`❌ Error streaming audio for bot ${botId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        available_endpoints: [
            'GET /health',
            'GET /v1/info', 
            'POST /v1/bots',
            'GET /v1/bots',
            'GET /v1/bots/:id',
            'DELETE /v1/bots/:id',
            'GET /v1/recordings',
            'GET /v1/recordings/:id'
        ]
    });
});

// Start server (only when run directly). This allows tests to require the app
// without starting a listener and prevents EADDRINUSE during automated tests.
let server = null;
if (require.main === module) {
    server = app.listen(PORT, () => {
        console.log(`🚀 Google Meet Recording Bot API`);
        console.log(`📡 Server running on http://localhost:${PORT}`);
        
        console.log(``);
        console.log(`📖 API Endpoints:`);
        console.log(`   Health Check: http://localhost:${PORT}/health`);
        console.log(`   API Info:     http://localhost:${PORT}/v1/info`);
        console.log(``);
        console.log(`🤖 Test Bot Creation (PowerShell):`);
        console.log(`   See examples/test.py or use test-api.json file`);

        // On startup, attempt to clean up any leftover Chrome processes
        cleanupLeftoverBrowsers()
            .then(() => console.log('🧹 Startup cleanup of leftover Chrome processes completed'))
            .catch(() => console.warn('⚠️ Startup cleanup encountered issues'));
    });
}

// Graceful shutdown to avoid orphaned browsers/bots on restarts
let serverClosePromise = null;
async function gracefulShutdown(reason = 'shutdown') {
    try {
        console.log(`\n⚙️  Initiating graceful shutdown due to: ${reason}`);
        // Ask all active bots to leave meetings
        const shutdownPromises = [];
        for (const [botId, botData] of activeBots.entries()) {
            try {
                console.log(`🛑 Requesting bot ${botId} to leave...`);
                if (botData?.bot?.leaveMeet) {
                    shutdownPromises.push(botData.bot.leaveMeet().catch(()=>{}));
                }
            } catch {}
        }
        await Promise.allSettled(shutdownPromises);
    } catch {}
    // Close HTTP server once (if it exists)
    try {
        if (server) {
            if (!serverClosePromise) {
                serverClosePromise = new Promise(resolve => server.close(resolve));
            }
            await serverClosePromise;
            console.log('✅ HTTP server closed');
        }
    } catch (e) {
        console.warn('⚠️ Error closing HTTP server:', e && e.message ? e.message : e);
    }
}

process.once('SIGINT', () => {
    gracefulShutdown('SIGINT (Ctrl+C)').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
    gracefulShutdown('SIGTERM').finally(() => process.exit(0));
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err);
    gracefulShutdown('uncaughtException').finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
    gracefulShutdown('unhandledRejection').finally(() => process.exit(1));
});

module.exports = app;

/**
 * Extract audio from a recorded WebM/MP4 file into a WAV file.
 * Audio is saved under runtime/<botId>/audio/<botId>.wav
 */
async function extractAudioForBot(botId, recordingFile) {
    try {
        const botDir = path.join(RUNTIME_ROOT, botId);
        const audioDir = path.join(botDir, 'audio');
        fs.ensureDirSync(audioDir);

        const audioPath = path.join(audioDir, `${botId}.wav`);
        console.log(`🎧 Bot ${botId}: extracting audio to ${audioPath}...`);
        await extractAudioWithFfmpeg(recordingFile, audioPath);
        console.log(`✅ Bot ${botId}: audio saved to ${audioPath}`);
    } catch (e) {
        console.error(`❌ Bot ${botId}: audio extraction error`, e && e.message ? e.message : e);
    }
}

function extractAudioWithFfmpeg(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-i', inputPath,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            outputPath,
        ]);

        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.toLowerCase().includes('error')) {
                console.error(`ffmpeg: ${msg.trim()}`);
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });
    });
}
