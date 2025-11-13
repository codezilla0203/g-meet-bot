const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bot } = require('./bot');
const path = require('path');
const fs = require('fs-extra');
const { WebSocketServer } = require('ws');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
app.use(express.json());
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
const RUNTIME_DIR = path.join(__dirname, '../runtime/bots');
fs.ensureDirSync(RUNTIME_DIR);
const TRANSCRIPTS_DIR = path.join(__dirname, '../runtime/transcripts');
const AUDIO_DIR = path.join(__dirname, '../runtime/audio');
fs.ensureDirSync(TRANSCRIPTS_DIR);
fs.ensureDirSync(AUDIO_DIR);

// In-memory storage for active bots
const activeBots = new Map();
const transcripts = new Map(); // botId -> { segments: [], partial: '' }
const monitors = new Map();    // botId -> Set<SSE response>

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

function getTranscriptState(botId) {
    if (!transcripts.has(botId)) transcripts.set(botId, { segments: [], partial: '', updatedAt: Date.now() });
    return transcripts.get(botId);
}

function appendTranscript(botId, segment) {
    const state = getTranscriptState(botId);
    state.segments.push(segment);
    state.updatedAt = Date.now();
    // Persist JSONL line and plain text
    const jsonlPath = path.join(TRANSCRIPTS_DIR, `${botId}.jsonl`);
    const txtPath = path.join(TRANSCRIPTS_DIR, `${botId}.txt`);
    try {
        fs.appendFileSync(jsonlPath, JSON.stringify(segment) + '\n');
        if (segment.text) fs.appendFileSync(txtPath, segment.text + '\n');
    } catch {}
    // Fan-out to SSE monitors
    broadcastMonitor(botId, 'caption', segment);
}

function broadcastMonitor(botId, event, data) {
    const subs = monitors.get(botId);
    if (!subs || subs.size === 0) return;
    const payload = `event: ${event}\n` + `data: ${JSON.stringify({ botId, ...data })}\n\n`;
    for (const res of subs) {
        try { res.write(payload); } catch {}
    }
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
        const onLeaveCallback = () => {
            console.log(`🧹 Bot ${botId} finished`);
            const botData = activeBots.get(botId);
            if (botData) {
                botData.status = 'completed';
                botData.endTime = new Date().toISOString();
            }
            // Remove bot instance to free memory
            if (activeBots.has(botId)) {
                activeBots.delete(botId);
                console.log(`🗑️  Bot ${botId} removed from active list`);
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
            outputFile: `${botId}.webm`
        };
        
        activeBots.set(botId, botData);

        // Start bot (async, don't wait)
        bot.joinMeet(meeting_url)
            .then(() => {
                console.log(`✅ Bot ${botId} started successfully`);
                botData.status = 'recording';
            })
            .catch(error => {
                console.error(`❌ Bot ${botId} failed:`, error.message);
                botData.status = 'failed';
                botData.error = error.message;
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
        
        // Get all .webm files in current directory
        const files = await fs.readdir('.');
        const webmFiles = files.filter(file => file.endsWith('.webm'));
        
        for (const file of webmFiles) {
            try {
                const stats = await fs.stat(file);
                const botId = file.replace('.webm', '');
                const botData = activeBots.get(botId);
                
                recordings.push({
                    recording_id: botId,
                    filename: file,
                    size: stats.size,
                    size_mb: (stats.size / 1024 / 1024).toFixed(2),
                    created_at: stats.birthtime.toISOString(),
                    modified_at: stats.mtime.toISOString(),
                    bot_name: botData?.botName || 'Unknown',
                    meeting_url: botData?.meetingUrl || 'Unknown'
                });
            } catch (e) {
                console.warn(`Warning: Could not get stats for ${file}`);
            }
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
 * Download recording or transcript
 */
app.get('/v1/recordings/:recordingId', async (req, res) => {
    const { recordingId } = req.params;
    try {
        const filename = `${recordingId}.webm`;
        const contentType = 'video/webm';
        if (!(await fs.pathExists(filename))) {
            return res.status(404).json({ 
                error: 'Recording not found',
                recording_id: recordingId,
                filename
            });
        }
        const stats = await fs.stat(filename);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        const stream = fs.createReadStream(filename);
        stream.pipe(res);
    } catch (error) {
        console.error(`❌ Error downloading ${req.params.recordingId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get combined transcript for a bot (captions + ASR if available)
 */
app.get('/v1/transcripts/:botId', async (req, res) => {
    const { botId } = req.params;
    try {
        const state = getTranscriptState(botId);
        const jsonlPath = path.join(TRANSCRIPTS_DIR, `${botId}.jsonl`);
        let fileSegments = [];
        if (await fs.pathExists(jsonlPath)) {
            try {
                const lines = (await fs.readFile(jsonlPath, 'utf8')).split(/\r?\n/).filter(Boolean);
                fileSegments = lines.map(l => JSON.parse(l));
            } catch {}
        }
        // Merge in-memory (latest) with file-backed history
        const combined = fileSegments.concat(state.segments.slice(fileSegments.length));
        res.json({
            bot_id: botId,
            segments: combined,
            partial: state.partial || '',
            updated_at: new Date(state.updatedAt || Date.now()).toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Real-time monitoring via Server-Sent Events (SSE)
 * Streams caption events and audio-level metrics as they arrive.
 */
app.get('/v1/stream/:botId', (req, res) => {
    const { botId } = req.params;
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    // Register subscriber
    if (!monitors.has(botId)) monitors.set(botId, new Set());
    const set = monitors.get(botId);
    set.add(res);

    // Send a hello and latest partial
    const state = getTranscriptState(botId);
    try { res.write(`event: hello\n` + `data: ${JSON.stringify({ botId, partial: state.partial || '', segments: state.segments.length })}\n\n`); } catch {}

    // Heartbeat to keep connection alive
    const iv = setInterval(() => {
        try { res.write(`event: ping\n` + `data: ${Date.now()}\n\n`); } catch {}
    }, 15000);

    req.on('close', () => {
        clearInterval(iv);
        const s = monitors.get(botId);
        if (s) s.delete(res);
    });
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
            ws_audio_streaming: true,
            server_side_asr: false,
            sse_monitoring: true
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
            'GET /v1/transcripts/:id': 'Get combined captions transcript for a bot',
            'GET /v1/bots/:id/participants': 'Diagnostics for participant counting',
            'GET /v1/stream/:id': 'SSE real-time captions and audio level'
        }
    });
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

// Start server
const server = app.listen(PORT, () => {
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

// Attach WebSocket server for audio/captions streaming
const wss = new WebSocketServer({ server, path: '/ws/stream' });
wss.on('connection', async (ws) => {
    let botId = null;
    let audioStream = null; // Write raw incoming audio if desired

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'hello') {
                botId = msg.botId || `ws_${Date.now()}`;
                if (!audioStream) {
                    try {
                        const fpath = path.join(AUDIO_DIR, `${botId}.f32le`);
                        audioStream = fs.createWriteStream(fpath, { flags: 'a' });
                    } catch {}
                }
                // Initialize transcript state
                getTranscriptState(botId);
                return;
            }

            if (!botId) return; // ignore until hello

            if (msg.type === 'audio' && msg.encoding === 'f32le') {
                const chunk = Buffer.from(msg.chunk, 'base64');
                // Optionally store original raw audio
                try { audioStream?.write(chunk); } catch {}
                // No audio forwarding to frontend (UI is captions-only)
                return;
            }

            if (msg.type === 'caption') {
                appendTranscript(botId, { type: 'caption', text: msg.text, speaker: msg.speaker, lang: msg.lang, ts: msg.ts || Date.now() });
                // Forward final caption to clients and SSE
                const payload = { type: 'caption_final', text: msg.text, speaker: msg.speaker, ts: msg.ts || Date.now() };
                broadcastMonitor(botId, 'caption_final', payload);
                broadcastClient(botId, { botId, ...payload });
                return;
            }

            if (msg.type === 'caption_update') {
                // Pending replacement from bot
                const payload = {
                    type: 'caption_update',
                    speaker: msg.speaker || '',
                    utteranceId: msg.utteranceId || '',
                    text: msg.text || '',
                    prevText: msg.prevText || '',
                    ts: msg.ts || Date.now()
                };
                broadcastMonitor(botId, 'caption_update', payload);
                broadcastClient(botId, { botId, ...payload });
                return;
            }

            if (msg.type === 'caption_final') {
                const payload = {
                    type: 'caption_final',
                    speaker: msg.speaker || '',
                    utteranceId: msg.utteranceId || '',
                    text: msg.text || '',
                    ts: msg.ts || Date.now()
                };
                // Persist final caption as transcript segment
                appendTranscript(botId, { type: 'caption', text: payload.text, speaker: payload.speaker, ts: payload.ts });
                broadcastMonitor(botId, 'caption_final', payload);
                broadcastClient(botId, { botId, ...payload });
                return;
            }
        } catch (e) {
            // ignore bad messages
        }
    });

    ws.on('close', () => {
        try { audioStream?.close(); } catch {}
    });
});

// Frontend clients (browsers) subscribe here to get audio + caption updates
const clientRooms = new Map(); // botId -> Set<ws>
function getRoom(botId) {
    if (!clientRooms.has(botId)) clientRooms.set(botId, new Set());
    return clientRooms.get(botId);
}
function broadcastClient(botId, messageObject) {
    const room = clientRooms.get(botId);
    if (!room || room.size === 0) return;
    const data = JSON.stringify(messageObject);
    for (const sock of room) {
        try { sock.send(data); } catch {}
    }
}
const wssClient = new WebSocketServer({ server, path: '/ws/client' });
wssClient.on('connection', (ws, req) => {
    // Parse botId from query string ?botId=...
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const botId = url.searchParams.get('botId');
        if (!botId) {
            try { ws.close(); } catch {}
            return;
        }
        console.log(`📡 Client WS connected for bot ${botId} from ${req.socket.remoteAddress}`);
        const room = getRoom(botId);
        room.add(ws);
        // Hello message
        try { ws.send(JSON.stringify({ type: 'hello', botId, ts: Date.now() })); } catch {}
        // Keepalive ping
        const pingIv = setInterval(() => {
            try { ws.ping(); } catch {}
        }, 15000);
        ws.on('close', () => {
            const r = clientRooms.get(botId);
            if (r) r.delete(ws);
            clearInterval(pingIv);
            console.log(`📴 Client WS disconnected for bot ${botId}`);
        });
    } catch {
        try { ws.close(); } catch {}
    }
});

// Graceful shutdown to avoid orphaned browsers/bots on restarts
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
    // Close HTTP server
    try {
        await new Promise(resolve => server.close(resolve));
        console.log('✅ HTTP server closed');
    } catch {}
}

process.on('SIGINT', () => {
    gracefulShutdown('SIGINT (Ctrl+C)').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
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
