class WebRTCCapture {
    constructor(botId, page) {
        this.botId = botId;
        this.page = page;
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
}

module.exports = { WebRTCCapture };