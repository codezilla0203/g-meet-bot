const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const { WebRTCCapture } = require('./modules/webrtc-capture');
const WebSocket = require('ws');

puppeteer.use(StealthPlugin());

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
    constructor(id, botName = "AI Notetaker", onLeaveCallback = null) {
        this.id = id;
        this.botName = botName;
        this.onLeave = onLeaveCallback;
        
        // Core components
        this.browser = null;
        this.page = null;
        this.isCapturing = false;
        this.isLeaving = false;
        
        // Monitoring
        this.participantCheckInterval = null;
        this.keepAliveInterval = null;
        this._cdp = null;

        // Dedupe memory for finalized sentences per speaker
        this._lastSentenceKeyBySpeaker = new Map();

        const runtimeRoot = path.join(__dirname, '../runtime');
        this.botDir = path.join(runtimeRoot, this.id);
        this.audioDir = path.join(this.botDir, 'audio');
        this.transcriptsDir = path.join(this.botDir, 'transcripts');
        this.videoDir = path.join(this.botDir, 'video');
        this.botsPidDir = path.join(runtimeRoot, 'bots');
        try {
            fs.ensureDirSync(this.botsPidDir);
            fs.ensureDirSync(this.botDir);
            fs.ensureDirSync(this.audioDir);
            fs.ensureDirSync(this.transcriptsDir);
            fs.ensureDirSync(this.videoDir);
        } catch {}
        this.browserPidFile = path.join(this.botsPidDir, `${this.id}.pid`);
        this.outputFile = path.join(this.videoDir, `${this.id}.video.webm`);
        this.audioFile = path.join(this.videoDir, `${this.id}.audio.webm`);
        this.finalFile = path.join(this.videoDir, `${this.id}.final.webm`);
        // Fine-grained transcripts
        this.wordsFile = path.join(this.transcriptsDir, `${this.id}.words.jsonl`);
        this.sentencesFile = path.join(this.transcriptsDir, `${this.id}.sentences.jsonl`);

        // Streaming
        this.streamSocket = null;
        this.hasSeenParticipants = false;
    }

    /**
     * Orchestrate full join + record flow
     */
    async joinMeet(meetUrl) {
        // Setup streaming first so we don't miss early events
        await this.setupStreaming();

        await this.launchBrowser();
        await this.navigateAndJoin(meetUrl);
        await this.waitForAdmission();
        await this.muteInCall();
        await this.ensureTiledLayout();

        // Wait for other participants before enabling captions/recording
        const others = await this.waitForOtherParticipants(120000);
        if (!others) {
            console.log(`[${this.id}] ⏹️ No other participants joined within timeout; leaving.`);
            await this.leaveMeet();
            return;
        }
        this.hasSeenParticipants = true;

        await this.enableCaptions();
        await this.startCaptionsObserver();
        await this.startRecording();
        await this.hideSelfView();
        this.startParticipantMonitoring();
    }
    /**
     * Launch browser with working configuration
     */
    async launchBrowser() {
        console.log(`[${this.id}] 🌐 Launching browser...`);

        const headlessEnv = process.env.BOT_HEADLESS || process.env.HEADLESS || '';
        const headlessMode = headlessEnv === '1' || /^true$/i.test(headlessEnv);
        const extPath = path.join(__dirname, '../chrome-tab-capture');
        this.browser = await puppeteer.launch({
            headless: headlessMode ? 'new' : false,
            defaultViewport: { width: 1920, height: 1080 },
            args: [
                `--load-extension=${extPath}`,
                `--disable-extensions-except=${extPath}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--enable-features=WebCodecs',
                '--enable-usermedia-screen-capturing',
                '--allow-http-screen-capture',
                '--auto-select-desktop-capture-source=Meet',
                // Prevent background throttling so recording and captions keep running without focus
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-features=CalculateNativeWinOcclusion',
                '--disable-background-media-suspend',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-features=BackForwardCache,OptimizationHints',
                '--window-size=1920,1080',
                '--start-maximized'
            ]
        });

        // Handle browser disconnection
        this.browser.on('disconnected', () => {
            console.warn(`[${this.id}] ⚠️ Browser disconnected`);
            if (!this.isLeaving) {
                this.leaveMeet();
            }
            // Best-effort: remove pid file on disconnect
            try { fs.removeSync(this.browserPidFile); } catch {}
        });

        this.page = await this.browser.newPage();
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
                fs.ensureDirSync(this.runtimeDir);
                fs.writeFileSync(this.browserPidFile, String(pid));
            }
        } catch {}
        
        console.log(`[${this.id}] ✅ Browser ready`);
    }

    async startKeepAlive() {
        try {
            this._cdp = await this.page.target().createCDPSession();
            try { await this._cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true }); } catch {}
            try { await this._cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}
            // Re-assert active state periodically
            if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = setInterval(async () => {
                try { await this._cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true }); } catch {}
                try { await this._cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}
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

        try {
            // Navigate to meeting
            await this.page.goto(meetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Grant permissions
            const context = this.browser.defaultBrowserContext();
            await context.overridePermissions(meetUrl, ['microphone', 'camera', 'notifications']);

            // Initial pause to allow pre-join UI to render
            await this.page.waitForTimeout(2000);

            // Do not mute in pre-join screen; we will mute after admission using in-call controls
            
            // Enter name and join
            await this.requestToJoin();

        } catch (error) {
            console.error(`[${this.id}] ❌ Failed to join:`, error.message);
            throw error;
        }
    }

    /**
     * Establish optional WS streaming to the server for audio/captions
     */
    async setupStreaming() {
        try {
            const defaultPort = process.env.PORT || 3000;
            const url = process.env.STREAM_WS_URL || `ws://localhost:${defaultPort}/ws/stream`;
            this.streamSocket = new WebSocket(url);
            this.streamSocket.on('open', () => {
                try { this.streamSocket.send(JSON.stringify({ type: 'hello', botId: this.id })); } catch {}
            });
            this.streamSocket.on('close', () => { this.streamSocket = null; });
            this.streamSocket.on('error', () => {});
        } catch {}
    }

    /**
     * Mute microphone and camera
     */
    /**
     * Verify mic & camera really muted (retry loop)
     */
    async verifyMutedState(maxWaitMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            const state = await this.page.evaluate(() => {
                const result = { audioOff: false, videoOff: false };
                // Heuristic: look for buttons that would now read "Turn on microphone" / "Turn on camera"
                const btns = [...document.querySelectorAll('button[aria-label]')];
                for (const b of btns) {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (label.includes('turn on microphone') || label.includes('unmute microphone')) result.audioOff = true;
                    if (label.includes('turn on camera') || label.includes('turn on video')) result.videoOff = true;
                }
                // Deep check via tracks
                try {
                    if (Array.isArray(window.__meetingTracks)) {
                        const locals = window.__meetingTracks.filter(t => t.type === 'local');
                        for (const t of locals) {
                            if (t.track.kind === 'audio' && t.track.enabled === false) result.audioOff = true;
                            if (t.track.kind === 'video' && t.track.enabled === false) result.videoOff = true;
                        }
                    }
                } catch {}
                return result;
            });
            if (state.audioOff && state.videoOff) {
                console.log(`[${this.id}] ✅ Mic & camera confirmed muted`);
                return true;
            }
            // Attempt re-toggle if still on
            if (!state.audioOff) {
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyD');
                await this.page.keyboard.up('Control');
            }
            if (!state.videoOff) {
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyE');
                await this.page.keyboard.up('Control');
            }
            await this.page.waitForTimeout(600);
        }
        console.warn(`[${this.id}] ⚠️ Timed out verifying muted state; proceeding anyway`);
        return false;
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

            // Allow dynamic validation overlays to settle
            await this.page.waitForTimeout(800);
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
                await this.page.waitForTimeout(400);
            }

            // Candidate XPath expressions for join/ask buttons (include variations)
            const joinXPaths = [
                "//button[.//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ask to join')]]",
                "//button[.//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join now')]]",
                "//button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ask to join')]",
                "//button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join now')]"
            ];

            // Attempt clicking with retries + backoff
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
                        await this.page.waitForTimeout(100);
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
                    await this.page.waitForTimeout(600);
                    // Check if we are in-call (leave button present) then treat as joined
                    const inCall = await this.page.$('button[aria-label*="Leave call"], button[aria-label*="End call"]');
                    if (inCall) {
                        joined = true;
                        break;
                    }
                    await this.page.waitForTimeout(attempt * 400); // backoff
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
     * Wait for organizer to admit the bot
     */
    async waitForAdmission() {
        console.log(`[${this.id}] ⏳ Waiting for admission...`);
        await this.page.waitForSelector('button[aria-label*="Leave call"], button[aria-label*="End call"]', { timeout: 300000 }); // 5 min
        // Mark admitted and clear any stale pre-admission tracks (waiting room artifacts)
        try {
            await this.page.evaluate(() => { window.__admittedSettle = true; if (typeof window.__resetMeetingState === 'function') window.__resetMeetingState(); });
        } catch {}
        // Give a short grace period for real remote media to flow
        await this.page.waitForTimeout(1500);
        console.log(`[${this.id}] ✅ Admitted to meeting & state reset`);
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

                // Open people panel occasionally to force DOM population
                if ((Date.now() - start) % 10000 < 2100) {
                    await this.openPeoplePanel();
                }
            } catch (e) {
                // ignore transient errors
            }
            await this.page.waitForTimeout(2000);
        }
        return false;
    }

    async openPeoplePanel() {
        try {
            // If already open (panel at right), skip
            const isOpen = await this.page.evaluate(() => {
                // Heuristics for right-side panel presence
                const panel = document.querySelector('aside[role="complementary"], div[role="dialog"], div[aria-label*="People" i]');
                if (!panel) return false;
                const hasAddPeople = panel.querySelector('button[aria-label*="Add people" i], button:has(svg)');
                return !!panel && !!panel.innerText && panel.innerText.toLowerCase().includes('in the meeting');
            });
            if (isOpen) return;

            // Attempt to open participants/people panel (varies by UI / locale)
            const xpaths = [
                "//button[@aria-label and contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'show everyone')]",
                "//button[@aria-label and contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'people')]",
                "//button[contains(@aria-label,'Participants')]",
                "//button[.//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'people')]]"
            ];
            let clicked = false;
            for (const xp of xpaths) {
                const btns = await this.page.$x(xp);
                if (btns.length) {
                    await btns[0].click().catch(()=>{});
                    clicked = true;
                    break;
                }
            }
            if (!clicked) {
                // Try with common selectors
                const sels = [
                    'button[aria-label*="People" i]',
                    'button[aria-label*="Everyone" i]',
                    'button[aria-label*="Participants" i]'
                ];
                for (const sel of sels) {
                    const btn = await this.page.$(sel);
                    if (btn) { await btn.click().catch(()=>{}); break; }
                }
            }
            await this.page.waitForTimeout(600);
        } catch {}
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
     * Encourage Meet to deliver many remote video streams by switching to Tiled layout.
     */
    async ensureTiledLayout() {
        try {
            const moreBtnSelectors = [
                'button[aria-label*="More options"]',
                'button[aria-label*="More"]',
                'button[aria-label*="Menu"]'
            ];
            for (const sel of moreBtnSelectors) {
                const btn = await this.page.$(sel);
                if (btn) { await btn.click().catch(()=>{}); await this.page.waitForTimeout(300); break; }
            }
            const layoutXPaths = [
                '//div[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"change layout")]//ancestor::button',
                '//span[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"change layout")]//ancestor::button'
            ];
            for (const xp of layoutXPaths) {
                const items = await this.page.$x(xp);
                if (items.length) { await items[0].click().catch(()=>{}); await this.page.waitForTimeout(250); break; }
            }
            const tiledXPaths = [
                '//div[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"tiled")]//ancestor::button',
                '//span[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"tiled")]//ancestor::button'
            ];
            for (const xp of tiledXPaths) {
                const items = await this.page.$x(xp);
                if (items.length) { await items[0].click().catch(()=>{}); await this.page.waitForTimeout(200); break; }
            }
            const slider = await this.page.$('input[type="range"], div[role="slider"]');
            if (slider) {
                await slider.focus();
                for (let i = 0; i < 12; i++) {
                    await this.page.keyboard.press('ArrowRight');
                    await this.page.waitForTimeout(40);
                }
            }
            await this.page.keyboard.press('Escape');
        } catch {}
    }

    /**
     * Turn on captions after admission (varies by UI)
     */
    async enableCaptions() {
        try {
            console.log(`[${this.id}] 💬 Enabling captions...`);
            // Attempt clicking captions button via common selectors
            const sels = [
                'button[aria-label*="Turn on captions" i]',
                'button[aria-label*="captions" i]',
                'button[aria-label*="Subtitles" i]'
            ];
            let clicked = false;
            for (const sel of sels) {
                const btn = await this.page.$(sel);
                if (btn) {
                    try { await btn.click({ delay: 20 }); clicked = true; break; } catch {}
                }
            }
            if (!clicked) {
                // Fallback: Try keyboard shortcut 'Shift+c'
                try {
                    await this.page.keyboard.down('Shift');
                    await this.page.keyboard.press('KeyC');
                    await this.page.keyboard.up('Shift');
                    clicked = true;
                } catch {}
            }
            await this.page.waitForTimeout(800);
            console.log(`[${this.id}] ✅ Captions toggled`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not enable captions: ${e.message}`);
        }
    }

    /**
     * Mute mic & camera using IN-CALL controls after admission
     */
    async muteInCall() {
        try {
            console.log(`[${this.id}] 🔇 Muting in-call mic and camera...`);
            // Click explicit "Turn off" buttons if visible
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

            // Verify using labels and track state; if still on, retry via shortcuts
            await this.verifyMutedState();
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not mute in-call (non-critical): ${e.message}`);
        }
    }

    /**
     * Start full tab recording (UI + audio) to video folder
     */
    async startRecording() {
        console.log(`[${this.id}] 🎥+🎙️ Starting tab video + remote audio capture...`);
        try {
            await this.page.waitForTimeout(1200);
            await this.capture.startTabCapture(this.outputFile, {
                width: 1280,
                height: 720,
                fps: 25,
                videoBitsPerSecond: 2500000,
                audioBitsPerSecond: 128000
            });
            await this.capture.startRemoteAudioCapture(this.audioFile, { audioBitsPerSecond: 128000 });
            this.isCapturing = true;
            console.log(`[${this.id}] ✅ Video at ${this.outputFile}, audio at ${this.audioFile}`);
        } catch (e) {
            console.error(`[${this.id}] ❌ Failed to start recording:`, e.message);
            this.isCapturing = false;
        }
    }

    async startCaptionsObserver() {
        try {
            // Bridge to receive caption lines from the browser
            await this.page.exposeFunction(`__onCaption_${this.id}`, async (payload) => {
                try {
                    const nowIso = new Date(payload.ts).toISOString();

                    // Normalize shape: default to final if state missing
                    const state = payload.state === 'pending' ? 'pending' : 'final';
                    const speaker = payload.speaker || 'Unknown Speaker';
                    const text = String(payload.text || '').trim();
                    const utteranceId = payload.utteranceId || `${speaker}`;

                    if (!text) return;

                    if (state === 'pending') {
                        // Stream live replacement updates only; don't persist
                        if (this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN) {
                            const msg = {
                                type: 'caption_update',
                                botId: this.id,
                                speaker,
                                utteranceId,
                                text,
                                prevText: payload.prevText || '',
                                ts: payload.ts,
                                iso: nowIso,
                                state: 'pending'
                            };
                            this.streamSocket.send(JSON.stringify(msg));
                        }
                        // Console hint of replacement
                        const hhmmss = new Date(payload.ts).toTimeString().split(' ')[0];
                        console.log(`[${this.id}] ✏️ ${hhmmss} ${speaker}: ${text} [editing]`);
                        return;
                    }

                    // Node-side dedupe by normalized key per speaker+utterance
                    const normalizeKey = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const dedupeKey = normalizeKey(`${speaker}|${utteranceId}|${text}`);
                    const prevKey = this._lastSentenceKeyBySpeaker.get(`${speaker}|${utteranceId}`);
                    if (prevKey === dedupeKey) return;
                    this._lastSentenceKeyBySpeaker.set(`${speaker}|${utteranceId}`, dedupeKey);

                    const record = {
                        ts: payload.ts,
                        iso: nowIso,
                        botId: this.id,
                        speaker,
                        text,
                        unit: 'sentence',
                        utteranceId
                    };

                    // Append only finalized sentences
                    fs.appendFileSync(this.sentencesFile, JSON.stringify(record) + '\n');

                    // Emit final over WS
                    if (this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN) {
                        const msg = { type: 'caption_final', botId: this.id, ...record, state: 'final' };
                        this.streamSocket.send(JSON.stringify(msg));
                    }

                    // Log to console
                        const hhmmss = new Date(payload.ts).toTimeString().split(' ')[0];
                    console.log(`[${this.id}] 💬 ${hhmmss} ${speaker}: ${text}`);

                } catch (e) {
                    console.warn(`[${this.id}] ⚠️ Caption pipeline error: ${e.message}`);
                }
            });

            // Inject the MutationObserver into the page context
            await this.page.evaluate((botId) => {
                const send = window[`__onCaption_${botId}`];
                if (!send) return;

                // Per-speaker buffering and replacement tracking
                const buffers = new Map(); // speaker -> { text, lastSentPending, timer, lastTs, utteranceId }
                const endsWithPunctuation = (t) => /[.!?\u2026]\s*$/.test(String(t || ''));
                const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
                const isSpeakerEcho = (speaker, text) => normalizeText(text).toLowerCase() === normalizeText(speaker).toLowerCase();
                const FINAL_IDLE_MS = 2500; // long pause to finalize if no punctuation
                const PUNCT_STABLE_MS = 900; // short stabilization for punctuated sentences
                const PENDING_THROTTLE_MS = 150; // limit pending spam

                const scheduleFinalize = (speaker) => {
                    const st = buffers.get(speaker);
                    if (!st) return;
                    const text = normalizeText(st.text);
                    const delay = endsWithPunctuation(text) ? PUNCT_STABLE_MS : FINAL_IDLE_MS;
                    if (st.timer) clearTimeout(st.timer);
                    st.timer = setTimeout(() => {
                        const latest = normalizeText(buffers.get(speaker)?.text || '');
                        if (!latest || isSpeakerEcho(speaker, latest)) return;
                        send({ ts: Date.now(), speaker, text: latest, utteranceId: st.utteranceId, state: 'final' });
                        // Start a new utterance id for next turn
                        buffers.delete(speaker);
                    }, delay);
                };

                const maybeSendPending = (speaker, prevText, text) => {
                    const st = buffers.get(speaker);
                    const now = Date.now();
                    if (!st) return;
                    if (st.lastPendingSentAt && (now - st.lastPendingSentAt) < PENDING_THROTTLE_MS) return;
                    const norm = normalizeText(text);
                    if (!norm || norm === st.lastSentPending) return;
                    st.lastSentPending = norm;
                    st.lastPendingSentAt = now;
                    send({ ts: now, speaker, text: norm, prevText, utteranceId: st.utteranceId, state: 'pending' });
                };

                const sameUtteranceHeuristic = (oldText, newText) => {
                    const a = normalizeText(oldText);
                    const b = normalizeText(newText);
                    if (!a) return true;
                    if (b.startsWith(a)) return true; // continuation
                    // small edits/replacements treated as same utterance
                    return Math.abs(b.length - a.length) <= 20;
                };

                const handleCaptionUpdate = (speaker, text) => {
                    if (!speaker) speaker = '';
                    const cleaned = normalizeText(text);
                    if (!cleaned || cleaned.length < 2) return;
                    if (isSpeakerEcho(speaker, cleaned)) return;
                    const now = Date.now();
                    let st = buffers.get(speaker);
                    if (!st) {
                        st = { text: '', lastSentPending: '', lastPendingSentAt: 0, timer: null, lastTs: 0, utteranceId: `${speaker}-${now}` };
                        buffers.set(speaker, st);
                    }
                    const prevText = st.text || '';
                    // If new text looks like a new turn and previous existed without finalization, finalize previous
                    if (prevText && !sameUtteranceHeuristic(prevText, cleaned)) {
                        if (st.timer) clearTimeout(st.timer);
                        // Finalize previous before starting new utterance
                        send({ ts: now - 1, speaker, text: normalizeText(prevText), utteranceId: st.utteranceId, state: 'final' });
                        // Start new utterance id
                        st = { text: '', lastSentPending: '', lastPendingSentAt: 0, timer: null, lastTs: 0, utteranceId: `${speaker}-${now}` };
                        buffers.set(speaker, st);
                    }
                    st.text = cleaned;
                    st.lastTs = now;
                    maybeSendPending(speaker, prevText, cleaned);
                    scheduleFinalize(speaker);
                };

                const observeRegion = (captionRegion) => {
                    let lastKnownSpeaker = "Unknown Speaker";

                    const handleNode = (node) => {
                        if (!(node instanceof HTMLElement)) return;

                        const speakerElem = node.querySelector(".NWpY1d");
                        let speaker = speakerElem?.textContent?.trim() || lastKnownSpeaker;

                        if (speaker && speaker !== "Unknown Speaker") {
                            lastKnownSpeaker = speaker;
                        }

                        const clone = node.cloneNode(true);
                        const speakerLabelInClone = clone.querySelector(".NWpY1d");
                        if (speakerLabelInClone) speakerLabelInClone.remove();

                        const caption = clone.textContent?.trim() || "";

                        if (caption) {
                            handleCaptionUpdate(speaker, caption);
                        }
                    };

                    const observer = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            const nodes = Array.from(mutation.addedNodes);
                            if (nodes.length > 0) {
                                nodes.forEach((node) => {
                                    if (node instanceof HTMLElement) {
                                        handleNode(node);
                                    }
                                });
                            } else if (
                                mutation.type === "characterData" &&
                                mutation.target.parentElement instanceof HTMLElement
                            ) {
                                handleNode(mutation.target.parentElement);
                        }
                    }
                });

                    observer.observe(captionRegion, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                    window.__captionObserver = observer;
                };
                
                const interval = setInterval(() => {
                    const region = document.querySelector('[role="region"][aria-label*="Captions"]');
                    if (region) {
                        clearInterval(interval);
                        observeRegion(region);
                    }
                }, 1000);

            }, this.id);

            console.log(`[${this.id}] ✅ Captions observer started`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not start captions observer: ${e.message}`);
        }
    }

    /**
     * Hide bot's self view from the recording
     */
    async hideSelfView() {
        try {
            console.log(`[${this.id}] 👤 Hiding self view...`);
            
            await this.page.waitForTimeout(3000);
            
            await this.page.evaluate((botName) => {
                const style = document.createElement('style');
                style.textContent = `
                    [data-self-name*="${botName}"],
                    [aria-label*="${botName}"] {
                        display: none !important;
                    }
                `;
                document.head.appendChild(style);
            }, this.botName);
            
            console.log(`[${this.id}] ✅ Self view hidden`);
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ Could not hide self view`);
        }
    }

    /**
     * Monitor participants and auto-leave when empty
     */
    startParticipantMonitoring() {
        console.log(`[${this.id}] 👥 Starting participant monitoring...`);
        
        let lastLoggedCount = null;
        let emptyStreak = 0;
        const leaveThreshold = 3; // require 3 consecutive empty readings before leaving

        this.participantCheckInterval = setInterval(async () => {
            try {
                const participantCount = await this.getParticipantCount();
                // Log only on change to reduce noise/flicker
                if (participantCount !== lastLoggedCount) {
                    console.log(`[${this.id}] 👥 Participants (including bot): ${participantCount}`);
                    lastLoggedCount = participantCount;
                }

                // Leave immediately if bot is alone in the room
                if (participantCount <= 1) {
                    emptyStreak++;
                    if (emptyStreak >= leaveThreshold) {
                        console.log(`[${this.id}] 🚪 Meeting empty for ${emptyStreak} checks, leaving...`);
                        this.leaveMeet();
                    }
                } else {
                    emptyStreak = 0;
                }

            } catch (error) {
                console.warn(`[${this.id}] ⚠️ Participant check error:`, error.message);
            }
        }, 5000);
    }

    /**
     * Leave meeting and cleanup
     */
    async leaveMeet() {
        if (this.isLeaving) return;
        this.isLeaving = true;

        console.log(`[${this.id}] 🧹 Leaving meeting...`);

        // Stop monitoring
        if (this.participantCheckInterval) {
            clearInterval(this.participantCheckInterval);
        }

        // Stop recording and save
        if (this.isCapturing) {
            await this.stopRecording();
        }

        // Stop keep-alive
        await this.stopKeepAlive();

        // Close browser
        if (this.browser) {
            await this.browser.close();
        }

        // Remove PID file
        try { fs.removeSync(this.browserPidFile); } catch {}

        console.log(`[${this.id}] ✅ Bot finished`);

        // Trigger callback
        if (this.onLeave) {
            this.onLeave();
        }
        // Reset dedupe cache
        try { this._lastSentenceKeyBySpeaker.clear(); } catch {}
    }

    /**
     * Stop recording and save file
     */
    async stopRecording() {
        const { execFile } = require('child_process');
        let ffmpeg;
        try { ffmpeg = require('ffmpeg-static'); } catch {}

        try {
            if (this.isCapturing) {
                await this.capture.stopTabCapture();
                await this.capture.stopRemoteAudioCapture();
            }
        } catch {}

        // Mux if ffmpeg available and files exist
        try {
            if (ffmpeg && await fs.pathExists(this.outputFile) && await fs.pathExists(this.audioFile)) {
                await new Promise((res, rej) => {
                    execFile(ffmpeg, ['-y','-i', this.outputFile, '-i', this.audioFile, '-c:v','copy','-c:a','copy', this.finalFile], (err)=> err?rej(err):res());
                });
                console.log(`[${this.id}] 🎬 Muxed A+V -> ${this.finalFile}`);
            } else {
                console.warn(`[${this.id}] ⚠️ ffmpeg not available or capture files missing; skipping mux.`);
            }
        } catch (e) {
            console.warn(`[${this.id}] ⚠️ ffmpeg mux error: ${e.message}`);
        }
        this.isCapturing = false;
        return;
    }

    /**
     * Get bot status
     */
    getStats() {
        return {
            botId: this.id,
            isRecording: this.isCapturing,
            outputFile: this.finalFile,
            rawAudioFile: null,
            rawVideoFile: null,
            rawMetaFile: null,
            hasSeenParticipants: this.hasSeenParticipants
        };
    }

    /**
     * Diagnostics: return detailed participants and track info from page context
     */
    async getParticipantsDiagnostics() {
        try {
            const data = await this.page.evaluate(() => {
                const result = { inCall: false, uiCount: null, remoteParticipants: [], meetingTracks: { total: 0, remote: 0, local: 0 } };
                result.inCall = !!document.querySelector('button[aria-label*="Leave call"], button[aria-label*="End call"]');
                try {
                    const btns = Array.from(document.querySelectorAll('button[aria-label]'));
                    for (const b of btns) {
                        const label = (b.getAttribute('aria-label') || '');
                        if (/people|participants|everyone/i.test(label)) {
                            const m = label.match(/\((\d+)\)/);
                            if (m && m[1]) { result.uiCount = parseInt(m[1], 10); break; }
                        }
                    }
                } catch {}
                try {
                    const tracks = Array.isArray(window.__meetingTracks) ? window.__meetingTracks : [];
                    result.meetingTracks.total = tracks.length;
                    result.meetingTracks.remote = tracks.filter(t => t.type === 'remote').length;
                    result.meetingTracks.local = tracks.filter(t => t.type === 'local').length;
                } catch {}
                try {
                    if (window.__remoteParticipants instanceof Map) {
                        window.__remoteParticipants.forEach(p => {
                            result.remoteParticipants.push({ id: p.id, tracks: Array.from(p.tracks || []), kinds: Array.from(p.kinds || []), lastSeen: p.lastSeen });
                        });
                    }
                } catch {}
                return result;
            });
            return data;
        } catch (e) {
            return { error: e.message };
        }
    }
}

module.exports = { Bot };
