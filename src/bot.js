const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');
const { WebRTCCapture } = require('./modules/webrtc-capture');
const WebSocket = require('ws');
const crypto = require('crypto');
const { getCurrentTimestamp, formatDate, formatDateLong, timestampToTimezone } = require('./utils/timezone');
const { sendWebhook } = require('./utils/webhook');
// ADD EXTENSION_PATH constant to point to the built-in Chrome extension.
const EXTENSION_PATH = path.resolve(__dirname, '..', 'transcript_extension');

puppeteer.use(StealthPlugin());

// Google Meet lobby/admission constants (GoogleMeetBot style)
const GOOGLE_LOBBY_MODE_HOST_TEXT = 'Waiting for the host to let you in';
const GOOGLE_REQUEST_DENIED = 'Your request to join was denied';
const GOOGLE_REQUEST_TIMEOUT = 'Your request to join wasn\'t answered';
const GOOGLE_REMOVED_FROM_MEETING = 'You\'ve been removed from the meeting';
const GOOGLE_NO_RESPONSE = 'No one responded to your request to join the call';

/**
 * Google Meet Recording Bot - Final Clean Version
 * 
 * Features:
 * - WebRTC direct stream capture (Recall.ai style)
 * - Real-time transcription with Deepgram
 * - Automatic participant monitoring
 * - Clean meeting exit when empty
 * - High-quality recording output
 */
class Bot {
    constructor(id, botName = "CXFlow Meeting Bot", onLeaveCallback = null, captionLanguage = "es", emailRecipients = null, recordingType = "audio-video", maxRecordingDuration = null, botLogoUrl = null, webhookURL = null) {
        this.id = id;
        this.botName = botName;
        this.onLeave = onLeaveCallback;
        this.captionLanguage = captionLanguage;  // Caption language preference (ISO code)
        this.emailRecipients = emailRecipients;  // Email addresses to send summary to
        this.recordingType = recordingType;  // "audio-video" or "audio-only"
        this.botLogoUrl = botLogoUrl;  // Bot logo URL for profile picture overlay
        this.meetUrl = null;  // Will be set when joining meeting
        this.slightlySecretId = crypto.randomBytes(16).toString('hex');
        
        // Core components
        this.browser = null;
        this.page = null;
        this.isCapturing = false;
        this.isLeaving = false;
        
        // Monitoring
        this.participantCheckInterval = null;
        this.keepAliveInterval = null;
        this._cdp = null;
        this.modalDismissInterval = null; // GoogleMeetBot style perpetual modal dismissal
        this.pageValidityInterval = null; // Check if still on valid Meet page
        this.speakerActivityInterval = null; // Interval for sampling active speaker names

        const runtimeRoot = path.join(__dirname, '../runtime');
        this.runtimeRoot = runtimeRoot;
        this.botDir = path.join(runtimeRoot, this.id);
        // Video output + derived data
        this.transcriptsDir = path.join(this.botDir, 'transcripts');
        this.videoDir = path.join(this.botDir, 'video');
        this.speakerTimeframesFile = path.join(this.botDir, 'SpeakerTimeframes.json');
        this.metricsFile = path.join(this.botDir, 'MeetingMetrics.json');
        this.botsPidDir = path.join(runtimeRoot, 'bots');
        try {
            fs.ensureDirSync(this.botDir);
            fs.ensureDirSync(this.transcriptsDir);
            fs.ensureDirSync(this.videoDir);
            // Don't create botsPidDir here - only create when actually writing PID file
        } catch {}
        // Live captions (Google Meet native captions)
        this.captions = [];
        this.captionsIndex = 0;
        this.captionsFile = path.join(this.transcriptsDir, 'captions.json');
        this.browserPidFile = path.join(this.botsPidDir, `${this.id}.pid`);
        this.hasSeenParticipants = false;

        // Recording (GoogleMeetBot style - MediaRecorder based)
        this.slightlySecretId = crypto.randomBytes(16).toString('hex'); // For secure browser<->node communication
        // Use appropriate file extension based on recording type
        const fileExtension = this.recordingType === 'audio-only' ? '.webm' : '.webm'; // WebM supports both audio-only and video
        this.recordingPath = path.join(this.videoDir, `${this.id}${fileExtension}`);
        this.recordingStartedAt = 0;
        this.recordingChunks = []; // Store recording chunks temporarily
        // Use provided maxRecordingDuration or fall back to environment variable or default
        this.maxRecordingDuration = maxRecordingDuration || 60; // minutes
        this.inactivityLimit = parseInt(process.env.INACTIVITY_LIMIT) || 10; // minutes
        this.activateInactivityAfter = parseInt(process.env.ACTIVATE_INACTIVITY_AFTER) || 2; // minutes

        // Speaker activity tracking (MeetsBot style)
        this.registeredActivityTimestamps = {};
        this.participants = [];
        this.lastActivity = undefined;
        this.timeAloneStarted = Infinity;
        this.meetingHost = null; // Store meeting host name
        // Helper list of self-labels to ignore when parsing aria-label names
        this._SELF_VIEW_LABELS = [
            'you',
            'your video',
            'self view'
        ];

        // Track participant join times and temporary absence counts for left detection
        this.participantJoinTimes = {}; // name -> timestampMs
        this.participantAbsenceCounts = {}; // name -> consecutive missing checks
        this.webhookUrl = webhookURL || null;
        // Meeting metrics tracking
        this.meetingStartTime = null;
        this.meetingEndTime = null;
        this.maxParticipantsSeen = 0; // Track maximum number of participants seen during monitoring
        // Locking / leader election state (local lock-file only)
        this.keywordsList = [
            // Common meeting keywords - can be customized via environment variable
            'action item', 'follow up', 'deadline', 'decision', 'agreement',
            'task', 'assign', 'responsible', 'next steps', 'priority',
            'budget', 'timeline', 'milestone', 'risk', 'issue', 'blocker'
        ];
        // Load custom keywords from environment if provided
        if (process.env.MEETING_KEYWORDS) {
            try {
                this.keywordsList = JSON.parse(process.env.MEETING_KEYWORDS);
            } catch (e) {
                console.warn(`[${this.id}] ⚠️ Failed to parse MEETING_KEYWORDS, using defaults`);
            }
        }
    }

    // Webhook sending is delegated to src/utils/webhook.sendWebhook

    /**
     * Emit a standardized error webhook (event: error.occurred)
     * Payload: { meeting_id, code, message, timestamp_iso, timestamp_formatted, timezone, details }
     */
    async emitError(code, message, details = {}) {
        try {
            const meetingId = this.getMeetingIdFromUrl(this.meetUrl) || this.id || null;
            const ts = getCurrentTimestamp ? getCurrentTimestamp() : { iso: new Date().toISOString(), formatted: new Date().toISOString(), timezone: process.env.TIMEZONE || 'UTC' };
            const payload = {
                meeting_id: meetingId,
                code: code || 'unknown_error',
                message: message || '',
                timestamp_iso: ts.iso || new Date().toISOString(),
                timestamp: ts.formatted || (new Date()).toISOString(),
                timezone: ts.timezone || process.env.TIMEZONE || 'UTC',
                details: details || {}
            };

            // Log locally as well
            console.error(`[${this.id}] 🔥 Emitting error webhook: ${payload.code} - ${payload.message}`);

            // Best-effort send; do not throw on failure
            await sendWebhook('error.occurred', payload, this.webhookUrl || null);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ emitError failed: ${e && e.message ? e.message : e}`);
        }
    }

    // Helper: click selector if visible within timeout
    async clickIfVisible(selector, timeout = 3000) {
        try {
            await this.page.waitForSelector(selector, { visible: true, timeout });
            await this.page.click(selector).catch(() => {});
            return true;
        } catch {
            return false;
        }
    }

    // Dismiss overlays like "Got it" / "Continue" and press Escape to clear dialogs
    async dismissOverlays() {
        try {
            // Run in page context – Node does not have DOM APIs like querySelectorAll/offsetParent
            await this.page.evaluate(() => {
                try {
                    // Robust modal/overlay cleanup: try clicking common buttons first, then remove heavy overlay nodes
                    const textCandidates = ['got it', 'click allow', 'click to allow', 'allow', 'allow access', 'continue', 'ok', 'ok got it', 'turn on captions', 'enable captions', 'accept'];

                    const clickIfMatches = (el) => {
                        try {
                            const txt = (el.innerText || '').toLowerCase().trim();
                            if (!txt) return false;
                            for (const cand of textCandidates) {
                                if (txt.includes(cand)) {
                                    try { el.click(); } catch { /* fallthrough */ }
                                    console.log('[Browser] ✖️ Clicked modal button matching:', cand);
                                    return true;
                                }
                            }
                        } catch {}
                        return false;
                    };

                    // 1) Attempt to click visible buttons/anchors with matching text
                    const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
                    for (const e of els) {
                        if (e.offsetParent === null) continue; // not visible
                        if (clickIfMatches(e)) return;
                    }

                    // 2) Try to remove obvious overlay/dialog containers
                    const overlaySelectors = ['[role="dialog"]', '.modal', '.overlay', '.caveat', '.permission', '[data-modal]'];
                    for (const sel of overlaySelectors) {
                        const nodes = Array.from(document.querySelectorAll(sel));
                        for (const n of nodes) {
                            try {
                                const cs = window.getComputedStyle(n);
                                if (cs && (cs.position === 'fixed' || cs.position === 'absolute' || parseInt(cs.zIndex || '0', 10) > 1000)) {
                                    console.log('[Browser] ✖️ Removing overlay node for selector', sel);
                                    n.remove();
                                    return;
                                }
                            } catch (e) {}
                        }
                    }

                    // 3) Fallback: dispatch Escape key event to dismiss dialogs
                    try {
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
                        console.log('[Browser] ✖️ Dispatched Escape to dismiss possible dialogs');
                    } catch (e) {}

                } catch (err) {
                    console.error('[Browser] Modal dismiss evaluate error:', err);
                }
            });
        } catch (error) {
            console.error('[Browser] Modal dismiss error:', error);
        }
    }

    // Collapse preview flows where there is a two-step join (click the second "Join now" if visible)
    async collapsePreviewIfNeeded() {
        try {
            const xp = "//button[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join now')]";
            const btns = await this.page.$x(xp).catch(() => []);
            if (btns && btns.length > 1) {
                try { await this.page.evaluate((n) => n.click(), btns[1]); console.log(`[${this.id}] clicked 2-step Join`); } catch {}
            }
        } catch {}
    }

    /**
     * Perform random mouse movements to simulate human behavior and avoid bot detection
     * @param {number} durationSeconds - Duration in seconds to perform random movements (default: 8)
     */
    async performRandomMouseMovements(durationSeconds = 8) {
        if (!this.page) return;
        
        try {
            console.log(`[${this.id}] 🖱️ Starting random mouse movements for ${durationSeconds} seconds...`);
            
            await this.page.evaluate(async (duration) => {
                const endTime = Date.now() + (duration * 1000);
                const margin = 100;
                
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                
                const getRandomPosition = () => {
                    const width = window.innerWidth;
                    const height = window.innerHeight;
                    return {
                        x: Math.floor(Math.random() * (width - 2 * margin)) + margin,
                        y: Math.floor(Math.random() * (height - 2 * margin)) + margin
                    };
                };
                
                while (Date.now() < endTime) {
                    try {
                        const pos = getRandomPosition();
                        
                        // Get element at position and dispatch mouse events
                        const element = document.elementFromPoint(pos.x, pos.y);
                        
                        if (element) {
                            // Dispatch mousemove event
                            const moveEvent = new MouseEvent('mousemove', {
                                view: window,
                                bubbles: true,
                                cancelable: true,
                                clientX: pos.x,
                                clientY: pos.y
                            });
                            element.dispatchEvent(moveEvent);
                        }
                        
                        // Random pause between movements (100-300ms)
                        const pauseMs = Math.random() * 200 + 100;
                        await sleep(pauseMs);
                        
                        // Occasionally pause longer (10% chance)
                        if (Math.random() < 0.1) {
                            const longPauseMs = Math.random() * 500 + 500;
                            await sleep(longPauseMs);
                        }
                        
                    } catch (e) {
                        // Silently continue on error
                        await sleep(100);
                    }
                }
            }, durationSeconds);
            
            console.log(`[${this.id}] ✅ Completed random mouse movements`);
        } catch (error) {
            console.warn(`[${this.id}] ⚠️ Error during random mouse movements:`, error.message);
        }
    }

    /**
     * Orchestrate full join + record flow
     */
    async joinMeet(meetUrl) {
        // Launch browser and join flow with guarded error reporting
        try {
            await this.launchBrowser();
        } catch (e) {
            try { await this.emitError('launch_failure', 'Failed to launch browser', { error: e && e.message ? e.message : String(e) }); } catch {}
            throw e;
        }

        await this.dismissInitialModals();

        try {
            await this.navigateAndJoin(meetUrl);
        } catch (e) {
            try { await this.emitError('join_failure', 'Failed during navigateAndJoin', { phase: 'navigateAndJoin', error: e && e.message ? e.message : String(e) }); } catch {}
            // Attempt graceful cleanup
            try { await this.leaveMeet(); } catch {}
            return;
        }

        // Perform random mouse movements on the Meet lobby page to simulate human behavior
        await this.performRandomMouseMovements(8);

        try {
            await this.waitForAdmission();
        } catch (e) {
            try { await this.emitError('admission_failure', 'Failed during waitForAdmission', { phase: 'waitForAdmission', error: e && e.message ? e.message : String(e) }); } catch {}
            try { await this.leaveMeet(); } catch {}
            return;
        }

        // Mark admission in page context so the extension can start captions only
        // after we are actually inside the meeting (not just in the waiting room).
        
        // Quick modal dismissal after admission
        try {
            for (let i = 0; i < 3; i++) {
                await this.page.keyboard.press('Escape').catch(() => {});
                await this.page.waitForTimeout(50).catch(() => {});
            }
        } catch {}
        
        // Maximize window and force Tiled layout before recording
        try {
            await this.page.setViewport({ width: parseInt(process.env.BOT_VIEWPORT_WIDTH) || 1280, height: parseInt(process.env.BOT_VIEWPORT_HEIGHT) || 720 });
            await this.page.evaluate(() => {
                window.moveTo(0, 0);
                window.resizeTo(screen.availWidth, screen.availHeight);
            });
        } catch {}

        // await this.hideSelfView();

        // Mute mic/camera BEFORE recording starts
        await this.muteInCall();

        // Retry logo injection after participants join (video tiles should be fully loaded now)
        if (this.botLogoUrl) {
            await this.page.waitForTimeout(2000); // Wait for video tiles to stabilize
            await this.injectBotLogo();
        }

        const others = await this.waitForOtherParticipants(120000);
        if (!others) {
            console.log(`[${this.id}] ⏹️ No other participants joined within timeout; leaving.`);
            await this.leaveMeet();
            return;
        }
        this.hasSeenParticipants = true;

        // Fire webhook for bot admission if configured
        try {
            const meetingId = this.getMeetingIdFromUrl(this.meetUrl) || null;
            // Use repo timezone helper so joined_at is in configured Mexico timezone (formatted)
            const ts = getCurrentTimestamp();
            const joinedAt = ts.formatted; // e.g. '2025-11-27 10:30:45' in TIMEZONE
            // Send asynchronously but await to log errors. Pass per-bot webhook override when available.
            await sendWebhook('meeting.bot_joined', {
                meeting_id: meetingId,
                meeting_url: this.meetUrl,
                joined_at: joinedAt,
                timezone: ts.timezone
            }, this.webhookUrl || null);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Error sending meeting.bot_joined webhook: ${e && e.message ? e.message : e}`);
        }

        try {
            await this.page.evaluate(() => {
                try {
                    localStorage.setItem('botAdmitted', '1');
                    console.log('[CXFlow Bot] ✅ botAdmitted flag set');
                } catch (e) {
                    console.warn('[CXFlow Bot] ⚠️ Failed to set botAdmitted flag:', e);
                }
            });
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not set botAdmitted flag:`, e && e.message ? e.message : e);
        }

        this.startModalDismissal();
        await this.startRecording();
        this.startParticipantMonitoring();

        // await this.ensureTiledLayout();
    }

    /**
     * Launch browser with working configuration
     */
    async launchBrowser() {
        console.log(`[${this.id}] 🌐 Launching browser...`);

        // Upload server not needed for video-only tab capture

        const headlessEnv = process.env.BOT_HEADLESS || process.env.HEADLESS || '';
        let headlessMode = headlessEnv === '1' || /^true$/i.test(headlessEnv);
        // Extensions are not supported in Chrome headless; disable headless when we load transcript_extension
        if (headlessMode && EXTENSION_PATH) {
            console.log('[Bot] Forcing headless=false because extension needs UI context');
            headlessMode = false;
        }

        // IMPORTANT:
        // - Puppeteer adds `--mute-audio` by default which can result in recordings with no audio.
        // - We explicitly ignore that default arg and add explicit audio/MediaRecorder flags,
        //   mirroring the proven configuration from `meeting-bot` so that tab audio
        //   (other participants) is actually present in the captured stream.
        // Optimize viewport size for lower memory usage (1280x720 instead of 1920x1080)
        // This reduces memory by ~40% while maintaining good quality
        const viewportWidth = parseInt(process.env.BOT_VIEWPORT_WIDTH) || 1280;
        const viewportHeight = parseInt(process.env.BOT_VIEWPORT_HEIGHT) || 720;
        
        // Memory limit per bot (in MB) - configurable via env
        const memoryLimitMB = parseInt(process.env.BOT_MEMORY_LIMIT_MB) || 512;
        
        this.browser = await puppeteer.launch({
            headless: headlessMode ? 'new' : false,
            defaultViewport: { width: viewportWidth, height: viewportHeight },
            ignoreDefaultArgs: ['--mute-audio'],
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                // Memory and CPU optimizations
                `--memory-pressure-off`, // Disable memory pressure notifications
                `--max-old-space-size=${memoryLimitMB}`, // Limit V8 heap size
                `--js-flags=--max-old-space-size=${memoryLimitMB}`, // Additional JS heap limit
                // Reduce GPU usage (disable hardware acceleration in headless mode only)
                ...(headlessMode ? [
                    '--disable-gpu', // Disable GPU for headless (saves memory)
                    '--disable-software-rasterizer',
                ] : []),
                '--disable-dev-shm-usage', // Overcome limited resource problems
                // Disable unnecessary features to save memory
                '--disable-extensions-file-access-check',
                '--disable-extensions-http-throttling',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-sync', // Disable Chrome sync
                '--disable-translate', // Disable translation service
                '--disable-background-networking', // Disable background networking
                '--disable-background-downloads',
                '--disable-breakpad', // Disable crash reporting
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                '--disable-domain-reliability',
                '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-notifications',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-speech-api',
                '--disable-web-resources',
                '--metrics-recording-only',
                '--no-crash-upload',
                '--no-pings',
                '--no-zygote', // Disable zygote process (saves memory per bot)
                // Essential features for recording
                '--autoplay-policy=no-user-gesture-required',
                '--enable-features=WebCodecs,MediaRecorder',
                '--enable-audio-output',
                '--no-mute-audio',
                '--enable-usermedia-screen-capturing',
                '--allow-http-screen-capture',
                // Auto-accept tab capture where supported (Chrome >= 135 / matching policy)
                '--auto-accept-this-tab-capture',
                '--auto-select-desktop-capture-source=Meet',
                // Prevent background throttling so recording and captions keep running without focus
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-features=CalculateNativeWinOcclusion',
                '--disable-background-media-suspend',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-features=BackForwardCache,OptimizationHints',
                `--window-size=${viewportWidth},${viewportHeight}`,
                // Load custom transcript extension instead of using caption collector
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                `--allow-file-access-from-files`,
                `--allow-insecure-localhost`,
                // Process limits (Linux only, optional via env)
                // ...(process.platform === 'linux' && process.env.BOT_SINGLE_PROCESS === 'true' ? [
                //     '--single-process', // Run in single process mode (saves memory, but less stable)
                // ] : []),
            ]
        });

        // Handle browser disconnection
        this.browser.on('disconnected', () => {
            const isSingleProcess = process.platform === 'linux' && process.env.BOT_SINGLE_PROCESS === 'true';
            console.warn(`[${this.id}] ⚠️ Browser disconnected unexpectedly${isSingleProcess ? ' (single-process mode - may be less stable)' : ''}`);
            try { 
                this.emitError && this.emitError('browser_disconnected', 
                    `Browser disconnected unexpectedly${isSingleProcess ? ' (single-process mode)' : ''}`, 
                    { singleProcessMode: isSingleProcess }
                ); 
            } catch (e) {}
            
            // Immediately stop all intervals to prevent errors
            try {
                if (this.participantCheckInterval) {
                    clearInterval(this.participantCheckInterval);
                    this.participantCheckInterval = null;
                }
                if (this.speakerActivityInterval) {
                    clearInterval(this.speakerActivityInterval);
                    this.speakerActivityInterval = null;
                }
                if (this.modalDismissInterval) {
                    clearInterval(this.modalDismissInterval);
                    this.modalDismissInterval = null;
                }
                if (this.pageValidityInterval) {
                    clearInterval(this.pageValidityInterval);
                    this.pageValidityInterval = null;
                }
            } catch {}
            
            // Trigger cleanup if not already leaving
            if (!this.isLeaving) {
                this.leaveMeet();
            }
            
            // Best-effort: remove pid file on disconnect
            try { fs.removeSync(this.browserPidFile); } catch {}
        });

        this.page = await this.browser.newPage();

        // 👉 NEW: make navigator.permissions.query say "granted" for mic/cam/display
        try {
            await this.page.evaluateOnNewDocument(() => {
                try {
                    if (!navigator.permissions || !navigator.permissions.query) return;

                    const originalQuery = navigator.permissions.query.bind(navigator.permissions);

                    navigator.permissions.query = (params) => {
                        try {
                            const name = params && params.name;
                            if (
                                name === 'microphone' ||
                                name === 'camera' ||
                                name === 'display-capture' ||
                                name === 'displayCapture'
                            ) {
                                return Promise.resolve({
                                    state: 'granted',
                                    onchange: null,
                                    addEventListener() {},
                                    removeEventListener() {},
                                });
                            }
                        } catch {}
                        return originalQuery(params);
                    };
                } catch (e) {
                    console.error('[Browser] permissions monkey patch failed', e);
                }
            });
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not patch navigator.permissions: ${e.message}`);
        }

        // Mirror browser console logs into Node console for easier debugging of
        // things like audio track availability and MediaRecorder behaviour.
        // Ignore very noisy, known-safe warnings from Google Meet (TrustedScript, etc.).
        // this.page.on('console', (msg) => {
        //     try {
        //         const text = msg.text() || '';
        //         if (
        //             text.includes("This document requires 'TrustedScript' assignment") ||
        //             text.includes('TrustedScript') ||
        //             text.includes("Error with Permissions-Policy header: Unrecognized feature")
        //         ) {
        //             return;
        //         }
        //         console.log(`[${this.id}][Browser ${msg.type()}] ${text}`);
        //     } catch {}
        // });

        // Keep page "visible" to the site even if the window is unfocused/minimized
        try {
            await this.page.evaluateOnNewDocument(() => {
                try {
                    Object.defineProperty(document, 'hidden', { get: () => false });
                    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
                    // Pretend the page always has focus
                    try { document.hasFocus = () => true; } catch {}
                } catch {}
                document.addEventListener('visibilitychange', (e) => {
                    try { e.stopImmediatePropagation(); } catch {}
                }, true);
                window.addEventListener('blur', (e) => {
                    try { e.stopImmediatePropagation(); } catch {}
                }, true);
                window.addEventListener('focus', (e) => {
                    try { e.stopImmediatePropagation(); } catch {}
                }, true);
                // Ensure requestAnimationFrame keeps firing at a steady pace even if throttled
                try {
                    const nativeRAF = window.requestAnimationFrame.bind(window);
                    let last = Date.now();
                    window.requestAnimationFrame = (cb) => nativeRAF((t) => {
                        last = Date.now();
                        cb(t);
                    });
                    // Fallback tick in case RAF is throttled
                    setInterval(() => {
                        try { nativeRAF(() => {}); } catch {}
                    }, 1000);
                } catch {}
            });
        } catch {}
        
        // Set caption language preference in localStorage before navigation
        try {
            const captionLang = this.captionLanguage;
            await this.page.evaluateOnNewDocument((lang) => {
                try {
                    localStorage.setItem('captionLanguage', lang);
                    console.log(`Caption language preference set to: ${lang}`);
                } catch (e) {
                    console.error('Error setting caption language in localStorage:', e);
                }
            }, captionLang);
            console.log(`[${this.id}] 🌐 Caption language preference: ${captionLang}`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not set caption language:`, e && e.message ? e.message : e);
        }

        // Set timezone and locale preferences in localStorage for extension
        try {
            const { DEFAULT_TIMEZONE, DEFAULT_LOCALE } = require('./utils/timezone');
            await this.page.evaluateOnNewDocument((tz, loc) => {
                try {
                    localStorage.setItem('timezone', tz);
                    localStorage.setItem('locale', loc);
                    console.log(`Timezone set to: ${tz}, Locale: ${loc}`);
                } catch (e) {
                    console.error('Error setting timezone/locale in localStorage:', e);
                }
            }, DEFAULT_TIMEZONE, DEFAULT_LOCALE);
            console.log(`[${this.id}] 📅 Timezone: ${DEFAULT_TIMEZONE}, Locale: ${DEFAULT_LOCALE}`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not set timezone/locale:`, e && e.message ? e.message : e);
        }
        
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

        // Prepare capture helper and inject interceptors
        this.capture = new WebRTCCapture(this.id, this.page);
        await this.capture.injectWebRTCInterceptor();

        // Start CDP keep-alive to prevent background throttling
        await this.startKeepAlive();

        // Write Chrome PID file for crash/restart cleanup
        try {
            const proc = this.browser.process && this.browser.process();
            const pid = proc?.pid;
            if (pid && Number.isInteger(pid)) {
                this.browserPid = pid;
                // Only create botsPidDir when actually writing PID file
                await fs.ensureDir(this.botsPidDir);
                await fs.writeFile(this.browserPidFile, String(pid));
            }
        } catch {}
        
        console.log(`[${this.id}] ✅ Browser ready`);
    }

    async startKeepAlive() {
        try {
            this._cdp = await this.page.target().createCDPSession();

            // 👉 NEW: tell Chrome that meet.google.com already has media permissions
            try {
                await this._cdp.send('Browser.grantPermissions', {
                    origin: 'https://meet.google.com',
                    permissions: [
                        'audioCapture',
                        'videoCapture',
                        'displayCapture',  // for getDisplayMedia/tab audio
                    ],
                });
                console.log(`[${this.id}] ✅ Granted media permissions via CDP`);
            } catch (e) {
                console.warn(`[${this.id}] ⚠️ grantPermissions failed: ${e.message}`);
            }

            // existing keep-alive
            try {
                await this._cdp.send('Emulation.setIdleOverride', {
                    isUserActive: true,
                    isScreenUnlocked: true
                });
            } catch {}
            try {
                await this._cdp.send('Page.setWebLifecycleState', { state: 'active' });
            } catch {}

            if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = setInterval(async () => {
                try {
                    await this._cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
                } catch {}
                try {
                    await this._cdp.send('Page.setWebLifecycleState', { state: 'active' });
                } catch {}
            }, 10000);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Keep-alive CDP setup failed: ${e.message}`);
        }
    }

    async stopKeepAlive() {
        try { if (this.keepAliveInterval) clearInterval(this.keepAliveInterval); } catch {}
        this.keepAliveInterval = null;
        try { await this._cdp?.detach?.(); } catch {}
        this._cdp = null;
    }

    /**
     * Navigate to meeting and join as guest
     */
    async navigateAndJoin(meetUrl) {
        console.log(`[${this.id}] 📞 Joining: ${meetUrl}`);
        this.meetUrl = meetUrl;  // Store meeting URL for email

        try {
            // Navigate to meeting
            await this.page.goto(meetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Grant permissions (GoogleMeetBot style - include display-capture)
            const context = this.browser.defaultBrowserContext();
            await context.overridePermissions(meetUrl, [
                'microphone', 
                'camera', 
                'notifications',
            ]);

            // Initial pause to allow pre-join UI to render
            await this.page.waitForTimeout(3000);

            // Debug: log all button texts currently visible (Puppeteer equivalent of Playwright .allTextContents)
            try {
                const allButtons = await this.page.$$eval('button', els =>
                    els
                        .map(el => (el.innerText || el.textContent || '').trim())
                        .filter(Boolean)
                );
                console.log(`[${this.id}] Visible buttons on screen:`, allButtons);
            } catch {}

            // Dismiss device permission prompt like
            // "Continue without microphone and camera" / "Continue without mic and camera"
            try {
                const clicked = await this.page.evaluate(() => {
                    const candidates = Array.from(document.querySelectorAll('button'));
                    for (const btn of candidates) {
                        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                        if (!text) continue;
                        if (
                            text.includes('continue without microphone and camera') ||
                            text.includes('continue without mic and camera')
                        ) {
                            try {
                                btn.click();
                                return true;
                            } catch {
                                // ignore individual click failures
                            }
                        }
                    }
                    return false;
                });

                if (clicked) {
                    console.log(`[${this.id}] ✅ Clicked "Continue without microphone and camera" prompt`);
                    await this.page.waitForTimeout(1000);
                } else {
                    console.log(`[${this.id}] ℹ️ No device check prompt found (expected)`);
                }
            } catch {
                console.log(`[${this.id}] ℹ️ Device check prompt handling failed (non-critical)`);
            }

            // Enter name and join
            await this.requestToJoin();

        } catch (error) {
            console.error(`[${this.id}] ❌ Failed to join:`, error.message);
            throw error;
        }
    }
    /**
     * Enter bot name and request to join
     */
    async requestToJoin() {
        console.log(`[${this.id}] ✋ Requesting to join as: ${this.botName}`);

        try {
            // Enter bot name (handle multiple possible selectors/locales)
            const nameSelectors = [
                'input[placeholder="Your name"]',
                'input[aria-label*="Your name"]',
                'input[type="text"]'
            ];
            let nameInputFound = false;
            for (const sel of nameSelectors) {
                try {
                    await this.page.waitForSelector(sel, { timeout: 4000 });
                    await this.page.click(sel, { clickCount: 3 }).catch(()=>{});
                    // Clear via value assignment (faster than multiple Backspace when long)
                    await this.page.evaluate((selector) => {
                        const el = document.querySelector(selector);
                        if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
                    }, sel);
                    await this.page.type(sel, this.botName, { delay: 40 });
                    // Verify value
                    const ok = await this.page.evaluate((selector, expected) => {
                        const el = document.querySelector(selector);
                        return el && el.value.trim() === expected;
                    }, sel, this.botName);
                    if (!ok) {
                        // Force set if typing didn't stick (sometimes Meet overwrites transiently)
                        await this.page.evaluate((selector, expected) => {
                            const el = document.querySelector(selector);
                            if (el) { el.value = expected; el.dispatchEvent(new Event('input', { bubbles: true })); }
                        }, sel, this.botName);
                    }
                    nameInputFound = true;
                    break;
                } catch {}
            }
            if (!nameInputFound) {
                console.warn(`[${this.id}] ⚠️ Name input not found; continuing`);
            }

            // Allow dynamic validation overlays to settle (optimized)
            await this.page.waitForTimeout(300);
            // Final verification loop (UI can sometimes revert the name) up to 3 attempts
            for (let i = 0; i < 3 && nameInputFound; i++) {
                const nameOk = await this.page.evaluate((expected) => {
                    const inputs = [...document.querySelectorAll('input')];
                    return inputs.some(inp => inp.value.trim() === expected);
                }, this.botName);
                if (nameOk) break;
                // Re-type if needed
                for (const sel of nameSelectors) {
                    const exists = await this.page.$(sel);
                    if (exists) {
                        await this.page.click(sel, { clickCount: 3 }).catch(()=>{});
                        await this.page.keyboard.press('Backspace');
                        await this.page.type(sel, this.botName, { delay: 40 });
                        break;
                    }
                }
                await this.page.waitForTimeout(200);
            }

            // Candidate XPath expressions for join/ask buttons (include variations)
            const joinXPaths = [
                "//button[.//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ask to join')]]",
                "//button[.//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join now')]]",
                "//button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ask to join')]",
                "//button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join now')]"
            ];

            // Attempt clicking with retries + optimized backoff
            const maxAttempts = 5;
            let attempt = 0;
            let joined = false;
            while (attempt < maxAttempts && !joined) {
                attempt++;
                for (const xp of joinXPaths) {
                    try {
                        const btns = await this.page.$x(xp);
                        if (!btns.length) continue;
                        const btn = btns[0];
                        const box = await btn.boundingBox();
                        if (!box) continue; // not visible yet
                        // Ensure enabled (no aria-disabled)
                        const disabled = await this.page.evaluate(el => el.getAttribute('aria-disabled') === 'true', btn);
                        if (disabled) continue;
                        await btn.hover();
                        await this.page.waitForTimeout(50);
                        await btn.click({ delay: 20 });
                        joined = true;
                        break;
                    } catch (e) {
                        // try next xpath
                        continue;
                    }
                }
                if (!joined) {
                    // Try pressing Enter as a fallback (often triggers default action)
                    await this.page.keyboard.press('Enter');
                    await this.page.waitForTimeout(400);
                    // Check if we are in-call (leave button present) then treat as joined
                    const inCall = await this.page.$('button[aria-label*="Leave call"], button[aria-label*="End call"]');
                    if (inCall) {
                        joined = true;
                        break;
                    }
                    await this.page.waitForTimeout(attempt * 200); // optimized backoff
                }
            }

            if (!joined) {
                await this.page.screenshot({ path: `error_join_${this.id}.png` });
                throw new Error('Could not find or click join button after retries');
            }

            console.log(`[${this.id}] ✅ Join request sent / joined (attempt ${attempt})`);

        } catch (error) {
            await this.page.screenshot({ path: `error_join_${this.id}.png` });
            console.error(`[${this.id}] Screenshot saved: error_join_${this.id}.png`);
            throw error;
        }
    }

    /**
     * Wait for organizer to admit the bot (GoogleMeetBot enhanced)
     */
    async waitForAdmission() {
        console.log(`[${this.id}] ⏳ Waiting for admission...`);
        
        const wanderingTime = 300000; // 5 minutes
        const start = Date.now();
        
        while (Date.now() - start < wanderingTime) {
            try {
                // Check for lobby/denial states
                const lobbyStatus = await this.page.evaluate((constants) => {
                    const bodyText = document.body.innerText || '';
                    
                    if (bodyText.includes(constants.DENIED)) {
                        return 'DENIED';
                    }
                    if (bodyText.includes(constants.TIMEOUT)) {
                        return 'TIMEOUT';
                    }
                    if (bodyText.includes(constants.NO_RESPONSE)) {
                        return 'NO_RESPONSE';
                    }
                    if (bodyText.includes(constants.WAITING)) {
                        return 'WAITING';
                    }
                    
                    // Check if admitted (Leave button present)
                    const leaveBtn = document.querySelector('button[aria-label*="Leave call"], button[aria-label*="End call"]');
                    if (leaveBtn) {
                        return 'ADMITTED';
                    }
                    
                    return 'UNKNOWN';
                }, {
                    DENIED: GOOGLE_REQUEST_DENIED,
                    TIMEOUT: GOOGLE_REQUEST_TIMEOUT,
                    NO_RESPONSE: GOOGLE_NO_RESPONSE,
                    WAITING: GOOGLE_LOBBY_MODE_HOST_TEXT
                });
                
                if (lobbyStatus === 'DENIED' || lobbyStatus === 'TIMEOUT' || lobbyStatus === 'NO_RESPONSE') {
                    throw new Error(`Bot admission ${lobbyStatus}: Request was denied or timed out`);
                }
                
                if (lobbyStatus === 'WAITING') {
                    console.log(`[${this.id}] 🚪 Waiting in lobby for host to admit...`);
                    await this.page.waitForTimeout(2000);
                    continue;
                }
                
                if (lobbyStatus === 'ADMITTED') {
                    // Mark admitted and clear any stale pre-admission tracks
                    try {
                        await this.page.evaluate(() => { 
                            window.__admittedSettle = true; 
                            if (typeof window.__resetMeetingState === 'function') window.__resetMeetingState(); 
                        });
                    } catch {}
                    // Brief grace period for real remote media to flow (optimized for speed)
                    await this.page.waitForTimeout(500);
                    console.log(`[${this.id}] ✅ Admitted to meeting & state reset`);

                    // Inject bot logo overlay if logo URL is provided
                    // if (this.botLogoUrl) {
                    //     await this.injectBotLogo();
                    // }

                    // Dismiss any blocking onboarding/self-view modals (e.g. "Others may see your video differently")
                    return;
                }
                
                // Unknown state, wait and retry
                await this.page.waitForTimeout(2000);
            } catch (error) {
                if (error.message.includes('admission')) {
                    throw error;
                }
                // Continue waiting on transient errors
            }
        }
        
        throw new Error('Admission timeout: Bot was not admitted within 5 minutes');
    }

    /**
     * Best-effort dismissal of blocking modals (e.g. "Got it", self-view tips)
     * that can appear immediately after admission and block UI interactions.
     */
    async dismissInitialModals(maxRounds = 3) {
        console.log(`[${this.id}] 🔔 Dismissing initial modals if present...`);
        for (let i = 0; i < maxRounds; i++) {
            await this.page.keyboard.press('Escape').catch(() => {});
            await this.page.waitForTimeout(50);
        }
    }

    /**
     * Wait until there is at least one other participant in the room
     */
    async waitForOtherParticipants(timeoutMs = 120000) {
        console.log(`[${this.id}] 👀 Waiting for remote participant media...`);
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                // Skip counting remote tracks until admitted
                const admitted = await this.page.evaluate(() => !!document.querySelector('button[aria-label*="Leave call"], button[aria-label*="End call"]'));
                if (!admitted) {
                    await this.page.waitForTimeout(1000);
                    console.log(`[${this.id}] 🚪 Waiting in lobby for host to admit...`);
                    continue;
                }
                // Prefer presence of remote tracks (most reliable for actual media)
                const hasRemote = await this.page.evaluate(() => {
                    return Array.isArray(window.__meetingTracks) && window.__meetingTracks.some(t => t.type === 'remote' && t.track.readyState === 'live');
                });
                if (hasRemote) {
                    console.log(`[${this.id}] 🎬 Remote media detected`);
                    return true;
                }

                // Fallback: check participant count (DOM-based)
                const count = await this.getParticipantCount();
                console.log(`[${this.id}] 👥 Fallback participant count: ${count}`);
                if (count >= 2) return true;

            } catch (e) {
                // ignore transient errors
            }
            await this.page.waitForTimeout(2000);
        }
        return false;
    }

    async getParticipantCount() {
        // Do NOT open/close the People panel here; rely on media-backed data first for stability
        return await this.page.evaluate(() => {
            const inCall = !!document.querySelector('button[aria-label*="Leave call"], button[aria-label*="End call"]');
            if (!inCall) return 1;

            // 1) Primary: count remote participants from WebRTC state (set by our interceptor)
            let remoteCount = 0;
            try {
                const now = Date.now();
                if (window.__remoteParticipants instanceof Map) {
                    window.__remoteParticipants.forEach(p => {
                        try {
                            const hasTracks = p && p.tracks && p.tracks.size > 0;
                            const fresh = typeof p.lastSeen === 'number' ? (now - p.lastSeen) < 10000 : true; // fresh within 10s
                            if (hasTracks && fresh) remoteCount++;
                        } catch {}
                    });
                } else if (Array.isArray(window.__meetingTracks)) {
                    const ids = new Set();
                    for (const t of window.__meetingTracks) {
                        try { 
                            if (t && t.type === 'remote' && t.track && t.track.readyState === 'live') {
                                ids.add(t.participantId || t.peerId || t.id || `${Math.random()}`);
                            }
                        } catch {}
                    }
                    remoteCount = ids.size;
                }
            } catch {}

            // Include the bot itself in the total (log messages say "including bot")
            let stableTotal = (remoteCount || 0) + 1;

            // 2) Secondary: parse any visible UI number WITHOUT forcing panel open
            const extractInt = (s) => {
                if (!s) return null;
                const m = String(s).match(/\b(\d{1,4})\b/);
                return m ? parseInt(m[1], 10) : null;
            };

            let uiNum = null;
            try {
                // Toolbar/controls often expose a People/Participants button with a count in aria-label
                const btns = Array.from(document.querySelectorAll('button[aria-label], div[aria-label]'));
                for (const b of btns) {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (!label) continue;
                    if (label.includes('people') || label.includes('participants') || label.includes('everyone')) {
                        const n = extractInt(label);
                        if (typeof n === 'number' && n > 0) { uiNum = n; break; }
                    }
                }

                // If the side panel happens to be open, try to read its header as well
                if (uiNum == null) {
                    const panel = document.querySelector('aside[role="complementary"], div[role="dialog"]');
                    if (panel) {
                        // New UIs: headers can be like "People (3)" or "Contributors 3"
                        const headers = Array.from(panel.querySelectorAll('div,span,h2,h3')); 
                        for (const el of headers) {
                            const t = (el.textContent || '').trim();
                            if (!t) continue;
                            if (/people|participants|everyone|contributors/i.test(t)) {
                                // Prefer explicit parens, else any nearby number
                                let n = null;
                                const paren = t.match(/\((\d+)\)/);
                                if (paren && paren[1]) n = parseInt(paren[1], 10);
                                if (n == null) n = extractInt(t);
                                if (n == null && el.nextElementSibling) n = extractInt(el.nextElementSibling.textContent);
                                if (typeof n === 'number' && n > 0) { uiNum = n; break; }
                            }
                        }
                    }
                }
            } catch {}

            // Choose the higher of the two to avoid undercount when UI/data lags
            if (typeof uiNum === 'number' && uiNum > stableTotal) return uiNum;
            return stableTotal > 0 ? stableTotal : 1;
        });
    }

    /**
     * Detect other bot-like participants using a combination of heuristics:
     * - configurable text identifiers (env BOT_IDENTIFIERS)
     * - configurable image domain tokens (env BOT_IMAGE_DOMAINS)
     * - look for 'recording'/'rec' indicators inside tile text
     * Returns { botCount, humanCount, details }
     */
    async detectOtherBots() {
        if (!this.page || (this.page.isClosed && this.page.isClosed())) return { botCount: 0, humanCount: 0, details: [] };

        const envList = process.env.BOT_IDENTIFIERS || '';
        const envImgList = process.env.BOT_IMAGE_DOMAINS || '';
        const extras = envList.split(',').map(s => s.trim()).filter(Boolean);
        const imgExtras = envImgList.split(',').map(s => s.trim()).filter(Boolean);

        // Defaults that catch common recording bots/platforms. Can be extended via env vars.
        // Add common third-party bot names (Recall, Fireflies, Meetingbase, Notetaker, etc.) and a generic 'ai' token.
        const identifiers = ['recall', 'fireflies', 'otter', 'meetgeek', 'meetbot', 'meetingbase', 'notetaker', 'record', 'recording', 'bot', ...extras];
        const imageDomains = ['recall.ai', 'fireflies.ai', 'otter.ai', 'meetgeek.ai', 'meetingbase', 'notetaker', 'tactiq.io', ...imgExtras];

        try {
            const result = await this.page.evaluate((ids, imgDomains, selfName) => {
                const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const idRegexes = ids.map(i => new RegExp(esc(i), 'i'));
                const imgRegexes = imgDomains.map(d => new RegExp(esc(d), 'i'));

                // Conservative selectors: prefer explicit participant containers and data attributes
                const tileSelectors = ['div[data-participant-id]', 'div[jsname="BOHaEe"]', '[data-self-name]'];
                const tiles = new Set();
                for (const sel of tileSelectors) {
                    try { document.querySelectorAll(sel).forEach(n => tiles.add(n)); } catch {}
                }

                // UI blacklist tokens (common Meet UI strings that should not be treated as participants)
                const UI_BLACKLIST = ['reframe', 'backgrounds', 'effects', 'more options', 'meeting language', 'font size', 'font color', 'open caption', 'caption settings', 'english', 'apply', 'cancel', 'settings', 'present now', 'raise hand', 'participants', 'people', 'chat', 'translate', 'leave call'];

                let botCount = 0, humanCount = 0;
                const details = [];
                const seenParticipantIds = new Set(); // Deduplicate by participant ID
                const seenNames = new Set(); // Deduplicate by name as fallback

                for (const tile of Array.from(tiles)) {
                    try {
                        // Ignore non-visible tiles
                        if (tile.offsetParent === null) continue;

                        // Ignore tiles that are clearly part of UI menus/dialogs
                        let role = '';
                        try { role = (tile.getAttribute && tile.getAttribute('role')) || ''; } catch {}
                        if (role && /menu|dialog|presentation|toolbar/i.test(role)) continue;

                        // Require a participant identity signal: data-participant-id OR presence of media (video/img/canvas)
                        const hasParticipantId = !!(tile.getAttribute && tile.getAttribute('data-participant-id'));
                        let hasMedia = false;
                        try {
                            if (tile.querySelector && tile.querySelector('video, img, canvas')) hasMedia = true;
                        } catch {}
                        if (!hasParticipantId && !hasMedia) {
                            // Skip generic UI tiles that lack media or participant id
                            continue;
                        }

                        // Extract participant ID for deduplication (before name extraction)
                        let participantId = '';
                        try {
                            participantId = tile.getAttribute && tile.getAttribute('data-participant-id');
                        } catch {}
                        
                        // Skip tiles that appear to be in loading/transition states
                        // Look for indicators of loading/joining states
                        let isTransitioning = false;
                        try {
                            const tileText = (tile.innerText || tile.textContent || '').toLowerCase();
                            const tileClass = (tile.className || '').toLowerCase();
                            const tileId = (tile.id || '').toLowerCase();
                            // Check for loading/joining indicators
                            if (/loading|joining|connecting|waiting|pending|spinner/i.test(tileText) ||
                                /loading|joining|connecting|waiting|pending|transition|spinner/i.test(tileClass) ||
                                /loading|joining|connecting|waiting|pending|transition|spinner/i.test(tileId) ||
                                (tile.querySelector && (tile.querySelector('[class*="loading"]') || 
                                                       tile.querySelector('[class*="joining"]') ||
                                                       tile.querySelector('[class*="spinner"]') ||
                                                       tile.querySelector('[aria-label*="loading"]') ||
                                                       tile.querySelector('[aria-label*="joining"]')))) {
                                isTransitioning = true;
                            }
                        } catch {}
                        if (isTransitioning) continue;

                        // Extract a sensible label/name from the tile
                        let label = '';
                        try { label = (tile.getAttribute && (tile.getAttribute('aria-label') || tile.getAttribute('data-self-name'))) || tile.innerText || ''; } catch {}
                        label = String(label || '').trim();
                        // If label is suspiciously long or contains many UI lines, skip it
                        const lineCount = (label.match(/\n/g) || []).length + 1;
                        if (lineCount > 4 || label.length > 240) continue;

                        // Normalize name
                        let name = label.split(/is speaking|is presenting|\(|,|–|-/i)[0].trim();
                        if (!name) name = label;

                        // Skip self
                        if (selfName && name.toLowerCase() === String(selfName).toLowerCase()) continue;

                        // Skip tiles where label matches UI blacklist tokens
                        const lower = (label || '').toLowerCase();
                        const isUiLabel = UI_BLACKLIST.some(tok => lower.includes(tok));
                        if (isUiLabel) continue;

                        // Deduplicate: Skip if we've already seen this participant ID or name
                        // This prevents counting the same participant multiple times during join animations
                        const normalizedName = name.toLowerCase().trim();
                        if (participantId && seenParticipantIds.has(participantId)) {
                            continue; // Already counted this participant ID
                        }
                        if (normalizedName && seenNames.has(normalizedName) && normalizedName.length > 2) {
                            // Only skip by name if name is meaningful (more than 2 chars) and we've seen it
                            // This handles cases where participant ID might not be available
                            continue;
                        }

                        // Inspect images inside tile for known bot image domains
                        let imgMatches = false;
                        try {
                            const imgs = Array.from(tile.querySelectorAll('img'));
                            for (const im of imgs) {
                                try {
                                    const src = im.src || im.getAttribute('src') || '';
                                    if (!src) continue;
                                    // Skip data URLs that are usually avatars or icons
                                    if (src.startsWith('data:')) continue;
                                    if (imgRegexes.some(rx => rx.test(src))) { imgMatches = true; break; }
                                } catch {}
                            }
                        } catch {}

                        const recordingIndicator = /\b(recording|rec|auto[- ]?record|transcript|ai)\b/i.test(lower);
                        const idMatch = idRegexes.some(r => r.test(name) || r.test(label));

                        const isBot = imgMatches || idMatch || recordingIndicator;
                        
                        // Mark this participant as seen (before counting)
                        if (participantId) {
                            seenParticipantIds.add(participantId);
                        }
                        if (normalizedName && normalizedName.length > 2) {
                            seenNames.add(normalizedName);
                        }
                        
                        if (isBot) {
                            botCount++;
                            details.push({ name: name || '(unknown)', label: label || '(no-label)', reason: imgMatches ? 'img' : (recordingIndicator ? 'recording-indicator' : 'text-match') });
                        } else {
                            humanCount++;
                            details.push({ name: name || '(unknown)', label: label || '(no-label)', reason: 'text-suspect-human' });
                        }
                    } catch (e) {
                        // ignore per-tile errors
                    }
                }

                return { botCount, humanCount, details };
            }, identifiers, imageDomains, this.botName || '');

            return result;
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ detectOtherBots failed: ${e && e.message ? e.message : e}`);
            return { botCount: 0, humanCount: 0, details: [] };
        }
    }

    /**
     * Extract meeting id from a Google Meet URL.
     */
    getMeetingIdFromUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url);
            // Path may be like /abc-defg-hij or /_/some/path
            const parts = u.pathname.split('/').filter(Boolean);
            // Google Meet IDs commonly look like xxxx-xxxx-xxx or a UUID-like token
            for (const p of parts) {
                if (/^[a-z0-9-]{6,}$/i.test(p)) return p;
                // fallback: return first non-empty path segment
                return p;
            }
        } catch (e) {}
        return null;
    }
    /**
     * Configure Google Meet layout at start of meeting.
     * 
     * Current behaviour:
     * - Open "More options" menu
     * - Open "Adjust view" / "Change layout" dialog if present
     * - Select the "Sidebar" layout so the main speaker is large and others are
     *   on the side (matches your screenshots)
     */
    async ensureTiledLayout() {
        try {
            console.log(`[${this.id}] 🎛️ Configuring layout to Tiled...`);

            // 1) Click the "More options" button in the bottom bar
            const moreClicked = await this.page.evaluate(async () => {
                try {
                    const btns = Array.from(document.querySelectorAll('button[aria-label]'));
                    const cand = btns.find((b) => {
                        const label = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                        // We only want the bottom-bar menu, NOT "More options for <name>" on participant tiles
                        return label === 'more options';
                    });
                    if (!cand) return false;
                    await cand.click({ delay: 50 }).catch(()=>{});
                    return true;
                } catch {
                    return false;
                }
            });

            if (!moreClicked) {
                console.warn(`[${this.id}] ⚠️ Unable to find "More options" button for layout configuration`);
                return;
            }

            await this.page.waitForTimeout(300);         // give the iframe time to mount (optimized)
            try {
                await this.page.keyboard.press('ArrowDown');
                await this.page.keyboard.press('Space');
            } catch {}

            await this.page.waitForTimeout(300);         // give the iframe time to mount (optimized)
            let layoutSelected = false;
            try {
                await this.page.keyboard.press('Tab');
                for (let i = 0; i < 2; i++) {
                    await this.page.keyboard.press('ArrowDown');
                }
                await this.page.keyboard.down('Enter');
                await this.page.keyboard.up('Enter');
                layoutSelected = true; 
            } catch {}
            if (!layoutSelected) {
                console.warn(`[${this.id}] ⚠️ Could not find "Tiled" option in Adjust view dialog`);
            } else {
                console.log(`[${this.id}] ✅ Tiled layout selected`);
            }
            // 4) Best-effort close dialog/menu
            await this.page.keyboard.press('Escape').catch(() => {});
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Failed to configure layout: ${e.message}`);
        }
    }

    /**
     * Mute mic & camera using IN-CALL controls after admission
     */
    async muteInCall() {
        try {
            console.log(`[${this.id}] 🔇 Muting in-call mic and camera...`);
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyD'); // toggle mic
            await this.page.keyboard.press('KeyE'); // toggle camera
            await this.page.keyboard.up('Control');
            await this.page.waitForTimeout(500);
            const recheck = await this.page.evaluate(() => {
                const res = { audioOff: false, videoOff: false };
                const btns = Array.from(document.querySelectorAll('button[aria-label]'));
                for (const b of btns) {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (label.includes('turn on microphone') || label.includes('unmute microphone')) res.audioOff = true;
                    if (label.includes('turn on camera') || label.includes('turn on video')) res.videoOff = true;
                }
                return res;
            });
            if (recheck.audioOff && recheck.videoOff) {
                console.log(`[${this.id}] ✅ Mic & camera muted via Keyboard shortcuts`);
            }
            else{
                const micSelectors = [
                    'button[aria-label="Turn off microphone"]',
                    'button[aria-label*="Turn off"][aria-label*="microphone"]',
                    'button[aria-label*="Turn off"][aria-label*="Mic"]'
                ];
                const camSelectors = [
                    'button[aria-label="Turn off camera"]',
                    'button[aria-label*="Turn off"][aria-label*="camera"]',
                    'button[aria-label*="Turn off"][aria-label*="video"]'
                ];
                for (const sel of micSelectors) {
                    const btn = await this.page.$(sel);
                    if (btn) { await btn.click().catch(()=>{}); break; }
                }
                for (const sel of camSelectors) {
                    const btn = await this.page.$(sel);
                    if (btn) { await btn.click().catch(()=>{}); break; }
                }
            }
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not mute in-call (non-critical): ${e.message}`);
        }
    }

    /**
     * Start browser-based recording using MediaRecorder API (GoogleMeetBot style)
     */
    async startRecording() {
        console.log(`[${this.id}] 🎥 Starting MediaRecorder browser recording...`);

        if (this.isCapturing) {
            console.log(`[${this.id}] Recording already started.`);
            return;
        }

        this.recordingStartedAt = Date.now();
        const startTimestamp = getCurrentTimestamp();
        this.meetingStartTime = startTimestamp.iso;
        this.meetingStartTimeFormatted = startTimestamp.formatted;
        console.log(`[${this.id}] 📅 Meeting started at: ${startTimestamp.formatted} (${startTimestamp.timezone})`);

        // Chunk writing with retry mechanism (GoogleMeetBot style)
        const writeChunkWithRetry = async (buffer, retries = 3) => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    await fs.promises.appendFile(this.recordingPath, buffer);
                    return true;
                } catch (error) {
                    console.error(`[${this.id}] ❌ Chunk write failed (attempt ${attempt}/${retries}):`, error.message);
                    if (attempt === retries) {
                        try {
                            await this.emitError('file_write_error', 'Failed to write recording chunk after retries', { path: this.recordingPath, attempt, error: error && error.message ? error.message : String(error) });
                        } catch (err) {}
                        throw error;
                    }
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }
            return false;
        };
        
        // Expose function for receiving recording chunks from browser
        await this.page.exposeFunction('screenAppSendData', async (slightlySecretId, data) => {
            if (slightlySecretId !== this.slightlySecretId) return;

            try {
                const buffer = Buffer.from(data, 'base64');
                // Write chunk with retry mechanism
                await writeChunkWithRetry(buffer);
            } catch (error) {
                console.error(`[${this.id}] ❌ Error saving chunk after retries:`, error.message);
                // Log additional context for debugging
                console.error(`[${this.id}] 🔍 Chunk data length: ${data ? data.length : 'null'}`);
                console.error(`[${this.id}] 🔍 Buffer creation failed:`, error.stack);
                try {
                    await this.emitError('file_write_error', 'Error saving recording chunk', { path: this.recordingPath, error: error && error.message ? error.message : String(error) });
                } catch (err) {}
            }
        });

        // Expose function for meeting end signal from browser
        await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId) => {
            if (slightlySecretId !== this.slightlySecretId) return;
            try {
                console.log(`[${this.id}] 🏁 Meeting end signal received from browser`);
                this.leaveMeet();
            } catch (error) {
                console.error(`[${this.id}] ❌ Error processing meeting end:`, error.message);
                try { this.emitError && this.emitError('recording_error', 'Error processing meeting end', { error: error && error.message ? error.message : String(error) }); } catch (e) {}
            }
        });

        // Inject recording code into browser context
        await this.page.evaluate(
            async ({ botId, duration, inactivityLimit, slightlySecretId, activateInactivityAfterMinutes, recordingType }) => {
                const durationMs = duration * 60 * 1000;
                const inactivityLimitMs = inactivityLimit * 60 * 1000;
                
                let timeoutId;
                let inactivityParticipantTimeout;
                let pageValidityInterval;
                let modalDismissInterval;

                const sendChunkToServer = async (chunk) => {
                    try {
                        function arrayBufferToBase64(buffer) {
                            let binary = '';
                            const bytes = new Uint8Array(buffer);
                            for (let i = 0; i < bytes.byteLength; i++) {
                                binary += String.fromCharCode(bytes[i]);
                            }
                            return btoa(binary);
                        }
                        const base64 = arrayBufferToBase64(chunk);
                        await window.screenAppSendData(slightlySecretId, base64);
                    } catch (error) {
                        console.error('[Browser] ❌ Error sending chunk:', error);
                        throw error; // Re-throw to be caught by caller
                    }
                };

                async function startRecording() {
                    const isAudioOnly = recordingType === 'audio-only';
                    console.log(`[Browser] Starting MediaRecorder capture at ${new Date().toISOString()}`);
                    console.log(`[Browser] Recording type: ${recordingType} (${isAudioOnly ? 'Audio Only' : 'Audio + Video'})`);
                    console.log(`[Browser] Inactivity detection activates after ${activateInactivityAfterMinutes} minutes`);

                    // Check for mediaDevices API
                    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                        console.error('[Browser] MediaDevices or getDisplayMedia not supported');
                        return;
                    }

                    // Configure getDisplayMedia based on recording type
                    // Note: getDisplayMedia requires video to be requested, even for audio-only recording
                    // We'll request video and then remove video tracks if audio-only
                    const getDisplayMediaOptions = {
                        // Always request video (required by getDisplayMedia API)
                        video: true,
                        // Request tab/system audio as aggressively as Chrome allows.
                        // On modern Chrome this hints that we want the tab's own audio
                        // (other participants) in addition to microphone if available.
                        audio: {
                            autoGainControl: false,
                            channels: 2,
                            channelCount: 2,
                            echoCancellation: false,
                            noiseSuppression: false,
                            // Non-standard but supported in recent Chrome: try to include system/tab audio
                            // where policy allows it. Browsers that don't know this key will ignore it.
                            systemAudio: 'include'
                        },
                        preferCurrentTab: true,
                    };

                    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayMediaOptions);

                    // For audio-only, remove video tracks from the stream
                    if (isAudioOnly) {
                        const videoTracks = stream.getVideoTracks();
                        videoTracks.forEach(track => {
                            track.stop();
                            stream.removeTrack(track);
                        });
                        console.log('[Browser] Removed video tracks for audio-only recording');
                    }

                    // Store stream in global for cleanup
                    window.__recordingStream = stream;

                    // Determine codec and compression settings based on recording type
                    let options = {};
                    
                    if (isAudioOnly) {
                        // Audio-only recording settings
                        const audioBitsPerSecond = 96000; // 96 kbps (sufficient for voice)
                        options.audioBitsPerSecond = audioBitsPerSecond;
                        
                        // Use audio-only codec
                        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                            console.log('[Browser] Using Opus codec for audio-only recording');
                            options.mimeType = 'audio/webm;codecs=opus';
                        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                            console.log('[Browser] Using WebM audio codec (fallback)');
                            options.mimeType = 'audio/webm';
                        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
                            console.log('[Browser] Using OGG Opus codec (fallback)');
                            options.mimeType = 'audio/ogg;codecs=opus';
                        } else {
                            console.warn('[Browser] Using default audio codec');
                        }
                        
                        console.log('[Browser] Audio bitrate: ' + (audioBitsPerSecond / 1000).toFixed(0) + ' kbps');
                    } else {
                        // Audio + Video recording settings
                        // Optimized for smaller files with good quality (VP9 is efficient)
                        // Reduced from 2.5 Mbps to 1.8 Mbps - VP9 maintains quality at lower bitrates
                        const videoBitsPerSecond = 900000; ; // 0.9 Mbps (optimized for size/quality balance)
                        const audioBitsPerSecond = 64000;    // 64 kbps (sufficient for voice)
                        
                        options.videoBitsPerSecond = videoBitsPerSecond;
                        options.audioBitsPerSecond = audioBitsPerSecond;
                        
                        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
                            console.log('[Browser] Using VP9 codec with compression');
                            options.mimeType = 'video/webm;codecs=vp9';
                        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
                            console.log('[Browser] Using VP8 codec with compression (fallback)');
                            options.mimeType = 'video/webm;codecs=vp8';
                        } else {
                            console.warn('[Browser] Using default codec with compression');
                        }
                        
                        console.log('[Browser] Video bitrate: ' + (videoBitsPerSecond / 1000000).toFixed(2) + ' Mbps, Audio: ' + (audioBitsPerSecond / 1000).toFixed(0) + ' kbps');
                    }

                    const mediaRecorder = new MediaRecorder(stream, options);
                    
                    // Store MediaRecorder in global for cleanup
                    window.__mediaRecorder = mediaRecorder;

                    let chunksReceived = 0;
                    let totalBytes = 0;

                    mediaRecorder.ondataavailable = async (event) => {
                        if (!event.data.size) {
                            console.warn('[Browser] Received empty chunk');
                            return;
                        }
                        try {
                            chunksReceived++;
                            totalBytes += event.data.size;
                            const arrayBuffer = await event.data.arrayBuffer();
                            await sendChunkToServer(arrayBuffer);
                            if (chunksReceived % 30 === 0) { // Log every 30 chunks (~1 minute)
                                console.log(`[Browser] 📊 ${chunksReceived} chunks sent, ${(totalBytes / 1024 / 1024).toFixed(2)}MB total`);
                            }
                        } catch (error) {
                            console.error('[Browser] ❌ Error sending chunk:', error);
                        }
                    };

                    mediaRecorder.onstart = () => {
                        console.log('[Browser] 🎬 MediaRecorder started recording');
                    };

                    mediaRecorder.onstop = () => {
                        console.log(`[Browser] ⏹️ MediaRecorder stopped. Total: ${chunksReceived} chunks, ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
                    };

                    mediaRecorder.onerror = (event) => {
                        console.error('[Browser] ❌ MediaRecorder error:', event.error);
                    };

                    // Start recording with 2-second chunks
                    mediaRecorder.start(2000);
                    console.log('[Browser] ✅ MediaRecorder initialized');

                    const stopRecording = async () => {
                        console.log('[Browser] 🛑 Stopping recording...');
                        
                        // Wait for MediaRecorder to properly finalize
                        const finalizePromise = new Promise((resolve) => {
                            if (mediaRecorder.state === 'inactive') {
                                resolve();
                                return;
                            }
                            
                            // Set up one-time stop handler
                            const onStopHandler = () => {
                                console.log('[Browser] 📦 MediaRecorder finalized');
                                resolve();
                            };
                            
                            mediaRecorder.addEventListener('stop', onStopHandler, { once: true });
                            
                            // Stop recording with timeout fallback
                            try {
                                mediaRecorder.stop();
                                console.log('[Browser] ⏹️ MediaRecorder stop requested');
                            } catch (e) {
                                console.error('[Browser] Error stopping MediaRecorder:', e);
                                resolve(); // Resolve anyway to prevent hanging
                            }
                            
                            // Timeout fallback (max 2 seconds)
                            setTimeout(() => {
                                console.warn('[Browser] ⚠️ MediaRecorder finalization timeout');
                                resolve();
                            }, 2000);
                        });
                        
                        // Wait for finalization
                        await finalizePromise;
                        
                        // Now stop the streams
                        try {
                            stream.getTracks().forEach(track => {
                                try { track.stop(); } catch {}
                            });
                        } catch {}

                        // Cleanup timers
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            window.__recordingTimeoutId = null;
                        }
                        if (inactivityParticipantTimeout) {
                            clearTimeout(inactivityParticipantTimeout);
                            window.__inactivityParticipantTimeout = null;
                        }
                        if (pageValidityInterval) {
                            clearInterval(pageValidityInterval);
                            window.__pageValidityInterval = null;
                        }
                        if (modalDismissInterval) {
                            clearInterval(modalDismissInterval);
                            window.__modalDismissInterval = null;
                        }

                        // Signal meeting end
                        window.screenAppMeetEnd(slightlySecretId);
                    };

                    // Modal dismissal (optimized frequency)
                    modalDismissInterval = setInterval(() => {
                        try {
                            // Look for a wider set of blocking UI elements or buttons
                            const textCandidates = ['got it', 'click allow', 'click to allow', 'allow', 'allow access', 'continue', 'ok', 'turn on captions', 'enable captions', 'accept'];

                            const clickIfMatches = (el) => {
                                try {
                                    const txt = (el.innerText || '').toLowerCase().trim();
                                    if (!txt) return false;
                                    for (const cand of textCandidates) {
                                        if (txt.includes(cand)) {
                                            try { el.click(); } catch {}
                                            console.log('[Browser] ✖️ Clicked modal button matching:', cand);
                                            return true;
                                        }
                                    }
                                } catch {}
                                return false;
                            };

                            const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
                            for (const e of els) {
                                if (e.offsetParent === null) continue;
                                if (clickIfMatches(e)) return;
                            }

                            // Remove obvious overlay containers if present
                            const overlaySelectors = ['[role="dialog"]', '.modal', '.overlay', '.caveat', '.permission', '[data-modal]'];
                            for (const sel of overlaySelectors) {
                                const nodes = Array.from(document.querySelectorAll(sel));
                                for (const n of nodes) {
                                    try {
                                        const cs = window.getComputedStyle(n);
                                        if (cs && (cs.position === 'fixed' || cs.position === 'absolute' || parseInt(cs.zIndex || '0', 10) > 1000)) {
                                            console.log('[Browser] ✖️ Removing overlay node for selector', sel);
                                            n.remove();
                                            return;
                                        }
                                    } catch (e) {}
                                }
                            }

                            // Fallback: dispatch Escape to try to close dialogs
                            try {
                                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
                                console.log('[Browser] ✖️ Dispatched Escape to dismiss possible dialogs');
                            } catch (e) {}

                        } catch (error) {
                            console.error('[Browser] Modal dismiss error:', error);
                        }
                    }, 2000);
                    
                    // Store in window global for cleanup
                    window.__modalDismissInterval = modalDismissInterval;

                    // Page validity check
                    pageValidityInterval = setInterval(() => {
                        try {
                            const url = window.location.href;
                            if (!url.includes('meet.google.com')) {
                                console.warn('[Browser] ⚠️ No longer on Meet page');
                                stopRecording();
                                return;
                            }

                            const bodyText = document.body.innerText || '';
                            if (bodyText.includes('You\'ve been removed') || bodyText.includes('No one responded')) {
                                console.warn('[Browser] ⚠️ Removed or denied');
                                stopRecording();
                                return;
                            }

                            const hasMeetUI = document.querySelector('button[aria-label*="People"]') !== null ||
                                            document.querySelector('button[aria-label*="Leave call"]') !== null;
                            if (!hasMeetUI) {
                                console.warn('[Browser] ⚠️ Meet UI not found');
                                stopRecording();
                            }
                        } catch (error) {
                            console.error('[Browser] Page validity error:', error);
                        }
                    }, 10000);
                    
                    // Store in window global for cleanup
                    window.__pageValidityInterval = pageValidityInterval;

                    // Max duration timeout
                    timeoutId = setTimeout(() => {
                        console.log('[Browser] ⏱️ Max duration reached');
                        stopRecording();
                    }, durationMs);
                    
                    // Store in window global for cleanup
                    window.__recordingTimeoutId = timeoutId;
                }

                // Start recording
                await startRecording();
            },
            {
                botId: this.id,
                duration: this.maxRecordingDuration,
                inactivityLimit: this.inactivityLimit,
                slightlySecretId: this.slightlySecretId,
                activateInactivityAfterMinutes: this.activateInactivityAfter,
                recordingType: this.recordingType || 'audio-video'
            }
        );

        this.isCapturing = true;
        console.log(`[${this.id}] ✅ Recording started (max ${this.maxRecordingDuration}min, inactivity after ${this.activateInactivityAfter}min)`);
    }

    /**
     * Hide bot's self view from the recording
     */
    async hideSelfView() {
        try {
            console.log(`[${this.id}] 👤 Hiding self view via CSS...`);

            await this.page.evaluate((botName) => {
                try {
                    const style = document.createElement('style');
                    style.textContent = `
                        /* By explicit bot name if present on the tile */
                        [data-self-name*="${botName}"],
                        [aria-label*="${botName}" i],
                        /* Generic self-view labels commonly used by Meet */
                        [aria-label*="you" i],
                        [aria-label*="your video" i],
                        [aria-label*="self view" i] {
                            display: none !important;
                        }
                    `;
                    document.head.appendChild(style);
                } catch {
                    // Ignore failures; self view visibility is non-critical
                }
            }, this.botName || '');

            console.log(`[${this.id}] ✅ Self view hidden`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not hide self view`);
        }
    }

    /**
     * Inject bot logo overlay on the bot's video tile in Google Meet
     */
    async injectBotLogo() {
        if (!this.botLogoUrl || !this.page) {
            return;
        }

        try {
            console.log(`[${this.id}] 🖼️ Injecting bot logo: ${this.botLogoUrl}`);

            await this.page.evaluate((logoUrl, botName) => {
                try {
                    // Remove any existing logo overlay
                    const existingOverlay = document.getElementById('cxflow-bot-logo-overlay');
                    if (existingOverlay) {
                        existingOverlay.remove();
                    }

                    // Create logo overlay styles
                    const style = document.createElement('style');
                    style.id = 'cxflow-bot-logo-styles';
                    style.textContent = `
                        #cxflow-bot-logo-overlay {
                            position: absolute;
                            top: 8px;
                            left: 8px;
                            width: 48px;
                            height: 48px;
                            border-radius: 50%;
                            border: 2px solid rgba(255, 255, 255, 0.9);
                            background: white;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            z-index: 10000;
                            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                            overflow: hidden;
                            pointer-events: none;
                        }
                        #cxflow-bot-logo-overlay img {
                            width: 100%;
                            height: 100%;
                            object-fit: cover;
                        }
                    `;
                    if (!document.getElementById('cxflow-bot-logo-styles')) {
                        document.head.appendChild(style);
                    }

                    // Function to find and attach logo to bot's video tile
                    const attachLogoToBotTile = () => {
                        // Try multiple selectors to find the bot's self-view tile
                        const selectors = [
                            '[data-self-name]',
                            '[aria-label*="you" i]',
                            '[aria-label*="your video" i]',
                            '[aria-label*="self view" i]',
                            'div[jsname="BOHaEe"]', // Common Meet tile container
                            'div[data-participant-id]'
                        ];

                        let botTile = null;
                        for (const selector of selectors) {
                            const tiles = Array.from(document.querySelectorAll(selector));
                            // Find the tile that contains video or is the self-view
                            botTile = tiles.find(tile => {
                                const hasVideo = tile.querySelector('video') || 
                                                tile.querySelector('[jsname="BOHaEe"]') ||
                                                tile.getAttribute('aria-label')?.toLowerCase().includes('you') ||
                                                tile.getAttribute('aria-label')?.toLowerCase().includes('your');
                                return hasVideo && tile.offsetParent !== null;
                            });
                            if (botTile) break;
                        }

                        // Fallback: find any video tile that might be the bot's
                        if (!botTile) {
                            const allTiles = Array.from(document.querySelectorAll('div[jsname="BOHaEe"], div[data-participant-id]'));
                            botTile = allTiles.find(tile => {
                                const video = tile.querySelector('video');
                                return video && tile.offsetParent !== null;
                            });
                        }

                        if (botTile) {
                            // Ensure the tile has position: relative for absolute positioning
                            const computedStyle = window.getComputedStyle(botTile);
                            if (computedStyle.position === 'static') {
                                botTile.style.position = 'relative';
                            }

                            // Create overlay element
                            const overlay = document.createElement('div');
                            overlay.id = 'cxflow-bot-logo-overlay';
                            overlay.style.position = 'absolute';
                            overlay.style.borderRadius = '50%';
                            overlay.style.overflow = 'hidden';
                            overlay.style.pointerEvents = 'none';
                            overlay.style.display = 'flex';
                            overlay.style.alignItems = 'center';
                            overlay.style.justifyContent = 'center';
                            overlay.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
                            overlay.style.border = '2px solid rgba(255,255,255,0.9)';
                            overlay.style.background = 'white';
                            overlay.style.zIndex = '10000';

                            const img = document.createElement('img');
                            img.src = logoUrl;
                            img.alt = botName || 'Bot Logo';
                            img.style.width = '100%';
                            img.style.height = '100%';
                            img.style.objectFit = 'cover';
                            img.onerror = () => {
                                console.warn('[CXFlow] Failed to load bot logo image');
                                overlay.style.display = 'none';
                            };
                            overlay.appendChild(img);

                            // Heuristic: try to find avatar (circular initial) inside the tile
                            const findAvatar = (tile) => {
                                try {
                                    // common candidates
                                    const sel = ['img', 'svg', '[role="img"]', 'div'];
                                    for (const s of sel) {
                                        const nodes = Array.from(tile.querySelectorAll(s));
                                        for (const n of nodes) {
                                            try {
                                                if (n.offsetParent === null) continue;
                                                const r = n.getBoundingClientRect();
                                                if (r.width < 6 || r.height < 6) continue;
                                                // roughly square
                                                const ratio = Math.max(r.width / r.height, r.height / r.width);
                                                if (ratio > 1.6) continue;
                                                const txt = (n.innerText || '').trim();
                                                if ((txt.length > 0 && txt.length <= 3 && /^[A-Za-z]{1,3}$/.test(txt)) || n.tagName.toLowerCase() === 'img' || n.tagName.toLowerCase() === 'svg') {
                                                    return n;
                                                }
                                                const cs = window.getComputedStyle(n);
                                                if (cs && cs.borderRadius && cs.borderRadius.indexOf('%') !== -1 && parseFloat(cs.borderRadius) >= 30) return n;
                                            } catch {}
                                        }
                                    }
                                } catch {}
                                return null;
                            };

                            const avatar = findAvatar(botTile);
                            // Default overlay size
                            let size = 48;
                            let left = 8;
                            let top = 8;

                            if (avatar) {
                                try {
                                    const tileRect = botTile.getBoundingClientRect();
                                    const aRect = avatar.getBoundingClientRect();
                                    const relLeft = aRect.left - tileRect.left;
                                    const relTop = aRect.top - tileRect.top;
                                    size = Math.min(64, Math.max(24, Math.min(aRect.width, aRect.height)));
                                    left = Math.max(0, relLeft + (aRect.width - size) / 2);
                                    top = Math.max(0, relTop + (aRect.height - size) / 2);
                                } catch (e) {
                                    // fallback to defaults
                                }
                            }

                            overlay.style.width = `${size}px`;
                            overlay.style.height = `${size}px`;
                            overlay.style.left = `${left}px`;
                            overlay.style.top = `${top}px`;

                            botTile.appendChild(overlay);
                            return true;
                        }
                        return false;
                    };

                    // Try to attach immediately
                    if (!attachLogoToBotTile()) {
                        // If not found, wait for video tiles to appear and retry
                        const observer = new MutationObserver(() => {
                            if (attachLogoToBotTile()) {
                                observer.disconnect();
                            }
                        });

                        observer.observe(document.body, {
                            childList: true,
                            subtree: true
                        });

                        // Stop observing after 10 seconds
                        setTimeout(() => observer.disconnect(), 10000);
                    }
                } catch (error) {
                    console.warn('[CXFlow] Error injecting bot logo:', error);
                }
            }, this.botLogoUrl, this.botName || 'Bot');

            console.log(`[${this.id}] ✅ Bot logo injection initiated`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not inject bot logo:`, e.message);
        }
    }

    /**
     * Perpetual modal dismissal (GoogleMeetBot style)
     * Continuously checks for and dismisses "Got it" modals during recording
     */
    startModalDismissal() {
        console.log(`[${this.id}] 🔔 Starting perpetual modal dismissal...`);
        
        let dismissCount = 0;
        let errorCount = 0;
        const maxErrors = 10;

        this.modalDismissInterval = setInterval(async () => {
            try {
                const dismissed = await this.page.evaluate(() => {
                    try {
                        const textCandidates = ['got it', 'click allow', 'click to allow', 'allow', 'allow access', 'continue', 'ok', 'turn on captions', 'enable captions', 'accept'];

                        const clickIfMatches = (el) => {
                            try {
                                const txt = (el.innerText || '').toLowerCase().trim();
                                if (!txt) return false;
                                for (const cand of textCandidates) {
                                    if (txt.includes(cand)) {
                                        try { el.click(); } catch {}
                                        return true;
                                    }
                                }
                            } catch {}
                            return false;
                        };

                        const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
                        for (const e of els) {
                            if (e.offsetParent === null) continue;
                            if (clickIfMatches(e)) return true;
                        }

                        const overlaySelectors = ['[role="dialog"]', '.modal', '.overlay', '.caveat', '.permission', '[data-modal]'];
                        for (const sel of overlaySelectors) {
                            const nodes = Array.from(document.querySelectorAll(sel));
                            for (const n of nodes) {
                                try {
                                    const cs = window.getComputedStyle(n);
                                    if (cs && (cs.position === 'fixed' || cs.position === 'absolute' || parseInt(cs.zIndex || '0', 10) > 1000)) {
                                        console.log('[Browser] ✖️ Removing overlay node for selector', sel);
                                        n.remove();
                                        return;
                                    }
                                } catch (e) {}
                            }
                        }

                        // 👉 2b) *Specifically* remove the "Click Allow" helper card if it exists.
                        try {
                            const blocks = Array.from(document.querySelectorAll('div, section, article'));
                            for (const node of blocks) {
                                const txt = (node.innerText || '').toLowerCase();
                                if (!txt) continue;

                                if (txt.includes('click allow') && txt.includes('microphone anytime in the meeting')) {
                                    console.log('[Browser] ✖️ Removing "Click Allow" helper card');
                                    node.remove();
                                    return;
                                }
                            }
                        } catch (e) {}

                        // Fallback: send Escape
                        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch {}
                        return false;
                    } catch {
                        return false;
                    }
                });
                
                if (dismissed) {
                    dismissCount++;
                    console.log(`[${this.id}] ✖️ Dismissed "Got it" modal #${dismissCount}`);
                }
                
                errorCount = 0; // Reset on success
            } catch (error) {
                errorCount++;
                if (errorCount >= maxErrors) {
                    console.error(`[${this.id}] ❌ Too many modal dismissal errors (${maxErrors}), stopping...`);
                    this.stopModalDismissal();
                }
            }
        }, 3000); // Optimized frequency
    }

    /**
     * Stop modal dismissal interval
     */
    stopModalDismissal() {
        if (this.modalDismissInterval) {
            clearInterval(this.modalDismissInterval);
            this.modalDismissInterval = null;
        }
    }

    /**
     * Page validity check (GoogleMeetBot style)
     * Ensures bot is still on a valid Google Meet page during recording
     */
    startPageValidityCheck() {
        console.log(`[${this.id}] 🔍 Starting page validity monitoring...`);
        
        this.pageValidityInterval = setInterval(async () => {
            try {
                // If page/browser already closed, stop monitoring
                if (!this.page || (this.page.isClosed && this.page.isClosed())) {
                    this.stopPageValidityCheck();
                    return;
                }

                const isValid = await this.page.evaluate((constants) => {
                    try {
                        // Check URL
                        const currentUrl = window.location.href;
                        if (!currentUrl.includes('meet.google.com')) {
                            return { valid: false, reason: `URL changed to: ${currentUrl}` };
                        }

                        const bodyText = document.body.innerText || '';

                        // Check for removal/kicked messages
                        if (bodyText.includes(constants.REMOVED)) {
                            return { valid: false, reason: 'Bot was removed from the meeting' };
                        }

                        if (bodyText.includes(constants.NO_RESPONSE)) {
                            return { valid: false, reason: 'Bot was not admitted to the meeting' };
                        }

                        // Check for basic Meet UI elements
                        const hasMeetElements = document.querySelector('button[aria-label*="People"]') !== null ||
                                              document.querySelector('button[aria-label*="Leave call"]') !== null;

                        if (!hasMeetElements) {
                            return { valid: false, reason: 'Google Meet UI elements not found' };
                        }

                        return { valid: true, reason: null };
                    } catch (error) {
                        return { valid: false, reason: `Check error: ${error.message}` };
                    }
                }, {
                    REMOVED: GOOGLE_REMOVED_FROM_MEETING,
                    NO_RESPONSE: GOOGLE_NO_RESPONSE
                });

                if (!isValid.valid) {
                    console.warn(`[${this.id}] ⚠️ Page validity check failed: ${isValid.reason}`);
                    console.log(`[${this.id}] 🚪 Ending recording due to invalid page state`);
                    this.leaveMeet();
                }
            } catch (error) {
                // If target is already closed, quietly stop monitoring to avoid noisy logs
                if (error && typeof error.message === 'string' && error.message.includes('Target closed')) {
                    this.stopPageValidityCheck();
                    return;
                }
                console.error(`[${this.id}] ❌ Page validity check error:`, error.message);
            }
        }, 10000); // Check every 10 seconds
    }

    /**
     * Stop page validity check interval
     */
    stopPageValidityCheck() {
        if (this.pageValidityInterval) {
            clearInterval(this.pageValidityInterval);
            this.pageValidityInterval = null;
        }
    }

    /**
     * Get meeting host from participant panel
     * @returns {Promise<string|null>} Host name or null if not found
     */
    async getMeetingHost() {
        // Prefer extension-published value (localStorage) to avoid toggling People panel
        if (!this.page || (this.page.isClosed && this.page.isClosed())) return null;

        try {
            const { meetingHost } = await this.fetchTranscriptFromPage();
            const hostName = meetingHost || null;
            if (hostName && hostName !== this.meetingHost) {
                this.meetingHost = hostName;
                console.log(`[${this.id}] 👑 Meeting host captured from extension: ${hostName}`);
            }
            return hostName;
        } catch (error) {
            // Silently handle errors
            return null;
        }
    }

    /**
     * Sample currently active speaker names from the Google Meet UI and
     * register activity timestamps per speaker.
     *
     * This uses heuristic DOM checks on aria-labels such as
     * "<Name> is speaking" or "Speaking now", as well as data-speaking flags
     * where available. It does not rely on any server-side audio pipeline.
     */
    // registerSpeakerActivity(name, timestampMs) {
    //     // Clean the provided display name so we avoid suffixes like "is speaking" or self-view markers
    //     const cleaned = this._cleanName(name);
    //     if (!cleaned) return; // Skip if name cannot be determined or is self-view
    //     const ts = typeof timestampMs === 'number' ? timestampMs : Date.now();
    //     this.lastActivity = ts;

    //     if (!this.registeredActivityTimestamps[cleaned]) {
    //         this.registeredActivityTimestamps[cleaned] = [];
    //     }
    //     this.registeredActivityTimestamps[cleaned].push(ts);

    //     if (!this.participants.includes(cleaned)) {
    //         this.participants.push(cleaned);
    //         try {
    //             if (!this.participantJoinTimes[cleaned]) this.participantJoinTimes[cleaned] = ts;
    //             this.participantAbsenceCounts[cleaned] = 0;
    //         } catch (e) {}
    //     }
    // }

    // async sampleActiveSpeakers() {
    //     if (!this.page || (this.page.isClosed && this.page.isClosed())) return;

    //     const now = Date.now();
    //     let activeNames = [];
        
    //     try {
    //         activeNames = await this.page.evaluate(() => {
    //         const names = new Set();
    //         const SELF_VIEW_LABELS = ['you', 'your video', 'self view'];
    //         const clean = (raw) => {
    //             if (!raw) return null;
    //             let first = String(raw).split(/[,(]/)[0].trim();
    //             const lower = first.toLowerCase();
    //             if (SELF_VIEW_LABELS.includes(lower)) return null;
    //             return first;
    //         };
    //         try {
    //             const nodes = Array.from(document.querySelectorAll('[aria-label]'));
    //             for (const el of nodes) {
    //                 const labelRaw = el.getAttribute('aria-label') || '';
    //                 const label = labelRaw.trim();
    //                 if (!label) continue;
    //                 const lower = label.toLowerCase();

    //                 const markers = [
    //                     ' is speaking',
    //                     ' is presenting',
    //                     ' speaking now',
    //                 ];

    //                 let matched = false;
    //                 for (const m of markers) {
    //                     if (lower.endsWith(m)) {
    //                         const base = label.substring(0, label.length - m.length).trim();
    //                         const c = clean(base);
    //                         if (c) names.add(c);
    //                         matched = true;
    //                         break;
    //                     }
    //                 }
    //                 if (matched) continue;

    //                 // Fallback: Tiles may have role=presentation and aria-label="<name> (presenting)"
    //                 if (lower.endsWith('(presenting)')) {
    //                     const base = label.replace(/\(presenting\)$/i, '').trim();
    //                     const c = clean(base);
    //                     if (c) names.add(c);
    //                     continue;
    //                 }

    //                 // Generic speaking detection class
    //                 if (el.getAttribute('data-speaking') === 'true') {
    //                     const c = clean(label);
    //                     if (c) names.add(c);
    //                 }
    //             }
    //         } catch {}
    //         return Array.from(names);
    //     });
    //     } catch (e) {
    //         // Silently handle target closed errors during speaker sampling
    //         const msg = e.message || String(e);
    //         if (!msg.includes('Target closed') && !msg.includes('Session closed')) {
    //             console.warn(`[${this.id}] ⚠️ Speaker sampling error:`, msg);
    //         }
    //         return;
    //     }

    //     if (!Array.isArray(activeNames) || activeNames.length === 0) return;

    //     for (const name of activeNames) {
    //         this.registerSpeakerActivity(name, now);
    //     }
    // }

    /**
     * Monitor participants and auto-leave when empty (enhanced with MeetsBot + GoogleMeetBot logic)
     */
    startParticipantMonitoring() {
        console.log(`[${this.id}] 👥 Starting comprehensive monitoring...`);
        
        // Start page validity checks (GoogleMeetBot style)
        this.startPageValidityCheck();
        
        let lastLoggedCount = null;
        let emptyStreak = 0;
        const leaveThreshold = 3; // require 3 consecutive empty readings before leaving (reserved for future use)

        // // Start speaker activity sampling (best-effort active speaker detection)
        // if (this.speakerActivityInterval) {
        //     try { clearInterval(this.speakerActivityInterval); } catch {}
        // }
        // this.speakerActivityInterval = setInterval(async () => {
        //     try {
        //         await this.sampleActiveSpeakers();
        //     } catch (e) {
        //         // Non-fatal: just log once in a while
        //         console.warn(`[${this.id}] ⚠️ Speaker sampling error:`, e.message || e);
        //     }
        // }, 2000); // 2s resolution for speaker activity (optimized)
        
        // Meeting title capture removed — no periodic title fetch from extension

        // Periodically detect meeting host (every 15 seconds)
        let hostCheckCounter = 0;
        const hostCheckInterval = 3; // Check every 3rd interval (15 seconds)
        
        this.participantCheckInterval = setInterval(async () => {
            try {
                if (!this.page || (this.page.isClosed && this.page.isClosed())) {
                    if (this.participantCheckInterval) {
                        clearInterval(this.participantCheckInterval);
                        this.participantCheckInterval = null;
                    }
                    return;
                }

                // Skip participant detection if modals/dialogs are visible (they can cause false counts)

                const detection = await this.detectOtherBots();
                console.log("Detection OtherBots", detection && typeof detection.botCount === 'number' ? detection.botCount : null, 'humanCount:', detection && typeof detection.humanCount === 'number' ? detection.humanCount : null);

                // Process detector details: record detected names, initialize join times
                // and absence counters, and emit participant.joined for newly-seen names.

                const participantCount = (detection.botCount || 0) + (detection.humanCount || 0);

                // Build list of currently-detected cleaned names (from detection.details)
                const detectedNames = [];
                try {
                    if (detection && Array.isArray(detection.details)) {
                        for (const det of detection.details) {
                            try {
                                const raw = det && (det.name || det.label || '');
                                const cleaned = this._cleanName(raw || '');
                                if (!cleaned) continue;

                                // Add to detectedNames set for this interval
                                if (!detectedNames.includes(cleaned)) detectedNames.push(cleaned);

                                // If this is a newly-seen participant, emit 'participant.joined'
                                const isNew = !this.participants.includes(cleaned);
                                if (isNew) {
                                    try {
                                        const ts = getCurrentTimestamp();
                                        const payload = {
                                            meeting_id: this.getMeetingIdFromUrl(this.meetUrl) || null,
                                            name: cleaned,
                                            joined_at: ts.formatted,
                                            timezone: ts.timezone,
                                            reason: det.reason || null,
                                            bot_like: !!(det.reason && det.reason !== 'text-suspect-human')
                                        };

                                        // Fire-and-forget; log failures but don't block monitoring loop
                                        sendWebhook('participant.joined', payload, this.webhookUrl || null).catch(err => {
                                            console.warn(`[${this.id}] ⚠️ Failed to send participant.joined webhook for ${cleaned}: ${err && err.message ? err.message : err}`);
                                        });

                                        console.log(`[${this.id}] ➕ New participant detected: ${cleaned}`);
                                    } catch (e) {
                                        // ignore per-entry errors
                                    }
                                }

                                // Ensure we have a join time for detected names
                                if (!this.participantJoinTimes[cleaned]) {
                                    try { this.participantJoinTimes[cleaned] = getCurrentTimestamp().timestampMs; } catch {}
                                }
                                // Reset absence counter for seen participants
                                this.participantAbsenceCounts[cleaned] = 0;
                                // Ensure in participants list
                                if (!this.participants.includes(cleaned)) this.participants.push(cleaned);
                            } catch {}
                        }
                    }
                } catch (e) {}

                // Detect participants that have disappeared and emit participant.left
                try {
                    const prev = Array.isArray(this.participants) ? [...this.participants] : [];
                    for (const prevName of prev) {
                        try {
                            if (!prevName) continue;
                            // Skip names that are currently detected
                            if (detectedNames.includes(prevName)) continue;
                            // Never emit for the bot itself
                            if (this.botName && prevName === this.botName) continue;

                            // Increase absence counter
                            const cur = this.participantAbsenceCounts[prevName] || 0;
                            this.participantAbsenceCounts[prevName] = cur + 1;

                            // Require 2 consecutive misses before considering left (10s)
                            if (this.participantAbsenceCounts[prevName] >= 2) {
                                // Considered left
                                const leftTs = getCurrentTimestamp();
                                const joinMs = this.participantJoinTimes[prevName] || null;
                                let joinedFormatted = null;
                                if (joinMs) {
                                    try {
                                        const jt = timestampToTimezone(joinMs);
                                        joinedFormatted = jt.formatted;
                                    } catch {}
                                }
                                const leftFormatted = leftTs.formatted;
                                const durationSeconds = joinMs ? Math.max(0, Math.round((leftTs.timestampMs - joinMs)/1000)) : null;

                                // Send webhook
                                    try {
                                        sendWebhook('participant.left', {
                                            meeting_id: this.getMeetingIdFromUrl(this.meetUrl) || null,
                                            name: prevName,
                                            joined_at: joinedFormatted,
                                            left_at: leftFormatted,
                                            duration_seconds: durationSeconds
                                        }, this.webhookUrl || null).catch(err => {
                                            console.warn(`[${this.id}] ⚠️ Failed to send participant.left webhook for ${prevName}: ${err && err.message ? err.message : err}`);
                                        });
                                    } catch (e) {
                                        // ignore
                                    }

                                console.log(`[${this.id}] ➖ Participant left: ${prevName} (duration: ${durationSeconds}s)`);

                                // Remove from known participants and clear tracking
                                try {
                                    this.participants = this.participants.filter(p => p !== prevName);
                                    delete this.participantJoinTimes[prevName];
                                    delete this.participantAbsenceCounts[prevName];
                                } catch (e) {}
                            }
                        } catch (e) {}
                    }
                } catch (e) {}

                // Track maximum participants seen (excluding bot, so subtract 1)
                const actualParticipants = detection.humanCount;
                if (actualParticipants > this.maxParticipantsSeen) {
                    this.maxParticipantsSeen = actualParticipants;
                    console.log(`[${this.id}] 📊 New maximum participants: ${this.maxParticipantsSeen}`);
                }
                
                // Log only on change to reduce noise/flicker
                if (participantCount !== lastLoggedCount) {
                    console.log(`[${this.id}] 👥 Participants (including bot): ${participantCount}`);
                    lastLoggedCount = participantCount;
                }

                // Track when bot is alone (MeetsBot style)
                if (participantCount === 1) {
                    if (this.timeAloneStarted === Infinity) {
                        this.timeAloneStarted = Date.now();
                        console.log(`[${this.id}] ⏱️ Bot is now alone in meeting`);
                    }
                    
                    emptyStreak++;
                    const aloneMs = Date.now() - this.timeAloneStarted;
                    const leaveAfterMs = 10000; // 5 seconds alone threshold
                    
                    if (aloneMs > leaveAfterMs) {
                        console.log(`[${this.id}] 🚪 Alone for ${(aloneMs/1000).toFixed(0)}s (>${leaveAfterMs/1000}s), leaving...`);
                        this.leaveMeet();
                        return;
                    }
                } else {
                    emptyStreak = 0;
                    this.timeAloneStarted = Infinity;
                }

                // Check if kicked (MeetsBot 3-condition check)
                if (await this.checkKicked()) {
                    console.log(`[${this.id}] 🚫 Detected kicked from meeting`);
                    this.leaveMeet();
                    return;
                }

                // Check for inactivity timeout (MeetsBot style)
                const inactivityTimeout = 300000; // 5 minutes
                if (
                    participantCount > 1 &&
                    this.lastActivity &&
                    Date.now() - this.lastActivity > inactivityTimeout
                ) {
                    console.log(`[${this.id}] ⏰ No activity for ${inactivityTimeout/60000} minutes, leaving...`);
                    this.leaveMeet();
                    return;
                }

                // Heuristic: if only bot-like participants are present, optionally leave to avoid duplicated bots
                try {
                    const leaveOnOnlyBots = !(process.env.LEAVE_ON_ONLY_BOTS === '0' || /^false$/i.test(process.env.LEAVE_ON_ONLY_BOTS || ''));
                    if (leaveOnOnlyBots) {
                        if(detection.botCount > 0 && detection.humanCount === 0) {
                            console.log(`[${this.id}] ⚠️ Detected only bot-like participants (${detection.botCount}) — leaving to avoid duplicated bots`);
                            try { console.log(`[${this.id}] ⚠️ Bot detection details: ${JSON.stringify((detection && detection.details) ? detection.details.slice(0,10) : [])}`); } catch {}
                            this.leaveMeet();
                            return;
                        }
                    }
                } catch (e) {
                    // Non-fatal detection error - continue monitoring
                }
                
                // Periodically check for meeting host (every 15 seconds) - only if not already found
                // if (!this.meetingHost) {
                //     hostCheckCounter++;
                //     if (hostCheckCounter >= hostCheckInterval) {
                //         hostCheckCounter = 0;
                //         try {
                //             await this.getMeetingHost();
                //             // If host was found, we don't need to check again
                //             if (this.meetingHost) {
                //                 console.log(`[${this.id}] ✅ Host detection complete, stopping periodic checks`);
                //             }
                //         } catch (e) {
                //             // Silently ignore host detection errors
                //         }
                //     }
                // }
                
            } catch (error) {
                if (error && typeof error.message === 'string' && error.message.includes('Target closed')) {
                    if (this.participantCheckInterval) {
                        clearInterval(this.participantCheckInterval);
                        this.participantCheckInterval = null;
                    }
                    return;
                }
                console.warn(`[${this.id}] ⚠️ Participant check error:`, error.message);
            }
        }, 5000);
    }

    /**
     * Stop recording (GoogleMeetBot style - browser handles stopping)
     */
    async stopRecording() {
        if (!this.isCapturing) return;

        console.log(`[${this.id}] ⏹️ Stopping recording...`);
        this.isCapturing = false;
        
        // Recording is stopped from browser side, file is already written
        console.log(`[${this.id}] ✅ Recording stopped - file saved to ${this.recordingPath}`);

        // Emit recording.ended webhook immediately after stopping capture
        try {
            const meetingId = this.getMeetingIdFromUrl(this.meetUrl) || null;
            const recordingType = this.recordingType || 'audio-video';
            const fileUrl = this.recordingPath || null;
            let durationSeconds = null;
            try {
                if (this.recordingStartedAt) {
                    durationSeconds = Math.max(0, Math.round((Date.now() - this.recordingStartedAt) / 1000));
                }
            } catch (e) {}

            sendWebhook('recording.ended', {
                meeting_id: meetingId,
                recording_type: recordingType,
                file_url: fileUrl,
                duration_seconds: durationSeconds
            }, this.webhookUrl || null).catch(err => {
                console.warn(`[${this.id}] ⚠️ Failed to send recording.ended webhook: ${err && err.message ? err.message : err}`);
            });
            console.log(`[${this.id}] 📣 Emitted recording.ended webhook (file: ${fileUrl || 'n/a'})`);
        } catch (e) {
            // non-fatal
        }
    }

    /**
     * Get speaker timeframes (MeetsBot style)
     */
    getSpeakerTimeframes() {
        const processedTimeframes = [];
        const utteranceThresholdMs = 3000;

        for (const [speakerName, timeframesArray] of Object.entries(this.registeredActivityTimestamps)) {
            let start = timeframesArray[0];
            let end = timeframesArray[0];

            for (let i = 1; i < timeframesArray.length; i++) {
                const currentTimeframe = timeframesArray[i];
                if (currentTimeframe - end < utteranceThresholdMs) {
                    end = currentTimeframe;
                } else {
                    if (end - start > 500) {
                        processedTimeframes.push({ speakerName, start, end });
                    }
                    start = currentTimeframe;
                    end = currentTimeframe;
                }
            }
            processedTimeframes.push({ speakerName, start, end });
        }

        processedTimeframes.sort((a, b) => a.start - b.start || a.end - b.end);
        return processedTimeframes;
    }

    /**
     * Generate speaker timeframes from transcript captions
     * This is more reliable than DOM-based speaker detection
     */
    getSpeakerTimeframesFromCaptions(captions) {
        if (!captions || !Array.isArray(captions) || captions.length === 0) {
            return [];
        }
        
        const timeframes = [];
        let currentSpeaker = null;
        let currentStart = null;
        let currentEnd = null;
        
        for (const caption of captions) {
            const speaker = caption.speaker;
            const timestamp = caption.timestampMs || (caption.offsetSeconds * 1000);
            
            if (!speaker || !timestamp) continue;
            
            if (currentSpeaker === speaker) {
                // Same speaker continuing - extend timeframe
                currentEnd = timestamp;
            } else {
                // New speaker - save previous timeframe
                if (currentSpeaker && currentStart && currentEnd) {
                    timeframes.push({
                        speakerName: currentSpeaker,
                        start: currentStart,
                        end: currentEnd
                    });
                }
                // Start new timeframe
                currentSpeaker = speaker;
                currentStart = timestamp;
                currentEnd = timestamp;
            }
        }
        
        // Save last timeframe
        if (currentSpeaker && currentStart && currentEnd) {
            timeframes.push({
                speakerName: currentSpeaker,
                start: currentStart,
                end: currentEnd
            });
        }
        
        return timeframes;
    }

    /**
     * Persist computed speaker timeframes to file for this bot.
     * File path: runtime/<botId>/SpeakerTimeframes.json
     */
    async saveSpeakerTimeframesToFile() {
        if (!this.speakerTimeframesFile) return;
        
        // Try to get timeframes from DOM-based detection first
        let timeframes = this.getSpeakerTimeframes();
        
        // If empty, try to generate from captions (more reliable)
        if (!timeframes || timeframes.length === 0) {
            console.log(`[${this.id}] ℹ️ DOM-based speaker detection found no data, generating from captions...`);
            
            // Read captions file if it exists
            try {
                if (fs.existsSync(this.captionsFile)) {
                    const captionsData = await fs.promises.readFile(this.captionsFile, 'utf8');
                    const captions = JSON.parse(captionsData);
                    timeframes = this.getSpeakerTimeframesFromCaptions(captions);
                    
                    if (timeframes && timeframes.length > 0) {
                        console.log(`[${this.id}] ✅ Generated ${timeframes.length} timeframes from captions`);
                    }
                }
            } catch (e) {
                console.warn(`[${this.id}] ⚠️ Could not generate timeframes from captions:`, e.message);
            }
        }
        
        try {
            await fs.promises.writeFile(this.speakerTimeframesFile, JSON.stringify(timeframes, null, 2), 'utf8');
            console.log(`[${this.id}] 💾 SpeakerTimeframes saved to ${this.speakerTimeframesFile}`);
        } catch (e) {
            console.error(`[${this.id}] ❌ Failed to write SpeakerTimeframes file:`, e.message || e);
            try { if (this.emitError) await this.emitError('file_write_error', 'Failed to write SpeakerTimeframes file', { path: this.speakerTimeframesFile, error: e && e.message ? e.message : String(e) }); } catch (err) {}
        }
    }

    /**
     * Calculate comprehensive meeting metrics
     * Returns metrics including duration, talk time, interruptions, silence, and keywords
     */
    async calculateMeetingMetrics() {
        const { DEFAULT_TIMEZONE, DEFAULT_LOCALE, getTimezoneInfo, formatTime } = require('./utils/timezone');
        const tzInfo = getTimezoneInfo();
        
        const metrics = {
            timezone: {
                name: DEFAULT_TIMEZONE,
                locale: DEFAULT_LOCALE,
                displayName: tzInfo.timeZoneName,
                offset: tzInfo.offset
            },
            duration: {
                totalMs: 0,
                totalSeconds: 0,
                totalMinutes: 0,
                startTime: this.meetingStartTime,
                startTimeFormatted: this.meetingStartTimeFormatted,
                endTime: this.meetingEndTime,
                endTimeFormatted: this.meetingEndTimeFormatted
            },
            talkTime: {
                totalMs: 0,
                totalSeconds: 0,
                totalMinutes: 0,
                byParticipant: {}
            },
            interruptions: {
                total: 0,
                details: []
            },
            silence: {
                totalMs: 0,
                totalSeconds: 0,
                totalMinutes: 0,
                periods: []
            },
            keywords: {
                total: 0,
                byKeyword: {},
                occurrences: []
            },
            participation: {
                totalParticipants: 0,
                speakers: [],
                speakerStats: {},
                meetingHost: null
            }
        };

        try {
            // Load captions
            let captions = [];
            if (fs.existsSync(this.captionsFile)) {
                const captionsData = await fs.promises.readFile(this.captionsFile, 'utf8');
                captions = JSON.parse(captionsData);
            } else if (Array.isArray(this.captions)) {
                captions = this.captions;
            }

            // Calculate duration - use actual meeting times if available, otherwise use caption timestamps
            // (Do this even if no captions, so we can still show meeting duration)
            let durationMs = 0;
            
            if (this.meetingStartTime) {
                const startDate = new Date(this.meetingStartTime);
                let endDate;
                
                if (this.meetingEndTime) {
                    // Meeting has ended - use actual end time
                    endDate = new Date(this.meetingEndTime);
                } else {
                    // Meeting still ongoing - use current time
                    endDate = new Date();
                }
                
                durationMs = endDate.getTime() - startDate.getTime();
            } else if (captions.length > 0) {
                // Fallback to caption timestamps
                const firstCaption = captions[0];
                const lastCaption = captions[captions.length - 1];
                
                if (firstCaption && lastCaption) {
                    const startMs = firstCaption.timestampMs || 0;
                    const endMs = lastCaption.timestampMs || 0;
                    durationMs = endMs - startMs;
                }
            }
            
            if (durationMs > 0) {
                metrics.duration.totalMs = durationMs;
                metrics.duration.totalSeconds = Math.floor(durationMs / 1000);
                metrics.duration.totalMinutes = Math.max(1, Math.floor(durationMs / 60000)); // At least 1 min if meeting happened
            }

            // If no captions, still return metrics with duration (if available)
            if (!captions || captions.length === 0) {
                console.log(`[${this.id}] ⚠️ No captions available for metrics calculation`);
                // Duration already calculated above, return what we have
                return metrics;
            }

            // Track speakers and their talk time
            const speakerSegments = {};
            let currentSpeaker = null;
            let segmentStart = null;
            const lastCaption = captions.length > 0 ? captions[captions.length - 1] : null;
            
            for (let i = 0; i < captions.length; i++) {
                const caption = captions[i];
                const speaker = (caption.speaker || 'Unknown Speaker').trim();
                const timestampMs = caption.timestampMs || 0;
                
                if (!speakerSegments[speaker]) {
                    speakerSegments[speaker] = [];
                }
                
                if (currentSpeaker !== speaker) {
                    // Save previous segment
                    if (currentSpeaker && segmentStart !== null) {
                        speakerSegments[currentSpeaker].push({
                            start: segmentStart,
                            end: timestampMs,
                            duration: timestampMs - segmentStart
                        });
                    }
                    // Start new segment
                    currentSpeaker = speaker;
                    segmentStart = timestampMs;
                }
            }
            
            // Save last segment
            if (currentSpeaker && segmentStart !== null && lastCaption) {
                const endMs = lastCaption.timestampMs || 0;
                speakerSegments[currentSpeaker].push({
                    start: segmentStart,
                    end: endMs,
                    duration: endMs - segmentStart
                });
            }

            // Calculate talk time per participant
            let totalTalkTimeMs = 0;
            for (const [speaker, segments] of Object.entries(speakerSegments)) {
                const speakerTalkTime = segments.reduce((sum, seg) => sum + seg.duration, 0);
                totalTalkTimeMs += speakerTalkTime;
                
                metrics.talkTime.byParticipant[speaker] = {
                    totalMs: speakerTalkTime,
                    totalSeconds: Math.floor(speakerTalkTime / 1000),
                    totalMinutes: Math.floor(speakerTalkTime / 60000),
                    percentage: 0, // Will calculate after we have total
                    segmentCount: segments.length
                };
            }
            
            metrics.talkTime.totalMs = totalTalkTimeMs;
            metrics.talkTime.totalSeconds = Math.floor(totalTalkTimeMs / 1000);
            metrics.talkTime.totalMinutes = Math.floor(totalTalkTimeMs / 60000);
            
            // Calculate percentages
            for (const speaker in metrics.talkTime.byParticipant) {
                if (totalTalkTimeMs > 0) {
                    const speakerTime = metrics.talkTime.byParticipant[speaker].totalMs;
                    metrics.talkTime.byParticipant[speaker].percentage = 
                        Math.round((speakerTime / totalTalkTimeMs) * 10000) / 100;
                }
            }

            // Detect interruptions (speaker changes within short time window)
            const INTERRUPTION_THRESHOLD_MS = 2000; // 2 seconds
            for (let i = 1; i < captions.length; i++) {
                const prev = captions[i - 1];
                const curr = captions[i];
                
                // Skip if either caption is missing speaker or text
                const prevSpeaker = (prev.speaker || '').trim();
                const currSpeaker = (curr.speaker || '').trim();
                if (!prevSpeaker || !currSpeaker || prevSpeaker === 'Unknown Speaker' || currSpeaker === 'Unknown Speaker') {
                    continue;
                }
                
                // Skip if same speaker (not an interruption)
                if (prevSpeaker === currSpeaker) {
                    continue;
                }
                
                // Calculate time difference
                const prevTime = prev.timestampMs || prev.offsetSeconds * 1000 || 0;
                const currTime = curr.timestampMs || curr.offsetSeconds * 1000 || 0;
                const timeDiff = currTime - prevTime;
                
                // Only count as interruption if time difference is positive and within threshold
                if (timeDiff > 0 && timeDiff < INTERRUPTION_THRESHOLD_MS) {
                    metrics.interruptions.total++;
                    const interruptionTime = currTime || Date.now();
                    metrics.interruptions.details.push({
                        timestamp: interruptionTime,
                        timestampFormatted: formatTime(new Date(interruptionTime)),
                        from: prevSpeaker,
                        to: currSpeaker,
                        gapMs: timeDiff
                    });
                }
            }

            // Detect silence periods (gaps between captions)
            const SILENCE_THRESHOLD_MS = 5000; // 5 seconds
            for (let i = 1; i < captions.length; i++) {
                const prev = captions[i - 1];
                const curr = captions[i];
                
                const gapMs = (curr.timestampMs || 0) - (prev.timestampMs || 0);
                
                if (gapMs >= SILENCE_THRESHOLD_MS) {
                    metrics.silence.totalMs += gapMs;
                    metrics.silence.periods.push({
                        start: prev.timestampMs,
                        startFormatted: formatTime(new Date(prev.timestampMs)),
                        end: curr.timestampMs,
                        endFormatted: formatTime(new Date(curr.timestampMs)),
                        durationMs: gapMs,
                        durationSeconds: Math.floor(gapMs / 1000)
                    });
                }
            }
            
            metrics.silence.totalSeconds = Math.floor(metrics.silence.totalMs / 1000);
            metrics.silence.totalMinutes = Math.floor(metrics.silence.totalMs / 60000);

            // Load OpenAI-generated keywords from keywords.json (if available)
            // OpenAI keywords are generated along with the summary
            const keywordsPath = path.join(this.botDir, 'keywords.json');
            if (fs.existsSync(keywordsPath)) {
                try {
                    const openAIKeywords = JSON.parse(await fs.promises.readFile(keywordsPath, 'utf8'));
                    if (Array.isArray(openAIKeywords) && openAIKeywords.length > 0) {
                        // Format OpenAI keywords into metrics structure
                        metrics.keywords.total = openAIKeywords.length;
                        openAIKeywords.forEach(keyword => {
                            if (keyword && typeof keyword === 'string' && keyword.trim().length > 0) {
                                const keywordTrimmed = keyword.trim();
                                // Count occurrences in captions for each keyword
                                let count = 0;
                                const keywordLower = keywordTrimmed.toLowerCase();
                                const keywordRegex = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                                
                                for (const caption of captions) {
                                    const text = (caption.text || '').trim();
                                    if (text && keywordRegex.test(text.toLowerCase())) {
                                        count++;
                                        const speaker = (caption.speaker || 'Unknown Speaker').trim();
                                        const timestamp = caption.timestampMs || (caption.offsetSeconds ? caption.offsetSeconds * 1000 : 0);
                                        metrics.keywords.occurrences.push({
                                            keyword: keywordTrimmed,
                                            speaker,
                                            timestamp,
                                            timestampFormatted: timestamp > 0 ? formatTime(new Date(timestamp)) : 'N/A',
                                            text: text
                                        });
                                    }
                                }
                                
                                if (count > 0) {
                                    metrics.keywords.byKeyword[keywordTrimmed] = count;
                                } else {
                                    // Even if no occurrences found, include the keyword (count = 1)
                                    metrics.keywords.byKeyword[keywordTrimmed] = 1;
                                }
                            }
                        });
                        console.log(`[${this.id}] ✅ Loaded ${openAIKeywords.length} OpenAI-generated keywords into metrics`);
                    }
                } catch (e) {
                    console.warn(`[${this.id}] ⚠️  Could not load OpenAI keywords: ${e.message}`);
                }
            } else {
                console.log(`[${this.id}] ℹ️  OpenAI keywords not yet generated (keywords.json not found)`);
            }

                // Participation stats - use maximum participants seen during monitoring (most accurate)
                // This represents the peak number of participants in the meeting (excluding bot)
                // maxParticipantsSeen already excludes the bot (we subtract 1 in monitoring)
                if (this.maxParticipantsSeen > 0) {
                    metrics.participation.totalParticipants = this.maxParticipantsSeen; // Already excludes bot
                    // Also collect unique speakers from captions for the speakers list
                    const uniqueSpeakers = new Set();
                    for (const caption of captions) {
                        const speaker = (caption.speaker || '').trim();
                        if (speaker && speaker !== 'Unknown Speaker' && speaker.length > 0) {
                            uniqueSpeakers.add(speaker);
                        }
                    }
                if (uniqueSpeakers.size > 0) {
                    metrics.participation.speakers = Array.from(uniqueSpeakers);
                } else {
                    // Fallback to talkTime.byParticipant for speaker names
                    const speakers = Object.keys(metrics.talkTime.byParticipant).filter(s => s && s !== 'Unknown Speaker' && s.trim().length > 0);
                    if (speakers.length > 0) {
                        metrics.participation.speakers = speakers;
                    } else {
                        metrics.participation.speakers = [];
                    }
                }
                
                // Add meeting host if detected
                if (this.meetingHost) {
                    metrics.participation.meetingHost = this.meetingHost;
                }
            } else {
                // Fallback: count unique speakers from captions if maxParticipantsSeen not available
                const uniqueSpeakers = new Set();
                for (const caption of captions) {
                    const speaker = (caption.speaker || '').trim();
                    if (speaker && speaker !== 'Unknown Speaker' && speaker.length > 0) {
                        uniqueSpeakers.add(speaker);
                    }
                }
                
                if (uniqueSpeakers.size > 0) {
                    metrics.participation.totalParticipants = uniqueSpeakers.size;
                    metrics.participation.speakers = Array.from(uniqueSpeakers);
                } else {
                    // Fallback to talkTime.byParticipant (filter out Unknown Speaker)
                    const speakers = Object.keys(metrics.talkTime.byParticipant).filter(s => s && s !== 'Unknown Speaker' && s.trim().length > 0);
                    if (speakers.length > 0) {
                        metrics.participation.totalParticipants = speakers.length;
                        metrics.participation.speakers = speakers;
                    } else {
                        // Fallback to speakerSegments if talkTime wasn't calculated (filter out Unknown Speaker)
                        const speakerSegmentsKeys = Object.keys(speakerSegments).filter(s => s && s !== 'Unknown Speaker' && s.trim().length > 0);
                        if (speakerSegmentsKeys.length > 0) {
                            metrics.participation.totalParticipants = speakerSegmentsKeys.length;
                            metrics.participation.speakers = speakerSegmentsKeys;
                        } else if (Array.isArray(this.participants) && this.participants.length > 0) {
                            // Fallback to bot's participant tracking if no speakers in captions
                            const validParticipants = this.participants.filter(p => p && p !== 'Unknown Speaker' && p.trim().length > 0);
                            if (validParticipants.length > 0) {
                                metrics.participation.totalParticipants = validParticipants.length;
                                metrics.participation.speakers = validParticipants;
                            }
                        }
                    }
                }
            }
            
            // Build speaker stats from talk time data
            const finalSpeakers = metrics.participation.speakers || [];
            for (const speaker of finalSpeakers) {
                const talkData = metrics.talkTime.byParticipant[speaker];
                if (talkData) {
                    metrics.participation.speakerStats[speaker] = {
                        talkTimeMs: talkData.totalMs,
                        talkPercentage: talkData.percentage,
                        utterances: talkData.segmentCount
                    };
                } else {
                    // If not in talkTime, try to get from speakerSegments
                    const segments = speakerSegments[speaker];
                    if (segments && segments.length > 0) {
                        const talkTimeMs = segments.reduce((sum, seg) => sum + seg.duration, 0);
                        metrics.participation.speakerStats[speaker] = {
                            talkTimeMs: talkTimeMs,
                            talkPercentage: totalTalkTimeMs > 0 ? Math.round((talkTimeMs / totalTalkTimeMs) * 10000) / 100 : 0,
                            utterances: segments.length
                        };
                    } else {
                        // Fallback: count occurrences in captions
                        const captionCount = captions.filter(c => (c.speaker || '').trim() === speaker).length;
                        metrics.participation.speakerStats[speaker] = {
                            talkTimeMs: 0,
                            talkPercentage: 0,
                            utterances: captionCount
                        };
                    }
                }
            }

            console.log(`[${this.id}] ✅ Metrics calculated: ${metrics.duration.totalMinutes}min, ${metrics.participation.totalParticipants} participants, ${metrics.interruptions.total} interruptions, ${metrics.keywords.total} keywords`);
            console.log(`[${this.id}] 📊 Metrics details: ${metrics.participation.speakers.length} speakers (${metrics.participation.speakers.join(', ')}), ${captions.length} captions processed`);

        } catch (e) {
            console.error(`[${this.id}] ❌ Error calculating meeting metrics:`, e.message || e);
        }

        return metrics;
    }

    /**
     * Save meeting metrics to file
     */
    async saveMeetingMetrics() {
        if (!this.metricsFile) return;
        
        try {
            const metrics = await this.calculateMeetingMetrics();
            await fs.promises.writeFile(this.metricsFile, JSON.stringify(metrics, null, 2), 'utf8');
            console.log(`[${this.id}] 💾 Meeting metrics saved to ${this.metricsFile}`);
            return metrics;
        } catch (e) {
            console.error(`[${this.id}] ❌ Failed to save meeting metrics:`, e.message || e);
            try { if (this.emitError) await this.emitError('file_write_error', 'Failed to save meeting metrics', { path: this.metricsFile, error: e && e.message ? e.message : String(e) }); } catch (err) {}
            return null;
        }
    }

    async fetchTranscriptFromPage() {
        // Check if page is valid and accessible
        if (!this.page || (this.page.isClosed && this.page.isClosed())) {
            return { transcript: [], meetingStartTimeStamp: null };
        }

        try {
            const data = await this.page.evaluate(() => {
                try {
                    const transcript = JSON.parse(localStorage.getItem('transcript') || '[]');
                    const rawStart = localStorage.getItem('meetingStartTimeStamp');
                    let meetingStartTimeStamp = null;
                    if (rawStart) {
                        try {
                            meetingStartTimeStamp = JSON.parse(rawStart);
                        } catch {
                            meetingStartTimeStamp = rawStart;
                        }
                    }
                    // Do NOT fetch meetingTitle from extension (removed requirement)
                    const meetingHost = localStorage.getItem('meetingHost') || null;
                    return { transcript, meetingStartTimeStamp, meetingHost };
                } catch {
                    return { transcript: [], meetingStartTimeStamp: null, meetingHost: null };
                }
            });
            if (!data || !Array.isArray(data.transcript)) {
                return { transcript: [], meetingStartTimeStamp: null, meetingHost: null };
            }
            return data;
        } catch (e) {
            // Silently handle common page-closing errors
            const msg = e.message || String(e);
            if (msg.includes('Requesting main frame too early') || 
                msg.includes('Session closed') || 
                msg.includes('Target closed')) {
                console.log(`[${this.id}] ℹ️ Page closing - transcript fetch skipped`);
            } else {
                console.warn(`[${this.id}] ⚠️ Could not fetch transcript from page:`, msg);
            }
            return { transcript: [], meetingStartTimeStamp: null };
        }
    }

    /**
     * Persist captured captions to a JSON file for this bot.
     * File path: runtime/<botId>/transcripts/captions.json
     */
    async saveCaptionsToFile() {
        // Fetch transcript collected by extension instead of internal captions logic
        const { transcript, meetingStartTimeStamp } = await this.fetchTranscriptFromPage();
        if (!transcript || transcript.length === 0) {
            console.log(`[${this.id}] ⚠️ No transcript found in page storage.`);
            return;
        }

        // Convert extension format -> generic captions format expected by frontend
        let startMs = null;
        if (meetingStartTimeStamp) {
            const parsed = Date.parse(meetingStartTimeStamp);
            if (!Number.isNaN(parsed)) startMs = parsed;
        }

        const mapped = transcript.map((t) => {
            const speaker = (t.personName || '').trim() || 'Unknown Speaker';
            const text = (t.personTranscript || '').trim();
            let tsMs = null;
            if (t.timeStamp) {
                const parsed = Date.parse(t.timeStamp);
                if (!Number.isNaN(parsed)) tsMs = parsed;
            }
            const offsetSeconds =
                startMs !== null && tsMs !== null ? Math.max(0, Math.round((tsMs - startMs) / 1000)) : 0;

            return {
                speaker,
                text,
                offsetSeconds,
                timestampMs: tsMs !== null ? tsMs : undefined,
            };
        }).filter(c => c.text);

        if (!mapped.length) {
            console.log(`[${this.id}] ⚠️ Transcript from extension had no usable entries.`);
            return;
        }

        if (!this.captionsFile) return;
        try {
            await fs.promises.writeFile(this.captionsFile, JSON.stringify(mapped, null, 2), 'utf8');
            console.log(`[${this.id}] 💾 Transcript saved to ${this.captionsFile}`);
            // Emit transcript.completed webhook so external services know transcript is ready
            try {
                const meetingId = this.getMeetingIdFromUrl(this.meetUrl) || null;
                const language = this.captionLanguage || null;
                // Convert local file path to shareable URL
                let transcriptUrl = null;
                if (this.id) {
                    const baseUrl = process.env.BASE_URL;
                    const cleanBaseUrl = String(baseUrl).replace(/\/$/, ''); // Remove trailing slash
                    transcriptUrl = `${cleanBaseUrl}/share?token=${encodeURIComponent(this.id)}`;
                }
                // Get meeting title from metadata
                let meetingTitle = null;
                try {
                    const metadataPath = path.join(this.botDir, 'bot_metadata.json');
                    if (await fs.pathExists(metadataPath)) {
                        const metadata = await fs.readJson(metadataPath).catch(() => null);
                        if (metadata && metadata.title) {
                            meetingTitle = metadata.title;
                        }
                    }
                } catch (e) {
                    // Ignore errors when reading metadata
                }
                
                // Get meeting duration in minutes
                let meetingDurationMinutes = null;
                try {
                    // First, try to get duration from metrics file if it exists
                    if (await fs.pathExists(this.metricsFile)) {
                        const metrics = await fs.readJson(this.metricsFile).catch(() => null);
                        if (metrics && metrics.duration && metrics.duration.totalMinutes) {
                            meetingDurationMinutes = metrics.duration.totalMinutes;
                        }
                    }
                    // Fallback: calculate from recording start time if available
                    if (meetingDurationMinutes === null && this.recordingStartedAt && this.recordingStartedAt > 0) {
                        const durationMs = Date.now() - this.recordingStartedAt;
                        meetingDurationMinutes = Math.max(1, Math.floor(durationMs / 60000)); // At least 1 minute
                    }
                } catch (e) {
                    // Ignore errors when reading duration
                }
                
                sendWebhook('transcript.completed', {
                    meeting_id: meetingId,
                    language,
                    transcript_url: transcriptUrl,
                    meeting_title: meetingTitle,
                    meeting_duration: meetingDurationMinutes
                }, this.webhookUrl || null).catch(err => {
                    console.warn(`[${this.id}] ⚠️ Failed to send transcript.completed webhook: ${err && err.message ? err.message : err}`);
                });
                console.log(`[${this.id}] 📣 Emitted transcript.completed webhook (url: ${transcriptUrl || 'n/a'}, title: ${meetingTitle || 'n/a'}, duration: ${meetingDurationMinutes || 'n/a'} min)`);
            } catch (e) {
                // ignore non-fatal errors
            }
        } catch (e) {
            console.error(`[${this.id}] ❌ Failed to write transcript file:`, e.message || e);
            try { if (this.emitError) await this.emitError('file_write_error', 'Failed to write transcript file', { path: this.captionsFile, error: e && e.message ? e.message : String(e) }); } catch (err) {}
        }
    }

    /**
     * Check if bot was kicked (MeetsBot + GoogleMeetBot enhanced)
     */
    async checkKicked() {
        try {
            // Kick condition 1: "Return to home screen" button
            const gotKickedDetector = '//button[.//span[text()="Return to home screen"]]';
            const returnButtons = await this.page.$x(gotKickedDetector);
            if (returnButtons.length > 0) {
                return true;
            }

            // Kick condition 2: Leave button is hidden or doesn't exist
            const leaveButton = await this.page.$('button[aria-label*="Leave call"], button[aria-label*="End call"]');
            if (!leaveButton) {
                return true;
            }

            // Check if leave button is actually visible
            const isVisible = await leaveButton.boundingBox().then(box => box !== null).catch(() => false);
            if (!isVisible) {
                return true;
            }

            // Kick condition 3: Check for removal/denial text (GoogleMeetBot style)
            const removedText = await this.page.evaluate((constants) => {
                const bodyText = document.body.innerText || '';
                return bodyText.includes(constants.REMOVED) || 
                       bodyText.includes(constants.DENIED) ||
                       bodyText.includes("You left the meeting");
            }, {
                REMOVED: GOOGLE_REMOVED_FROM_MEETING,
                DENIED: GOOGLE_REQUEST_DENIED
            });
            
            if (removedText) {
                return true;
            }

            return false;
        } catch (error) {
            // If page is closed or navigation happened, consider it kicked
            return false;
        }
    }

    /**
     * Leave meeting and cleanup (enhanced with GoogleMeetBot cleanup)
     */
    async leaveMeet() {
        if (this.isLeaving) return;
        this.isLeaving = true;

        console.log(`[${this.id}] 📴 Leaving meeting...`);
        
        // STEP 1: Stop ALL Node-side intervals FIRST to prevent race conditions
        console.log(`[${this.id}] 🧹 Stopping all intervals...`);
        try { 
            if (this.participantCheckInterval) {
                clearInterval(this.participantCheckInterval);
                this.participantCheckInterval = null;
            }
        } catch {}
        
        try {
            if (this.speakerActivityInterval) {
                clearInterval(this.speakerActivityInterval);
                this.speakerActivityInterval = null;
            }
        } catch {}
        
        try { this.stopModalDismissal(); } catch {}
        try { this.stopPageValidityCheck(); } catch {}
        try { await this.stopKeepAlive(); } catch {}
        
        // STEP 2: Fetch transcript and timeframes (page must be in valid state)
        console.log(`[${this.id}] 💾 Saving transcript and timeframes...`);
        
        // Save captions FIRST (timeframes depend on captions)
        try {
            await this.saveCaptionsToFile();
        } catch (e) {
            console.error(`[${this.id}] Error saving captions:`, e);
        }
        
        // Then save timeframes (generated from captions if DOM detection fails)
        try {
            await this.saveSpeakerTimeframesToFile();
        } catch (e) {
            console.error(`[${this.id}] Error saving SpeakerTimeframes:`, e);
        }
        
        // Save meeting metrics
        try {
            const endTimestamp = getCurrentTimestamp();
            this.meetingEndTime = endTimestamp.iso;
            this.meetingEndTimeFormatted = endTimestamp.formatted;
            console.log(`[${this.id}] 📅 Meeting ended at: ${endTimestamp.formatted} (${endTimestamp.timezone})`);
            await this.saveMeetingMetrics();
        } catch (e) {
            console.error(`[${this.id}] Error saving meeting metrics:`, e);
        }

        // Fire webhook for meeting ended (if configured)
        try {
            try {
                const meetingId = this.getMeetingIdFromUrl(this.meetUrl) || null;
                const endedAtFormatted = (this.meetingEndTimeFormatted) || getCurrentTimestamp().formatted;
                // Compute duration in seconds where possible
                let durationSeconds = null;
                try {
                    if (this.meetingStartTime && this.meetingEndTime) {
                        const startMs = new Date(this.meetingStartTime).getTime();
                        const endMs = new Date(this.meetingEndTime).getTime();
                        if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
                    } else if (this.recordingStartedAt) {
                        durationSeconds = Math.max(0, Math.round((Date.now() - this.recordingStartedAt) / 1000));
                    }
                } catch (err) {}

                // Attempt to populate participants list from saved metrics if available
                let participantsList = [];
                try {
                    if (this.metricsFile && fs.existsSync(this.metricsFile)) {
                        const raw = fs.readFileSync(this.metricsFile, 'utf8');
                        const metrics = JSON.parse(raw);
                        if (metrics && metrics.participation) {
                            if (Array.isArray(metrics.participation.speakers) && metrics.participation.speakers.length) {
                                participantsList = metrics.participation.speakers;
                            }
                        }
                        // Fallback: talkTime.byParticipant keys
                        if ((!participantsList || participantsList.length === 0) && metrics && metrics.talkTime && metrics.talkTime.byParticipant) {
                            participantsList = Object.keys(metrics.talkTime.byParticipant || {});
                        }
                    }
                } catch (err) {
                    // ignore
                }

                // Final fallback: use current participants array (may be empty if already cleaned up)
                if (!participantsList || participantsList.length === 0) {
                    participantsList = Array.isArray(this.participants) ? Array.from(new Set(this.participants)) : [];
                }

                const tz = getCurrentTimestamp();
                const payload = {
                    meeting_id: meetingId,
                    ended_at: endedAtFormatted,
                    duration_seconds: durationSeconds,
                    participants: participantsList,
                    timezone: tz.timezone
                };

                // Send but don't block cleanup
                sendWebhook('meeting.ended', payload, this.webhookUrl || null).catch(err => {
                    console.warn(`[${this.id}] ⚠️ Failed to send meeting.ended webhook: ${err && err.message ? err.message : err}`);
                });
                console.log(`[${this.id}] 📣 Emitted meeting.ended webhook (participants: ${participantsList.length})`);
            } catch (err) {}
        } catch (e) {}
        
        
        // STEP 3: Stop browser-side recording and cleanup browser-side intervals
        try {
            if (this.page && !this.page.isClosed()) {
                console.log(`[${this.id}] 🛑 Stopping browser-side recording and cleaning up intervals...`);
                await this.page.evaluate(() => {
                    try {
                        // Stop MediaRecorder and all streams
                        if (window.__mediaRecorder) {
                            try {
                                if (window.__mediaRecorder.state !== 'inactive') {
                                    window.__mediaRecorder.stop();
                                }
                            } catch {}
                        }
                        if (window.__recordingStream) {
                            try {
                                window.__recordingStream.getTracks().forEach(track => {
                                    try { track.stop(); } catch {}
                                });
                            } catch {}
                        }
                        
                        // Clear ALL browser-side intervals and timeouts
                        if (window.__recordingTimeoutId) {
                            clearTimeout(window.__recordingTimeoutId);
                            window.__recordingTimeoutId = null;
                        }
                        if (window.__inactivityParticipantTimeout) {
                            clearTimeout(window.__inactivityParticipantTimeout);
                            window.__inactivityParticipantTimeout = null;
                        }
                        if (window.__pageValidityInterval) {
                            clearInterval(window.__pageValidityInterval);
                            window.__pageValidityInterval = null;
                        }
                        if (window.__modalDismissInterval) {
                            clearInterval(window.__modalDismissInterval);
                            window.__modalDismissInterval = null;
                        }
                        
                        // Stop captions observer
                        if (window.__captionsObserver) {
                            try {
                                window.__captionsObserver.disconnect();
                                window.__captionsObserver = null;
                            } catch {}
                        }
                        
                        console.log('[Browser] ✅ All browser-side resources cleaned up');
                    } catch (e) {
                        console.error('[Browser] ❌ Error during browser cleanup:', e);
                    }
                }).catch(e => {
                    console.warn(`[${this.id}] ⚠️ Error during browser-side cleanup:`, e.message);
                });
                
                // Critical delay to ensure MediaRecorder finalizes and sends last chunk
                await this.page.waitForTimeout(500).catch(() => {});
            }
        } catch (e) {
            // Silently handle target closed errors during cleanup
            const msg = e.message || String(e);
            if (!msg.includes('Target closed') && !msg.includes('Session closed')) {
                console.error(`[${this.id}] ❌ Error stopping browser-side recording:`, e);
            }
        }
        
        // STEP 4: Stop recording (Node-side flag)
        try { 
            if (this.isCapturing) await this.stopRecording(); 
        } catch (e) {
            console.error(`[${this.id}] Error stopping recording:`, e);
        }
        // STEP 5: Click leave button if not kicked (before closing page)
        if (!await this.checkKicked()) {
            const leaveButton = '//button[@aria-label="Leave call"]';
            try {
                await this.page.click(leaveButton, { timeout: 1000 });
                console.log(`[${this.id}] ✅ Left call`);
            } catch (e) {
                console.log(`[${this.id}] Attempted to leave call - couldn't (probably already left)`);
            }
        }
        
        // STEP 6: Cleanup browser and page
        console.log(`[${this.id}] 🌐 Closing browser...`);
        try { 
            if (this.page && !this.page.isClosed()) {
                await this.page.close().catch(() => {}); 
            }
        } catch {}
        
        try { 
            if (this.browser && this.browser.isConnected()) {
                await this.browser.close().catch(() => {}); 
            }
        } catch {}
        
        // Brief delay for browser to exit gracefully (optimized)
        await new Promise(resolve => setTimeout(resolve, 500));

        // STEP 7: Force kill Chrome process and all child processes (platform-specific)
        console.log(`[${this.id}] 🔪 Force killing browser process and all children...`);
        try {
            if (this.browserPid && Number.isInteger(this.browserPid)) {
                const isWindows = process.platform === 'win32';
                
                if (isWindows) {
                    // Windows: use taskkill to kill process tree (more thorough)
                    try {
                        const { execSync } = require('child_process');
                        // First try graceful kill
                        try {
                            execSync(`taskkill /T /PID ${this.browserPid}`, { 
                                stdio: 'ignore',
                                timeout: 3000 
                            });
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch {}
                        
                        // Force kill process tree
                        execSync(`taskkill /F /T /PID ${this.browserPid}`, { 
                            stdio: 'ignore',
                            timeout: 5000 
                        });
                        console.log(`[${this.id}] ✅ Killed Chrome process tree (Windows) PID: ${this.browserPid}`);
                        
                        // Also kill any remaining chrome/chromium processes for this bot
                        try {
                            execSync(`wmic process where "ParentProcessId=${this.browserPid}" delete`, {
                                stdio: 'ignore',
                                timeout: 3000
                            });
                        } catch {}
                    } catch (e) {
                        // Process might already be dead, ignore
                    }
                } else {
                    // Unix: kill process tree more thoroughly
                    try {
                        // Kill all child processes first
                        const { execSync } = require('child_process');
                        try {
                            execSync(`pkill -P ${this.browserPid}`, { stdio: 'ignore', timeout: 3000 });
                        } catch {}
                        
                        // SIGTERM for graceful shutdown
                        process.kill(this.browserPid, 'SIGTERM'); 
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Check if process still exists
                        try {
                            process.kill(this.browserPid, 0); // Signal 0 checks if process exists
                            // Process still exists, force kill
                            process.kill(this.browserPid, 'SIGKILL');
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch {
                            // Process already dead
                        }
                        
                        console.log(`[${this.id}] ✅ Killed Chrome process tree (Unix) PID: ${this.browserPid}`);
                    } catch (e) {
                        // Try direct kill as fallback
                        try { 
                            process.kill(this.browserPid, 'SIGKILL'); 
                        } catch {}
                    }
                }
            }
            
            // Additional cleanup: kill any orphaned Chrome processes for this bot
            // (in case PID file was lost but process still running)
            try {
                const { execSync } = require('child_process');
                const isWindows = process.platform === 'win32';
                const botIdPattern = this.id.slice(0, 8);
                
                if (isWindows) {
                    // Find and kill Chrome processes that might belong to this bot
                    try {
                        execSync(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${botIdPattern}*"`, {
                            stdio: 'ignore',
                            timeout: 3000
                        });
                    } catch {}
                } else {
                    // Unix: kill chrome processes that might be orphaned
                    try {
                        execSync(`pkill -f "chrome.*${botIdPattern}"`, {
                            stdio: 'ignore',
                            timeout: 3000
                        });
                    } catch {}
                }
            } catch (e) {
                // Ignore errors in orphan cleanup
            }
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Error killing browser process:`, e.message);
        }

        // Remove stored PID file (async)
        try { 
            if (await fs.pathExists(this.browserPidFile)) {
                await fs.remove(this.browserPidFile); 
                console.log(`[${this.id}] ✅ Removed PID file`);
            }
        } catch {}
        
        // Final cleanup of any remaining references
        this.page = null;
        this.browser = null;
        this.capture = null;
        this._cdp = null;
        
        console.log(`[${this.id}] ✅ Bot finished and all resources cleaned up`);
        
        // Trigger callback
        try { 
            if (typeof this.onLeave === 'function') this.onLeave(); 
        } catch {}
        
        this.isLeaving = false;
    }

	/**
	 * Bot status for API (GoogleMeetBot style)
	 */
	getStats() {
        let speakerTimeframes = [];
        // Prefer persisted SpeakerTimeframes.json created after offline transcription
        try {
            if (this.speakerTimeframesFile && fs.existsSync(this.speakerTimeframesFile)) {
                const raw = fs.readFileSync(this.speakerTimeframesFile, 'utf8');
                speakerTimeframes = JSON.parse(raw);
            } else {
                speakerTimeframes = this.getSpeakerTimeframes();
            }
        } catch {}

        // Load meeting metrics if available
        let meetingMetrics = null;
        try {
            if (this.metricsFile && fs.existsSync(this.metricsFile)) {
                const raw = fs.readFileSync(this.metricsFile, 'utf8');
                meetingMetrics = JSON.parse(raw);
            }
        } catch {}

		return {
			isCapturing: this.isCapturing,
			recordingPath: this.recordingPath,
			recordingFile: this.recordingPath, // WebM recording file
			participants: this.participants,
			meetingHost: this.meetingHost, // Meeting host name
			speakerTimeframes,
			hasSeenParticipants: this.hasSeenParticipants,
			recordingFormat: 'webm', // MediaRecorder output
			recordingDuration: this.recordingStartedAt ? Date.now() - this.recordingStartedAt : 0,
            captionsFile: this.captionsFile,
            captionsCount: Array.isArray(this.captions) ? this.captions.length : 0,
            meetingMetrics
		};
	}

	/**
	 * Diagnostics for participants/tracks
	 */
	async getParticipantsDiagnostics() {
		const counts = await this.page.evaluate(() => {
			let remoteParticipants = 0;
			try {
				if (window.__remoteParticipants instanceof Map) {
					remoteParticipants = window.__remoteParticipants.size;
				}
			} catch {}
			let liveTracks = 0;
			try {
				liveTracks = (window.__meetingTracks || []).filter(t => t.track && t.track.readyState === 'live').length;
			} catch {}
			return { remoteParticipants, liveTracks };
		});
		const total = await this.getParticipantCount().catch(() => null);
		return { ...counts, totalIncludingBot: total };
	}
    /**
     * Return a cleaned participant display name.
     * – Trim whitespace
     * – Remove newlines and take first line (handles duplicates like "Name\nName")
     * – Drop everything after the first comma or parenthesis
     * – Ignore generic self-view labels ("You", "Your video", etc.)
     * The function is deliberately lenient to avoid throwing inside page.evaluate.
     * @private
     */
    _cleanName(raw) {
        if (!raw) return null;
        // Split by newlines and get the first non-empty line (removes duplicates like "Name\nName")
        const lines = String(raw).split(/\n/).map(l => l.trim()).filter(l => l);
        let candidate = lines.length > 0 ? lines[0] : String(raw).trim();
        // Split on comma or parenthesis and take first part
        candidate = candidate.split(/[,(]/)[0].trim();
        const lower = candidate.toLowerCase();
        if (this._SELF_VIEW_LABELS.includes(lower)) return null;
        return candidate;
    }
}

module.exports = { Bot };