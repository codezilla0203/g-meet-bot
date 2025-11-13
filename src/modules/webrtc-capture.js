/**
 * WebRTC Direct Stream Capture (Recall.ai style)
 *
 * Adds two capture modes:
 * 1) Container capture via MediaRecorder (.webm)
 * 2) Raw capture for audio (F32LE) and video (I420) with low FPS for feasibility
 *
 * Notes:
 * - Raw video at high resolution and FPS is heavy to shuttle over DevTools.
 *   We limit FPS and provide a working baseline; for production scale, switch
 *   to a websocket bridge for binary streaming.
 */

const fs = require('fs-extra');
const path = require('path');

class WebRTCCapture {
    constructor(botId, page) {
        this.botId = botId;
        this.page = page;
        this.isCapturing = false;
        this.isTabCapturing = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.outputPath = null;
        this.transcriptionCallback = null;

        // Raw outputs
        this.rawAudioPath = null;
        this.rawVideoPath = null;
        this.rawAudioStream = null;
        this.rawVideoStream = null;
        this.rawMetaPath = null;
        this.rawConfig = null;

        // Optional forwarders for real-time streaming
        this.audioForwarder = null; // function(buffer, sampleRate)

        // Epoch ms when raw audio capture began (approximate alignment for captions)
        this.audioStartEpochMs = null;
    }

    setAudioForwarder(fn) {
        this.audioForwarder = typeof fn === 'function' ? fn : null;
    }

    async injectWebRTCInterceptor() {
        console.log(`[${this.botId}] 🔌 Injecting WebRTC interceptor...`);

        await this.page.evaluateOnNewDocument(() => {
            const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            const OriginalRTCPeerConnection = window.RTCPeerConnection;

            window.__meetingStreams = [];
            window.__meetingTracks = [];
            // Admission state flag set by controller after actual admission
            window.__admittedSettle = false;
            window.__resetMeetingState = () => {
                try {
                    window.__meetingStreams = [];
                    window.__meetingTracks = [];
                    if (window.__remoteParticipants && window.__remoteParticipants.clear) window.__remoteParticipants.clear();
                } catch {}
            };
            // Map of remote streamId -> { id, tracks:Set(trackId), kinds:Set(kind), lastSeen }
            window.__remoteParticipants = new Map();
            // Prune function removes participants whose tracks ended or stale >2 min
            window.__pruneParticipants = () => {
                try {
                    const now = Date.now();
                    const tracks = (window.__meetingTracks || []).filter(t => t.type === 'remote');
                    const liveTrackIds = new Set(tracks.filter(t => t.track && t.track.readyState === 'live').map(t => t.track.id));
                    window.__remoteParticipants.forEach((entry, key) => {
                        // Remove ended tracks from entry
                        entry.tracks.forEach(tid => { if (!liveTrackIds.has(tid)) entry.tracks.delete(tid); });
                        // If no live tracks or stale lastSeen -> delete
                        if (entry.tracks.size === 0 || (now - entry.lastSeen > 2 * 60 * 1000)) {
                            window.__remoteParticipants.delete(key);
                        }
                    });
                } catch (e) {
                    // silent
                }
            };
            // Periodic pruning interval
            window.__participantPruneInterval = setInterval(window.__pruneParticipants, 5000);

            navigator.mediaDevices.getUserMedia = async function(constraints) {
                const stream = await originalGetUserMedia(constraints);
                window.__meetingStreams.push(stream);
                stream.getTracks().forEach(track => {
                    try { console.log(`[WebRTC] Local ${track.kind} track: ${track.label}`); } catch {}
                    window.__meetingTracks.push({ track, type: 'local', kind: track.kind });
                });
                return stream;
            };

            // Wrap RTCPeerConnection to ensure we always intercept 'track' even if page overwrites handlers later
            window.RTCPeerConnection = function(config) {
                const pc = new OriginalRTCPeerConnection(config);

                const trackHandler = (event) => {
                    try { console.log(`[WebRTC] Remote ${event.track.kind} track received`); } catch {}
                    window.__meetingTracks.push({ track: event.track, type: 'remote', kind: event.track.kind });
                    if (event.streams && event.streams.length) {
                        event.streams.forEach(s => {
                            window.__meetingStreams.push(s);
                            try {
                                let entry = window.__remoteParticipants.get(s.id);
                                if (!entry) {
                                    entry = { id: s.id, tracks: new Set(), kinds: new Set(), lastSeen: Date.now() };
                                    window.__remoteParticipants.set(s.id, entry);
                                }
                                entry.lastSeen = Date.now();
                                entry.tracks.add(event.track.id);
                                entry.kinds.add(event.track.kind);
                            } catch {}
                        });
                    } else {
                        // Fallback: streamless track (rare). Use track.id as synthetic participant.
                        try {
                            let entry = window.__remoteParticipants.get(event.track.id);
                            if (!entry) entry = { id: event.track.id, tracks: new Set(), kinds: new Set(), lastSeen: Date.now(), synthetic: true };
                            entry.lastSeen = Date.now();
                            entry.tracks.add(event.track.id);
                            entry.kinds.add(event.track.kind);
                            window.__remoteParticipants.set(event.track.id, entry);
                        } catch {}
                    }
                    try {
                        event.track.addEventListener('ended', () => {
                            try { window.__meetingTracks = (window.__meetingTracks || []).filter(t => t.track !== event.track); } catch {}
                            // Update participant entry removing track
                            try {
                                (event.streams || []).forEach(s => {
                                    const p = window.__remoteParticipants.get(s.id);
                                    if (p) {
                                        p.tracks.delete(event.track.id);
                                        if (p.tracks.size === 0) {
                                            window.__remoteParticipants.delete(s.id);
                                        }
                                    }
                                });
                                window.__pruneParticipants();
                            } catch {}
                        });
                        // Listen for removetrack on each stream
                        (event.streams || []).forEach(s => {
                            try {
                                s.addEventListener('removetrack', (rtEvent) => {
                                    try {
                                        const p = window.__remoteParticipants.get(s.id);
                                        if (p) {
                                            p.tracks.delete(rtEvent.track.id);
                                            if (p.tracks.size === 0) window.__remoteParticipants.delete(s.id);
                                        }
                                        window.__pruneParticipants();
                                    } catch {}
                                });
                            } catch {}
                        });
                    } catch {}
                };
                pc.addEventListener('track', trackHandler);

                // Monkey patch addEventListener so any future 'track' listeners still keep ours
                const originalAddEventListener = pc.addEventListener.bind(pc);
                pc.addEventListener = function(type, listener, options) {
                    if (type === 'track' && typeof listener === 'function') {
                        // Wrap the provided listener to ensure trackHandler ran first
                        const wrapped = (e) => { trackHandler(e); listener(e); };
                        return originalAddEventListener(type, wrapped, options);
                    }
                    return originalAddEventListener(type, listener, options);
                };

                // Also patch ontrack property setter
                Object.defineProperty(pc, 'ontrack', {
                    set(fn) {
                        originalAddEventListener('track', (e) => { trackHandler(e); fn && fn(e); });
                    },
                    get() { return undefined; }
                });

                return pc;
            };
            window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
        });
    }

    // ============ Container capture (.webm) ============
    async startContainerCapture(outputPath, { remoteOnly = true, mixAllParticipants = true, width = 1280, height = 720, fps = 15 } = {}) {
        console.log(`[${this.botId}] 🎬 Starting container capture (.webm)...`);
        this.outputPath = outputPath;
        this.recordedChunks = [];

        try {
            await this.page.waitForTimeout(2000);

            await this.page.evaluate((remoteOnlyFlag, mix, W, H, fpsVal) => {
                // NOTE: This uses pure WebRTC primitives (remote MediaStreamTracks intercepted via RTCPeerConnection 'track' events),
                // not a tab screenshot. The resulting MediaRecorder output is built from the actual decoded audio/video tracks
                // supplied by Google Meet after admission. If you need full tab UI (chat, overlays), implement a separate tab
                // screencast pipeline (CDP Page.startScreencast) and mux audio from these tracks.
                // Build combined stream
                const audioTracks = (window.__meetingTracks || [])
                    .filter(t => t.kind === 'audio' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                    .map(t => t.track);
                const videoTracks = (window.__meetingTracks || [])
                    .filter(t => t.kind === 'video' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                    .map(t => t.track);

                let combinedStream = new MediaStream();

                // ---- Audio Mix: mix all remote audio into one track ----
                if (audioTracks.length > 0) {
                    try {
                        const ac = new (window.AudioContext || window.webkitAudioContext)();
                        const dest = ac.createMediaStreamDestination();
                        const connected = new Set();
                        const connectTrack = (tr) => {
                            try {
                                const ms = new MediaStream([tr]);
                                const src = new MediaStreamAudioSourceNode(ac, { mediaStream: ms });
                                const gain = ac.createGain();
                                gain.gain.value = 1.0 / Math.max(1, audioTracks.length); // simple normalization
                                src.connect(gain).connect(dest);
                                connected.add(tr.id);
                            } catch(e) { console.warn('[Mix] audio source error', e); }
                        };
                        audioTracks.forEach(connectTrack);
                        // Periodically attach new audio tracks that appear later
                        window.__mixAudioInterval = setInterval(() => {
                            try {
                                const newAudio = (window.__meetingTracks || [])
                                  .filter(t => t.kind === 'audio' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                                  .map(t => t.track)
                                  .filter(tr => !connected.has(tr.id));
                                newAudio.forEach(connectTrack);
                            } catch {}
                        }, 2000);
                        const mixedAudio = dest.stream.getAudioTracks()[0];
                        if (mixedAudio) combinedStream.addTrack(mixedAudio);
                        window.__mixAudioCtx = ac;
                        // Keep AudioContext running in background
                        window.__mixAudioKeepAlive = setInterval(() => {
                            try { if (ac.state !== 'running') ac.resume(); } catch {}
                        }, 1500);
                    } catch (e) {
                        console.warn('[Mix] Audio mix failed, falling back to first audio track', e);
                        if (audioTracks[0]) combinedStream.addTrack(audioTracks[0]);
                    }
                }

                // ---- Video Mix: draw all remote videos onto one canvas grid ----
                if (mix && videoTracks.length > 0) {
                    const canvas = document.createElement('canvas');
                    canvas.width = W; canvas.height = H; canvas.style.display = 'none';
                    document.body.appendChild(canvas);
                    const ctx = canvas.getContext('2d', { alpha: false });

                    // Hidden container to help autoplay on some policies
                    let holder = document.getElementById('__mixHolder');
                    if (!holder) {
                        holder = document.createElement('div');
                        holder.id='__mixHolder';
                        holder.style.cssText='position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;';
                        document.body.appendChild(holder);
                    }

                    const videos = [];
                    const attached = new Set();
                    const attachVideo = async (tr) => {
                        if (attached.has(tr.id)) return;
                        attached.add(tr.id);
                        const v = document.createElement('video');
                        v.muted = true; v.playsInline = true; v.autoplay = true;
                        v.srcObject = new MediaStream([tr]);
                        holder.appendChild(v);
                        try { await v.play(); } catch(e) { /* autoplay policy mitigated by flags + muted */ }
                        videos.push(v);
                    };
                    videoTracks.forEach(tr => attachVideo(tr));

                    // Periodically add new remote video tracks to the grid
                    window.__mixVideoInterval = setInterval(() => {
                        try {
                            const current = (window.__meetingTracks || [])
                              .filter(t => t.kind === 'video' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                              .map(t => t.track);
                            current.forEach(tr => attachVideo(tr));
                        } catch {}
                    }, 2000);

                    // Compute grid
                    const n = videos.length;
                    const cols = Math.ceil(Math.sqrt(n));
                    const rows = Math.ceil(n / cols);
                    const cellW = Math.floor(W / cols);
                    const cellH = Math.floor(H / rows);

                    let stop = false;
                    window.__mixStop = () => { stop = true; };

                    const draw = () => {
                        if (stop) return;
                        ctx.fillStyle = '#000';
                        ctx.fillRect(0, 0, W, H);
                        // Include audio-only participants as placeholders
                        let audioOnlyCount = 0;
                        try {
                            if (window.__remoteParticipants instanceof Map) {
                                window.__remoteParticipants.forEach(p => {
                                    const hasVideo = p.kinds && p.kinds.has('video');
                                    const hasAudio = p.kinds && p.kinds.has('audio');
                                    if (hasAudio && !hasVideo) audioOnlyCount++;
                                });
                            }
                        } catch {}
                        const vn = videos.length + audioOnlyCount;
                        const cols2 = Math.ceil(Math.sqrt(vn));
                        const rows2 = Math.ceil(vn / cols2);
                        const cellW2 = Math.floor(W / cols2);
                        const cellH2 = Math.floor(H / rows2);
                        for (let i = 0; i < vn; i++) {
                            const r = Math.floor(i / cols2);
                            const c = i % cols2;
                            const x = c * cellW2; const y = r * cellH2;
                            if (i < videos.length) {
                                const v = videos[i];
                                try { ctx.drawImage(v, x, y, cellW2, cellH2); } catch {}
                            } else {
                                // Draw placeholder for audio-only participant
                                ctx.fillStyle = '#222';
                                ctx.fillRect(x+2, y+2, cellW2-4, cellH2-4);
                                ctx.fillStyle = '#0bf';
                                ctx.font = Math.floor(cellH2 * 0.12) + 'px sans-serif';
                                ctx.textAlign = 'center';
                                ctx.fillText('Audio only', x + cellW2/2, y + cellH2/2);
                            }
                        }
                        // use setTimeout for simple FPS control
                        setTimeout(() => requestAnimationFrame(draw), 1000/Math.max(1, fpsVal));
                    };
                    requestAnimationFrame(draw);

                    const mixedVideo = canvas.captureStream(Math.max(1, fpsVal)).getVideoTracks()[0];
                    if (mixedVideo) combinedStream.addTrack(mixedVideo);
                    window.__mixCanvas = canvas;
                } else {
                    // Fallback: single video track (first)
                    if (videoTracks[0]) combinedStream.addTrack(videoTracks[0]);
                }

                // Pick supported mime type
                const tryTypes = [
                    'video/webm;codecs=vp9,opus',
                    'video/webm;codecs=vp8,opus',
                    'video/webm'
                ];
                let chosen = tryTypes.find(t => (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)));
                if (!chosen) chosen = 'video/webm';
                const options = { mimeType: chosen, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
                window.__mediaRecorder = new MediaRecorder(combinedStream, options);
                window.__recordedChunks = [];

                window.__mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) window.__recordedChunks.push(e.data);
                };
                window.__mediaRecorder.onstop = () => {
                    const blob = new Blob(window.__recordedChunks, { type: 'video/webm' });
                    window.__finalRecording = blob;
                    try { if (window.__mixStop) window.__mixStop(); } catch {}
                    try { if (window.__mixCanvas && window.__mixCanvas.parentNode) window.__mixCanvas.parentNode.removeChild(window.__mixCanvas); } catch {}
                    try { if (window.__mixAudioCtx) window.__mixAudioCtx.close(); } catch {}
                    try { clearInterval(window.__mixAudioInterval); } catch {}
                    try { clearInterval(window.__mixVideoInterval); } catch {}
                    try { clearInterval(window.__mixAudioKeepAlive); } catch {}
                };
                window.__mediaRecorder.start(1000);
            }, remoteOnly, mixAllParticipants, width, height, fps);

            this.isCapturing = true;
        } catch (err) {
            console.error(`[${this.botId}] ❌ Failed to start container capture:`, err);
            throw err;
        }
    }

    async stopContainerCapture() {
        try {
            await this.page.evaluate(() => {
                if (window.__mediaRecorder && window.__mediaRecorder.state === 'recording') {
                    window.__mediaRecorder.stop();
                }
            });
            await this.page.waitForTimeout(1500);
            const bytes = await this.page.evaluate(async () => {
                if (!window.__finalRecording) return null;
                const buf = await window.__finalRecording.arrayBuffer();
                return Array.from(new Uint8Array(buf));
            });
            if (bytes) {
                const buffer = Buffer.from(bytes);
                await fs.writeFile(this.outputPath, buffer);
                console.log(`[${this.botId}] ✅ Saved ${this.outputPath} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
            }
        } catch (e) {
            console.warn(`[${this.botId}] ⚠️ stopContainerCapture error: ${e.message}`);
        }
    }

    // ============ Raw capture (audio: F32LE, video: I420) ============
    async startRawCapture({ audioPath, videoPath, sampleRate = 48000, fps = 5, maxWidth = 640, maxHeight = 360, remoteOnly = true } = {}) {
        console.log(`[${this.botId}] 📼 Starting raw capture (audio F32LE, video I420)...`);
        this.rawAudioPath = audioPath || `${this.botId}.f32le`;
        this.rawVideoPath = videoPath || `${this.botId}.i420`;
    // Put meta next to provided audioPath if present
    const metaDir = audioPath ? path.dirname(audioPath) : process.cwd();
    this.rawMetaPath = path.join(metaDir, `${this.botId}.raw.json`);
        this.rawConfig = { sampleRate, fps, maxWidth, maxHeight };
        this.audioStartEpochMs = Date.now();

        // Open write streams
        this.rawAudioStream = fs.createWriteStream(this.rawAudioPath);
        this.rawVideoStream = fs.createWriteStream(this.rawVideoPath);
    await fs.writeJSON(this.rawMetaPath, { sampleRate, fps, maxWidth, maxHeight, audioStartEpochMs: this.audioStartEpochMs, note: 'Video frames are planar I420 concatenated per frame; audio is little-endian 32-bit float mono.' }, { spaces: 2 });

        // Bridge functions for page to deliver binary chunks
        await this.page.exposeFunction(`__${this.botId}_audioChunk`, async (arr) => {
            // arr is a regular array of numbers; convert to Buffer quickly
            const buf = Buffer.from(new Float32Array(arr).buffer);
            this.rawAudioStream.write(buf);
            if (this.audioForwarder) {
                try { this.audioForwarder(buf, sampleRate); } catch {}
            }
        });
        await this.page.exposeFunction(`__${this.botId}_videoFrame`, async (metaAndData) => {
            // metaAndData: { w,h,data:Array<number> }
            const { w, h, data } = metaAndData;
            const header = Buffer.alloc(12);
            header.writeUInt32LE(w, 0);
            header.writeUInt32LE(h, 4);
            // reserved/pad for future timestamp
            header.writeUInt32LE(0, 8);
            const payload = Buffer.from(Uint8Array.from(data));
            this.rawVideoStream.write(header);
            this.rawVideoStream.write(payload);
        });

        // Inject processors on the page
        await this.page.evaluate(async (botId, sampleRate, fps, maxWidth, maxHeight, remoteOnlyFlag) => {
            const audioFn = window[`__${botId}_audioChunk`];
            const videoFn = window[`__${botId}_videoFrame`];

            // Build a stable combined stream
            const audioTracks = (window.__meetingTracks || [])
                .filter(t => t.kind === 'audio' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                .map(t => t.track);
            const videoTracks = (window.__meetingTracks || [])
                .filter(t => t.kind === 'video' && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                .map(t => t.track);

            const combinedStream = new MediaStream();
            audioTracks.forEach(t => combinedStream.addTrack(t));
            if (videoTracks[0]) combinedStream.addTrack(videoTracks[0]); // take first video for raw

            // ---- Audio (F32LE mono) via AudioWorklet ----
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
                const src = new MediaStreamAudioSourceNode(ctx, { mediaStream: combinedStream });
                const workletCode = `class RawAudioProcessor extends AudioWorkletProcessor { process(inputs) { const input = inputs[0]; if (input && input[0] && input[0].length) { const channel = input[0]; this.port.postMessage(channel); } return true; } } registerProcessor('raw-audio', RawAudioProcessor);`;
                const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
                await ctx.audioWorklet.addModule(blobUrl);
                const node = new AudioWorkletNode(ctx, 'raw-audio');
                node.port.onmessage = (e) => {
                    const arr = Array.from(e.data);
                    audioFn(arr);
                };
                // IMPORTANT: Do NOT connect to ctx.destination to avoid local playback noise/echo
                src.connect(node); // processing only
                window.__rawAudioCtx = ctx;
                // Keep AudioContext running in background
                window.__rawAudioKeepAlive = setInterval(() => {
                    try { if (ctx.state !== 'running') ctx.resume(); } catch {}
                }, 1500);
            } catch (e) {
                console.error('[RawCapture] Audio worklet init error:', e);
            }

            // ---- Video (I420) via WebCodecs MediaStreamTrackProcessor ----
            async function startVideoProcessor(track) {
                if (!('MediaStreamTrackProcessor' in window)) {
                    console.warn('[RawCapture] MediaStreamTrackProcessor not available');
                    return;
                }
                const processor = new MediaStreamTrackProcessor({ track });
                const reader = processor.readable.getReader();
                const targetW = maxWidth; const targetH = maxHeight;
                let lastTime = 0; const minDelta = 1000 / Math.max(1, fps);
                const canvas = new OffscreenCanvas(targetW, targetH);
                const ctx2d = canvas.getContext('2d');
                const toI420 = async (imageBitmap) => {
                    // Draw to RGBA, then convert to I420 in JS (slow but functional)
                    ctx2d.drawImage(imageBitmap, 0, 0, targetW, targetH);
                    const { data } = ctx2d.getImageData(0, 0, targetW, targetH);
                    const w = targetW, h = targetH;
                    const ySize = w * h;
                    const uvSize = (w >> 1) * (h >> 1);
                    const i420 = new Uint8Array(ySize + uvSize * 2);
                    // Compute Y plane
                    let yi = 0; let uBlock = ySize; let vBlock = ySize + uvSize;
                    for (let j = 0; j < h; j++) {
                        for (let i = 0; i < w; i++) {
                            const idx = (j * w + i) * 4;
                            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                            // BT.601 full-range conversion
                            const y = 0.257 * r + 0.504 * g + 0.098 * b + 16;
                            i420[yi++] = Math.max(0, Math.min(255, y|0));
                        }
                    }
                    // Compute subsampled U and V
                    for (let j = 0; j < h; j += 2) {
                        for (let i = 0; i < w; i += 2) {
                            const idx00 = (j * w + i) * 4;
                            const idx01 = (j * w + (i+1)) * 4;
                            const idx10 = ((j+1) * w + i) * 4;
                            const idx11 = ((j+1) * w + (i+1)) * 4;
                            const r = (data[idx00] + data[idx01] + data[idx10] + data[idx11]) / 4;
                            const g = (data[idx00+1] + data[idx01+1] + data[idx10+1] + data[idx11+1]) / 4;
                            const b = (data[idx00+2] + data[idx01+2] + data[idx10+2] + data[idx11+2]) / 4;
                            const u = -0.148 * r - 0.291 * g + 0.439 * b + 128;
                            const v = 0.439 * r - 0.368 * g - 0.071 * b + 128;
                            i420[uBlock++] = Math.max(0, Math.min(255, u|0));
                            i420[vBlock++] = Math.max(0, Math.min(255, v|0));
                        }
                    }
                    return i420;
                };
                async function loop() {
                    const { value: frame, done } = await reader.read();
                    if (done) return;
                    const now = performance.now();
                    if (now - lastTime >= minDelta) {
                        lastTime = now;
                        let bitmap;
                        try { bitmap = await createImageBitmap(frame); } catch {}
                        frame.close();
                        if (bitmap) {
                            const i420 = await toI420(bitmap);
                            videoFn({ w: targetW, h: targetH, data: Array.from(i420) });
                            bitmap.close && bitmap.close();
                        }
                    } else {
                        frame.close();
                    }
                    loop();
                }
                loop();
                window.__rawVideoReader = reader;
            }

            if (videoTracks[0]) {
                startVideoProcessor(videoTracks[0]);
            }
    }, this.botId, sampleRate, fps, maxWidth, maxHeight, remoteOnly);
    }

    async stopRawCapture() {
        // Close page processors if any
        try {
            await this.page.evaluate(() => {
                try { if (window.__rawAudioCtx) window.__rawAudioCtx.close(); } catch {}
                try { if (window.__rawVideoReader) window.__rawVideoReader.cancel(); } catch {}
            });
        } catch {}

        // Close streams
        await new Promise(res => this.rawAudioStream?.end(res));
        await new Promise(res => this.rawVideoStream?.end(res));
        console.log(`[${this.botId}] ✅ Raw capture files closed (${this.rawAudioPath}, ${this.rawVideoPath})`);
    }

    async startRemoteAudioCapture(outputPath, { audioBitsPerSecond = 128000 } = {}) {
        console.log(`[${this.botId}] 🎙️  Starting remote-audio capture…`);
        this.audioOutputPath = outputPath;
        const ok = await this.page.evaluate(async (bps) => {
            try {
                const ac = new (window.AudioContext || window.webkitAudioContext)();
                const dest = ac.createMediaStreamDestination();
                const attached = new Set();
                const attach = (tr) => {
                    if (!tr || attached.has(tr.id)) return;
                    attached.add(tr.id);
                    try {
                        const src = new MediaStreamAudioSourceNode(ac, { mediaStream: new MediaStream([tr]) });
                        src.connect(dest);
                    } catch {}
                };
                const scan = () => {
                    (window.__meetingTracks || []).filter(t=>t && t.type==='remote' && t.kind==='audio' && t.track && t.track.readyState==='live').forEach(t=>attach(t.track));
                };
                scan();
                window.__raScanIv = setInterval(scan, 2000);
                const track = dest.stream.getAudioTracks()[0];
                if (!track) return { success:false, error:'no remote audio track' };
                const rec = new MediaRecorder(new MediaStream([track]), { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond:bps });
                const chunks=[];
                rec.ondataavailable=e=>{ if(e.data&&e.data.size) chunks.push(e.data)};
                rec.onstop=()=>{
                    try{clearInterval(window.__raScanIv)}catch{}
                    try{ac.close()}catch{}
                    window.__raBlob=new Blob(chunks,{type:'audio/webm'});
                };
                rec.start(1000);
                window.__raRec=rec;
                return {success:true};
            } catch(e){
                return {success:false,error:e.message};
            }
        }, audioBitsPerSecond);
        if(!ok.success) throw new Error(ok.error||'remote audio capture failed');
        this.audioCapture = true;
    }

    async stopRemoteAudioCapture() {
        if(!this.audioCapture) return;
        const bytes = await this.page.evaluate(async ()=>{
            try{ if(window.__raRec && window.__raRec.state==='recording') window.__raRec.stop(); }catch{}
            await new Promise(r=>setTimeout(r,1200));
            if(!window.__raBlob) return null;
            const buf=await window.__raBlob.arrayBuffer();
            return Array.from(new Uint8Array(buf));
        });
        if(bytes){
            await fs.writeFile(this.audioOutputPath, Buffer.from(bytes));
            console.log(`[${this.botId}] ✅ Saved remote audio ${this.audioOutputPath}`);
        } else {
            console.warn(`[${this.botId}] ⚠️ remote audio bytes empty`);
        }
        this.audioCapture=false;
    }

    getStats() {
        return {
            isCapturing: this.isCapturing,
            containerFile: this.outputPath,
            rawAudioFile: this.rawAudioPath,
            rawVideoFile: this.rawVideoPath,
            rawMetaFile: this.rawMetaPath
        };
    }

    getAudioStartEpochMs() {
        return this.audioStartEpochMs;
    }

    // ============ Full Tab Capture using getDisplayMedia (audio + video) ============
    async startTabCapture(outputPath, { width = 1280, height = 720, fps = 25, audioBitsPerSecond = 128000, videoBitsPerSecond = 2500000 } = {}) {
        console.log(`[${this.botId}] 🖥️ Starting full tab capture via getDisplayMedia...`);
        this.outputPath = outputPath;
        try {
            const result = await this.page.evaluate(async (W, H, fpsVal, vBps, aBps) => {
                // 0) Ask our extension for a real tab-capture streamId (granted with audio)
                const resp = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID' }).catch(()=>null);
                if (!resp || !resp.ok) {
                    return { success:false, error: `extension failed: ${resp?.error||'no response'}` };
                }
                const id = resp.streamId;
                try {
                    console.log('[TabCapture] Starting tab capture...');
                    
                    // 1) Directly obtain combined A+V via streamId
                    const gUM = await navigator.mediaDevices.getUserMedia({
                        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } },
                        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: W, maxHeight: H, maxFrameRate: fpsVal } }
                    });
                    const combined = gUM;

                    const videoTrack = combined.getVideoTracks()[0];
                    console.log(`[TabCapture] combined stream tracks v=${combined.getVideoTracks().length} a=${combined.getAudioTracks().length}`);
 
                    console.log(`[TabCapture] Combined stream has ${combined.getVideoTracks().length} video, ${combined.getAudioTracks().length} audio tracks`);

                    const options = {
                        mimeType: 'video/webm;codecs=vp9,opus',
                        videoBitsPerSecond: vBps,
                        audioBitsPerSecond: aBps
                    };
                    if (!(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(options.mimeType))) {
                        options.mimeType = 'video/webm;codecs=vp8,opus';
                        console.log('[TabCapture] Fallback to vp8,opus codec');
                    }
                    console.log(`[TabCapture] Using mimeType: ${options.mimeType}`);
                    
                    window.__tabRecordedChunks = [];
                    window.__tabMediaRecorder = new MediaRecorder(combined, options);
                    
                    window.__tabMediaRecorder.onerror = (e) => {
                        console.error('[TabCapture] MediaRecorder error:', e);
                    };
                    
                    window.__tabMediaRecorder.ondataavailable = (e) => {
                        if (e.data && e.data.size > 0) {
                            console.log(`[TabCapture] Data chunk received: ${(e.data.size/1024).toFixed(2)} KB`);
                            window.__tabRecordedChunks.push(e.data);
                        }
                    };
                    
                    window.__tabMediaRecorder.onstart = () => {
                        console.log('[TabCapture] ✅ MediaRecorder started');
                    };
                    
                    window.__tabMediaRecorder.onstop = () => {
                        console.log(`[TabCapture] MediaRecorder stopped, total chunks: ${window.__tabRecordedChunks.length}`);
                        try { combined.getTracks().forEach(t=>t.stop()); } catch {}
                        try { if (window.__tabMixAudioInterval) clearInterval(window.__tabMixAudioInterval); } catch {}
                        try { if (window.__tabAudioKeep) clearInterval(window.__tabAudioKeep); } catch {}
                        try { ac.close(); } catch {}
                        const blob = new Blob(window.__tabRecordedChunks, { type: options.mimeType });
                        console.log(`[TabCapture] Final blob size: ${(blob.size/1024/1024).toFixed(2)} MB`);
                        window.__tabFinalRecording = blob;
                    };
                    
                    window.__tabMediaRecorder.start(1000);
                    console.log('[TabCapture] MediaRecorder.start(1000) called');

                    // Keep AudioContext alive in background
                    window.__tabAudioKeep = setInterval(() => {
                        try { if (ac.state !== 'running') ac.resume(); } catch {}
                    }, 1500);
                    
                    return { success: true, message: 'Tab capture started' };
                } catch (err) {
                    console.error('[TabCapture] Error in evaluate:', err.message);
                    return { success: false, error: err.message };
                }
            }, width, height, fps, videoBitsPerSecond, audioBitsPerSecond);
            
            if (!result || !result.success) {
                throw new Error(`Tab capture failed: ${result?.error || 'unknown'}`);
            }
            console.log(`[${this.botId}] ✅ Tab capture started successfully`);
            this.isTabCapturing = true;
        } catch (e) {
            console.error(`[${this.botId}] ❌ Failed to start tab capture:`, e.message);
            throw e;
        }
    }

    async stopTabCapture() {
        try {
            await this.page.evaluate(() => {
                try { clearInterval(window.__tabAudioKeep); } catch {}
                try { clearInterval(window.__tabMixAudioInterval); } catch {}
                if (window.__tabMediaRecorder && window.__tabMediaRecorder.state === 'recording') {
                    window.__tabMediaRecorder.stop();
                }
            });
            await this.page.waitForTimeout(1500);
            const bytes = await this.page.evaluate(async () => {
                if (!window.__tabFinalRecording) return null;
                const buf = await window.__tabFinalRecording.arrayBuffer();
                return Array.from(new Uint8Array(buf));
            });
            if (bytes) {
                const buffer = Buffer.from(bytes);
                await fs.writeFile(this.outputPath, buffer);
                console.log(`[${this.botId}] ✅ Saved ${this.outputPath} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
            } else {
                console.warn(`[${this.botId}] ⚠️ No tab recording bytes available`);
            }
        } catch (e) {
            console.warn(`[${this.botId}] ⚠️ stopTabCapture error: ${e.message}`);
        } finally {
            this.isTabCapturing = false;
        }
    }
}

module.exports = { WebRTCCapture };
