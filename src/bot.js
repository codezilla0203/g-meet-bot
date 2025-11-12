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

        const runtimeRoot = path.join(__dirname, '../runtime');
        this.botDir = path.join(runtimeRoot, this.id);
        this.audioDir = path.join(this.botDir, 'audio');
        this.transcriptsDir = path.join(this.botDir, 'transcripts');
        this.botsPidDir = path.join(runtimeRoot, 'bots');
        try {
            fs.ensureDirSync(this.botsPidDir);
            fs.ensureDirSync(this.botDir);
            fs.ensureDirSync(this.audioDir);
            fs.ensureDirSync(this.transcriptsDir);
        } catch {}
        this.browserPidFile = path.join(this.botsPidDir, `${this.id}.pid`);
        this.outputFile = path.join(this.audioDir, `${this.id}.webm`);
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

        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: { width: 1920, height: 1080 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--enable-features=WebCodecs',
                // Prevent background throttling so recording and captions keep running without focus
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-features=CalculateNativeWinOcclusion',
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
            });
        } catch {}
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

        // Prepare capture helper and inject interceptors
        this.capture = new WebRTCCapture(this.id, this.page);
        await this.capture.injectWebRTCInterceptor();

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
                // Try keyboard shortcut (sometimes works): 'c'
                try { await this.page.keyboard.press('KeyC'); clicked = true; } catch {}
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
     * Start WebRTC recording
     */
    async startRecording() {
        console.log(`[${this.id}] 🎥 Starting recording...`);

        try {
            // Wait for remote media to appear
            await this.page.waitForFunction(() => Array.isArray(window.__meetingTracks) && window.__meetingTracks.some(t => t.type === 'remote'), { polling: 1000, timeout: 120000 }).catch(() => {});
            await this.page.waitForTimeout(1500);

            await this.capture.startContainerCapture(this.outputFile, {
                remoteOnly: true,
                mixAllParticipants: true,
                width: 1280,
                height: 720,
                fps: 15
            });

            await this.capture.startRawCapture({
                audioPath: path.join(this.audioDir, `${this.id}.f32le`),
                videoPath: path.join(this.audioDir, `${this.id}.i420`),
                sampleRate: 48000,
                fps: 5,
                maxWidth: 640,
                maxHeight: 360,
                remoteOnly: true
            });

            // If streaming is enabled, forward raw audio chunks to WS
            if (this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN) {
                this.capture.setAudioForwarder((buffer, sampleRate) => {
                    try {
                        const msg = {
                            type: 'audio',
                            botId: this.id,
                            encoding: 'f32le',
                            sampleRate,
                            chunk: buffer.toString('base64'),
                            ts: Date.now()
                        };
                        this.streamSocket.send(JSON.stringify(msg));
                    } catch {}
                });
            }

            this.isCapturing = true;
            console.log(`[${this.id}] ✅ Recording started`);
        } catch (error) {
            console.error(`[${this.id}] ❌ Failed to start recording:`, error);
            throw error;
        }
    }

    async startCaptionsObserver() {
        try {
            // Bridge to receive caption lines
            await this.page.exposeFunction(`__onCaption_${this.id}`, async (payload) => {
                try {
                    const iso = new Date(payload.ts).toISOString();
                    // Approximate audio offset if raw capture is running
                    let audioOffsetMs = null;
                    try {
                        const startMs = this.capture?.getAudioStartEpochMs?.();
                        if (startMs && Number.isFinite(startMs)) {
                            audioOffsetMs = Math.max(0, payload.ts - startMs);
                        }
                    } catch {}
                    const baseRecord = {
                        ts: payload.ts,
                        iso,
                        botId: this.id,
                        speaker: payload.speaker || '',
                        lang: payload.lang || 'auto',
                        text: payload.text,
                        unit: payload.unit || 'sentence',
                        audioOffsetMs
                    };
                    // 1) Append to transcript files (JSONL per unit)
                    if (baseRecord.unit === 'word') {
                        fs.appendFileSync(this.wordsFile, JSON.stringify(baseRecord) + '\n');
                    } else {
                        fs.appendFileSync(this.sentencesFile, JSON.stringify(baseRecord) + '\n');
                    }
                    // 2) Emit over WS (if connected)
                    if (this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN) {
                        const msg = { type: 'caption', botId: this.id, ...payload };
                        if (audioOffsetMs != null) msg.audioOffsetMs = audioOffsetMs;
                        this.streamSocket.send(JSON.stringify(msg));
                    }
                    // 3) Print sentences only to keep console readable
                    if (baseRecord.unit === 'sentence') {
                        const hhmmss = new Date(payload.ts).toTimeString().split(' ')[0];
                        const display = `${payload.speaker ? payload.speaker + ': ' : ''}${payload.text}`;
                        console.log(`[${this.id}] 💬 ${hhmmss} ${display}`);
                    }
                } catch (e) {
                    // Make sure we at least see errors in console for debugging
                    console.warn(`[${this.id}] ⚠️ Caption pipeline error: ${e.message}`);
                }
            });

            // Inject observer in page context
            await this.page.evaluate((botId) => {
                const send = window[`__onCaption_${botId}`];
                if (!send) return;

                window.__captionLastTs = 0;
                const now = () => Date.now();

                // State: per-speaker incremental buffers and emitted sentences
                const stateBySpeaker = new Map();
                const getState = (speaker) => {
                    const key = speaker || '';
                    if (!stateBySpeaker.has(key)) {
                        stateBySpeaker.set(key, { prevText: '', emittedSentenceKeys: new Set() });
                    }
                    return stateBySpeaker.get(key);
                };

                const looksLikeName = (s) => {
                    if (!s) return false;
                    s = s.trim();
                    if (s.length === 0 || s.length > 60) return false;
                    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s)) return false;
                    const words = s.split(/\s+/).filter(Boolean);
                    if (words.length < 1 || words.length > 4) return false;
                    if (/[:;,.!?]/.test(s)) return false;
                    return true;
                };

                // Ignore obvious system noise (joins/leaves, etc.)
                const isSystemNoise = (text) => {
                    const t = (text || '').toLowerCase();
                    return (
                        t.includes('has left the meeting') ||
                        t.includes('left the meeting') ||
                        t.includes('joined the meeting') ||
                        t.includes('has joined') ||
                        t.includes('raised hand') ||
                        t.includes('lowered hand') ||
                        t.includes('started presenting') ||
                        t.includes('stopped presenting') ||
                        t.includes('muted') ||
                        t.includes('unmuted')
                    );
                };

                const normalizeText = (text) => {
                    if (!text) return '';
                    let t = String(text).replace(/\s+/g, ' ').trim();
                    // Strip leading list/counter markers like "2.", "3)", "(4)", "[5]", "- ", "• "
                    t = t.replace(/^(?:\(?\d{1,3}\)?[.)\-:]|\[\d{1,3}\]|[•–—\-])\s+/u, '');
                    // Collapse stray zero-width and non-breaking spaces
                    t = t.replace(/[\u200B\u00A0]+/g, '');
                    return t;
                };

                const sentenceKey = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

                const sentenceSegments = (t) => {
                    const segs = [];
                    let last = 0;
                    const re = /[^.!?]+[.!?]+/g;
                    let m;
                    while ((m = re.exec(t)) !== null) {
                        const seg = m[0].trim();
                        if (seg) segs.push({ text: seg, complete: true });
                        last = re.lastIndex;
                    }
                    const rem = t.slice(last).trim();
                    if (rem) segs.push({ text: rem, complete: false });
                    return segs;
                };

                const emitWord = (speaker, text) => {
                    const ts = now();
                    window.__captionLastTs = ts;
                    send({ text, speaker: looksLikeName(speaker) ? speaker : '', lang: 'auto', ts, unit: 'word' });
                };
                const emitSentence = (speaker, text) => {
                    const ts = now();
                    window.__captionLastTs = ts;
                    send({ text, speaker: looksLikeName(speaker) ? speaker : '', lang: 'auto', ts, unit: 'sentence' });
                };

                const processCaption = (speaker, rawText) => {
                    let content = normalizeText(rawText);
                    if (!content || content.length < 2) return;
                    if (isSystemNoise(content)) return;

                    const s = getState(speaker);
                    const prev = s.prevText || '';

                    const appended = content.startsWith(prev);
                    const delta = appended ? content.slice(prev.length) : content;

                    // Emit new words only when the text appended (avoid re-emitting on resets/corrections)
                    if (appended && delta) {
                        const tokens = delta.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
                        for (const w of tokens) emitWord(speaker, w);
                    }

                    // Emit any completed new sentences we haven't emitted before
                    const segs = sentenceSegments(content);
                    for (const seg of segs) {
                        if (!seg.complete) continue; // only emit completed sentences
                        const key = sentenceKey(seg.text);
                        if (!s.emittedSentenceKeys.has(key)) {
                            s.emittedSentenceKeys.add(key);
                            emitSentence(speaker, seg.text);
                        }
                    }

                    s.prevText = content;
                };

                const tryParseFromRegion = (region) => {
                    if (!region) return;
                    // Prefer the explicit Meet caption tiles structure if present
                    try {
                        const container = region.closest('[role="region"][aria-label*="caption" i], [aria-label="Captions"]') || region;
                        const tiles = container.querySelectorAll('.nMcdL');
                        if (tiles && tiles.length) {
                            tiles.forEach(tile => {
                                const nameEl = tile.querySelector('.NWpY1d');
                                const textEl = tile.querySelector('.ygicle, .ygicle.VbkSUe');
                                const speaker = (nameEl?.innerText || '').trim();
                                const raw = (textEl?.innerText || '').trim();
                                if (!raw) return;
                                processCaption(speaker, raw);
                            });
                            return; // handled via tiles
                        }
                    } catch {}

                    // Fallback parsing from generic live/log regions
                    let text = (region.innerText || '').trim();
                    if (!text) return;

                    // Common patterns: "Speaker\ncontent" or "Speaker: content"
                    let speaker = '';
                    let content = text;
                    const parts = text.split('\n').filter(Boolean);
                    if (parts.length >= 2 && looksLikeName(parts[0])) {
                        speaker = parts[0].trim();
                        content = parts.slice(1).join(' ').trim();
                    } else {
                        const m = text.match(/^\s*([^:]{1,60}):\s*(.+)$/);
                        if (m && looksLikeName(m[1])) {
                            speaker = m[1].trim();
                            content = m[2].trim();
                        }
                    }
                    processCaption(speaker, content);
                };

                const captionScopeSelector = '[role="region"][aria-label*="caption" i], [aria-label="Captions"], [aria-live], [role="log"], [class*="caption" i], [class*="transcript" i]';

                const obs = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        if (m.type === 'childList') {
                            m.addedNodes.forEach(n => {
                                if (n.nodeType !== Node.ELEMENT_NODE) return;
                                tryParseFromRegion(n.closest ? n.closest(captionScopeSelector) : null);
                                if (n.querySelectorAll) {
                                    n.querySelectorAll(captionScopeSelector).forEach(tryParseFromRegion);
                                }
                            });
                        } else if (m.type === 'characterData') {
                            const p = m.target && m.target.parentElement;
                            tryParseFromRegion(p ? (p.closest ? p.closest(captionScopeSelector) : null) : null);
                        }
                    }
                });
                obs.observe(document.body, { childList: true, subtree: true, characterData: true });
                window.__captionObserver = obs;

                // Seed existing live regions
                try {
                    document.querySelectorAll(captionScopeSelector).forEach(tryParseFromRegion);
                } catch {}
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
    }

    /**
     * Stop recording and save file
     */
    async stopRecording() {
        if (!this.isCapturing) return;

        console.log(`[${this.id}] ⏹️ Stopping recording...`);

        try {
            // Stop raw and container capture via helper
            if (this.capture) {
                await this.capture.stopRawCapture();
                await this.capture.stopContainerCapture();
            }
            this.isCapturing = false;
        } catch (error) {
            console.error(`[${this.id}] ❌ Error stopping recording:`, error);
        }
    }

    /**
     * Get bot status
     */
    getStats() {
        const captureStats = this.capture?.getStats?.() || {};
        return {
            botId: this.id,
            isRecording: this.isCapturing,
            outputFile: this.outputFile,
            rawAudioFile: captureStats.rawAudioFile,
            rawVideoFile: captureStats.rawVideoFile,
            rawMetaFile: captureStats.rawMetaFile,
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
