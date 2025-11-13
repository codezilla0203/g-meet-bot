const fs = require('fs-extra');

class WebRTCCapture {
    constructor(botId, page) {
        this.botId = botId;
        this.page = page;
        this.isCapturing = false;
        this.isTabCapturing = false;
        this.isAudioOnlyCapturing = false;
        this.outputPath = null;
        this.audioOutputPath = null;
        this.transcriptionCallback = null;
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

    getStats() { return { isCapturing: this.isTabCapturing, containerFile: this.outputPath }; }

    getAudioStartEpochMs() { return null; }

    // ============ Full Tab Capture using getDisplayMedia (video-only) ============
    async startTabCapture(outputPath, { width = 1280, height = 720, fps = 25, videoBitsPerSecond = 2500000 } = {}) {
        console.log(`[${this.botId}] 🖥️ Starting full tab capture via getDisplayMedia...`);
        this.outputPath = outputPath;
        try {
            try { await this.page.bringToFront(); } catch {}
            await this.page.evaluate(async (W, H, fpsVal, vBps) => {
                const constraints = {
                    video: {
                        width: { max: W },
                        height: { max: H },
                        frameRate: { max: fpsVal },
                        logicalSurface: true,
                        cursor: 'always',
                        resizeMode: 'crop-and-scale'
                    },
                    /* Request tab audio as well */
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 44100
                    },
                    // Chrome-specific hints; ignored if unsupported
                    preferCurrentTab: true,
                    selfBrowserSurface: 'include',
                    systemAudio: 'exclude',
                    surfaceSwitching: 'include',
                    monitorTypeSurfaces: 'exclude'
                };
                const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
                const opts = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: vBps };
                if (!(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(opts.mimeType))) {
                    opts.mimeType = 'video/webm;codecs=vp8';
                }
                window.__tabRecordedChunks = [];
                const rec = new MediaRecorder(stream, opts);
                rec.ondataavailable = (e) => { if (e.data && e.data.size) window.__tabRecordedChunks.push(e.data); };
                rec.onstop = () => {
                    try { stream.getTracks().forEach(t=>t.stop()); } catch {}
                    window.__tabFinalRecording = new Blob(window.__tabRecordedChunks, { type: opts.mimeType });
                };
                rec.start(2000);
                window.__tabMediaRecorder = rec;
            }, width, height, fps, videoBitsPerSecond);
            console.log(`[${this.botId}] ✅ Tab capture started`);
            this.isTabCapturing = true;
        } catch (e) {
            console.error(`[${this.botId}] ❌ Failed to start tab capture:`, e.message);
            throw e;
        }
    }

    async stopTabCapture() {
        try {
            await this.page.evaluate(async () => {
                if (window.__tabMediaRecorder && window.__tabMediaRecorder.state === 'recording') {
                    window.__tabMediaRecorder.stop();
                }
            });
            let bytes = null;
            for (let i = 0; i < 5; i++) {
                await this.page.waitForTimeout(1000);
                bytes = await this.page.evaluate(async () => {
                    if (!window.__tabFinalRecording) return null;
                    const buf = await window.__tabFinalRecording.arrayBuffer();
                    return Array.from(new Uint8Array(buf));
                });
                if (bytes && bytes.length) break;
            }
            if (bytes) {
                const buffer = Buffer.from(bytes);
                await fs.writeFile(this.outputPath, buffer);
                console.log(`[${this.botId}] ✅ Saved ${this.outputPath} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
            }
        } catch (e) {
            console.warn(`[${this.botId}] ⚠️ stopTabCapture error: ${e.message}`);
        }
    }

    // ============ Audio-only capture (remote participants) ============
    async startAudioOnlyCapture(outputPath, { remoteOnly = true, audioBitsPerSecond = 128000 } = {}) {
        console.log(`[${this.botId}] 🔈 Starting audio-only capture (remote participants)...`);
        this.audioOutputPath = outputPath;
        try {
            const result = await this.page.evaluate((remoteOnlyFlag, aBps) => {
                try {
                    const tracks = (window.__meetingTracks || [])
                        .filter(t => t.kind === 'audio' && t.track && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                        .map(t => t.track);

                    if (tracks.length === 0) {
                        console.warn('[AudioOnly] No remote audio tracks found yet; will start recording and attach tracks as they appear.');
                    } else {
                        console.log(`[AudioOnly] Found ${tracks.length} remote audio track(s)`);
                    }

                    const ac = new (window.AudioContext || window.webkitAudioContext)();
                    const dest = ac.createMediaStreamDestination();
                    const connected = new Set();
                    const connectTrack = (tr) => {
                        if (!tr || connected.has(tr.id)) return;
                        connected.add(tr.id);
                        try {
                            const src = new MediaStreamAudioSourceNode(ac, { mediaStream: new MediaStream([tr]) });
                            const gain = ac.createGain(); 
                            // Normalize gain - will be recalculated as more tracks join
                            gain.gain.value = 1.0 / Math.max(1, connected.size);
                            src.connect(gain).connect(dest);
                            console.log(`[AudioOnly] Connected audio track: ${tr.id} (${connected.size} total)`);
                        } catch (e) {
                            console.warn('[AudioOnly] Failed to connect track:', e?.message || e);
                        }
                    };
                    tracks.forEach(connectTrack);
                    // Periodically attach new remote tracks
                    window.__audioMixIv = setInterval(() => {
                        try {
                            const more = (window.__meetingTracks || [])
                                .filter(t => t.kind === 'audio' && t.track && t.track.readyState === 'live' && (!remoteOnlyFlag || t.type === 'remote'))
                                .map(t => t.track)
                                .filter(tr => !connected.has(tr.id));
                            more.forEach(connectTrack);
                        } catch {}
                    }, 2000);

                    const typeCandidates = [ 'audio/webm;codecs=opus', 'audio/webm' ];
                    let chosen = typeCandidates.find(t => (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)));
                    if (!chosen) chosen = 'audio/webm';

                    window.__audioRecorderChunks = [];
                    const rec = new MediaRecorder(dest.stream, { mimeType: chosen, audioBitsPerSecond: aBps });
                    rec.ondataavailable = (e) => { if (e.data && e.data.size) window.__audioRecorderChunks.push(e.data); };
                    rec.onstop = () => {
                        try { clearInterval(window.__audioMixIv); } catch {}
                        try { ac && ac.close(); } catch {}
                        window.__audioFinalBlob = new Blob(window.__audioRecorderChunks, { type: chosen });
                    };
                    rec.start(1000);
                    window.__audioRecorder = rec;
                    return { success: true, tracksFound: tracks.length, mimeType: chosen };
                } catch (e) {
                    console.error('[AudioOnly] failed to start:', e?.message || e);
                    return { success: false, error: e?.message || String(e) };
                }
            }, remoteOnly, audioBitsPerSecond);
            
            if (result && result.success) {
                console.log(`[${this.botId}] ✅ Audio-only capture started (${result.tracksFound} track(s), ${result.mimeType})`);
                this.isAudioOnlyCapturing = true;
            } else {
                throw new Error(result?.error || 'Failed to start audio-only capture');
            }
        } catch (e) {
            console.error(`[${this.botId}] ❌ startAudioOnlyCapture error: ${e.message}`);
            throw e;
        }
    }

    async stopAudioOnlyCapture() {
        try {
            await this.page.evaluate(() => {
                try {
                    if (window.__audioRecorder && window.__audioRecorder.state === 'recording') window.__audioRecorder.stop();
                } catch {}
            });
            let bytes = null;
            for (let i = 0; i < 5; i++) {
                await this.page.waitForTimeout(1000);
                bytes = await this.page.evaluate(async () => {
                    if (!window.__audioFinalBlob) return null;
                    const buf = await window.__audioFinalBlob.arrayBuffer();
                    return Array.from(new Uint8Array(buf));
                });
                if (bytes && bytes.length) break;
            }
            if (bytes) {
                const buffer = Buffer.from(bytes);
                await fs.writeFile(this.audioOutputPath, buffer);
                console.log(`[${this.botId}] ✅ Saved audio ${this.audioOutputPath} (${(buffer.length/1024/1024).toFixed(2)} MB)`);
            }
        } catch (e) {
            console.warn(`[${this.botId}] ⚠️ stopAudioOnlyCapture error: ${e.message}`);
        } finally {
            this.isAudioOnlyCapturing = false;
        }
    }
}

module.exports = { WebRTCCapture };