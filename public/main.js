(() => {
	const meetUrlInput = document.getElementById('meetUrl');
	const botNameInput = document.getElementById('botName');
	const captionLanguageSelect = document.getElementById('captionLanguage');
	const startBtn = document.getElementById('startBtn');
	const statusEl = document.getElementById('status');
	const badgesEl = document.getElementById('badges');
	const authCard = document.getElementById('authCard');
	const appSection = document.getElementById('appSection');
	const userInfoEl = document.getElementById('userInfo');
	const userEmailEl = document.getElementById('userEmail');
	const logoutBtn = document.getElementById('logoutBtn');
	const botList = document.getElementById('botList');
	const botListView = document.getElementById('botListView');
	const botDetailView = document.getElementById('botDetailView');
	const botDetailContent = document.getElementById('botDetailContent');
	const backButton = document.getElementById('backButton');

	let botId = null;
	let pollInterval = null;
	let botListRefreshInterval = null;
	let lastBotListHash = null;
	let currentUser = null;

	const STORAGE_BOT_PREFIX = 'aiNotetakerBots:';

	function setStatus(text) {
		statusEl.textContent = text;
	}

	function getAuthToken() {
		return localStorage.getItem('token');
	}

	function getUserEmail() {
		return localStorage.getItem('userEmail');
	}

	/**
	 * Decode JWT token (base64 decode payload)
	 * JWT format: header.payload.signature
	 */
	function decodeJWT(token) {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) return null;
			
			// Decode payload (second part)
			const payload = parts[1];
			// Add padding if needed for base64 decode
			const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
			const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
			return JSON.parse(decoded);
		} catch (e) {
			console.error('Error decoding JWT:', e);
			return null;
		}
	}

	/**
	 * Check if JWT token is expired
	 * Returns true if expired or invalid, false if valid
	 */
	function isTokenExpired(token) {
		if (!token) return true;
		
		const decoded = decodeJWT(token);
		if (!decoded || !decoded.exp) return true;
		
		// exp is in seconds, Date.now() is in milliseconds
		const expirationTime = decoded.exp * 1000;
		const now = Date.now();
		
		// Check if expired (with 5 second buffer to account for clock skew)
		return now >= (expirationTime - 5000);
	}

	/**
	 * Check token expiration and handle if expired
	 * Returns true if token is valid, false if expired/invalid
	 */
	function checkTokenExpiration() {
		const token = getAuthToken();
		
		if (!token) {
			clearAuth();
			return false;
		}
		
		if (isTokenExpired(token)) {
			console.warn('⚠️ Session expired');
			clearAuth();
			return false;
		}
		
		return true;
	}

	function setCurrentUser(email) {
		currentUser = { email };
		authCard.classList.add('hidden');
		appSection.classList.remove('hidden');
		userInfoEl.classList.remove('hidden');
		userEmailEl.textContent = email;
	}

	function clearAuth(showMessage = true) {
		// Stop all intervals
		stopBotListAutoRefresh();
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		
		// Show notification if requested
		if (showMessage) {
			setStatus('⚠️ Session expired. Redirecting to sign in...');
			// Show for 2 seconds before redirecting
			setTimeout(() => {
				localStorage.removeItem('token');
				localStorage.removeItem('userEmail');
				window.location.href = '/signin.html';
			}, 2000);
		} else {
			// Immediate logout (e.g., manual logout)
			localStorage.removeItem('token');
			localStorage.removeItem('userEmail');
			window.location.href = '/signin.html';
		}
	}

	/**
	 * Show welcome message for first-time users in the main app
	 */
	function showMainAppWelcome(email) {
		// Create a simple welcome notification
		const welcomeAlert = document.createElement('div');
		welcomeAlert.style.cssText = `
			position: fixed;
			top: 20px;
			right: 20px;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			padding: 20px 25px;
			border-radius: 12px;
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
			z-index: 10000;
			max-width: 350px;
			font-family: 'Poppins', sans-serif;
			animation: slideInRight 0.4s ease-out;
		`;
		
		welcomeAlert.innerHTML = `
			<div style="display: flex; align-items: center; margin-bottom: 10px;">
				<div style="font-size: 24px; margin-right: 10px;">🎉</div>
				<div>
					<div style="font-weight: 600; font-size: 16px;">Welcome to CXFlow!</div>
					<div style="font-size: 14px; opacity: 0.9;">Hello, ${email.split('@')[0]}!</div>
				</div>
			</div>
			<div style="font-size: 14px; line-height: 1.4; margin-bottom: 15px;">
				You're all set! Start by creating your first meeting bot to experience AI-powered meeting transcription and summaries.
			</div>
			<button onclick="this.parentElement.remove()" style="
				background: rgba(255, 255, 255, 0.2);
				border: none;
				color: white;
				padding: 8px 16px;
				border-radius: 6px;
				cursor: pointer;
				font-size: 14px;
				font-weight: 500;
				font-family: 'Poppins', sans-serif;
			">Got it!</button>
		`;
		
		// Add animation styles
		const style = document.createElement('style');
		style.textContent = `
			@keyframes slideInRight {
				from {
					opacity: 0;
					transform: translateX(100px);
				}
				to {
					opacity: 1;
					transform: translateX(0);
				}
			}
		`;
		document.head.appendChild(style);
		
		document.body.appendChild(welcomeAlert);
		
		// Auto-remove after 8 seconds
		setTimeout(() => {
			if (welcomeAlert.parentElement) {
				welcomeAlert.style.animation = 'slideInRight 0.3s ease-out reverse';
				setTimeout(() => welcomeAlert.remove(), 300);
			}
		}, 8000);
	}

	function initAuth() {
		const token = getAuthToken();
		const email = getUserEmail();

		if (!token || !email) {
			window.location.href = '/signin.html';
			return;
		}

		// Check if token is expired
		if (isTokenExpired(token)) {
			console.warn('⚠️ Session expired on page load');
			clearAuth();
			return;
		}

		setCurrentUser(email);

		// Check if this is a first-time user (no welcome shown before)
		const hasSeenWelcome = localStorage.getItem('hasSeenWelcome');
		if (!hasSeenWelcome) {
			showMainAppWelcome(email);
			localStorage.setItem('hasSeenWelcome', 'true');
		}

		logoutBtn.addEventListener('click', () => {
			clearAuth(false); // Immediate logout for manual logout
		});

		// Token expiration is only checked:
		// 1. On page load/refresh (already checked above)
		// 2. Before API calls (checked in fetchAllBots, openBotDetail, startBot)
		// No periodic checks - user can stay logged in as long as they're active
	}

	// Tab switching
	function initTabs() {
		const tabs = document.querySelectorAll('.tab');
		const tabContents = document.querySelectorAll('.tab-content');

		tabs.forEach(tab => {
			tab.addEventListener('click', () => {
				const targetTab = tab.dataset.tab;

				tabs.forEach(t => t.classList.remove('active'));
				tab.classList.add('active');

				tabContents.forEach(content => {
					content.classList.remove('active');
				});

				if (targetTab === 'create-bot') {
					document.getElementById('createBotTab').classList.add('active');
				} else if (targetTab === 'my-bots') {
					document.getElementById('myBotsTab').classList.add('active');
					loadAllBots(true); // Force initial load
					// Start auto-refresh when on My Bots tab
					startBotListAutoRefresh();
				} else {
					// Stop auto-refresh when leaving My Bots tab
					stopBotListAutoRefresh();
				}
			});
		});
	}

	// Auto-refresh bot list to sync with DB changes (only refreshes if data changed)
	function startBotListAutoRefresh() {
		// Clear any existing interval
		if (botListRefreshInterval) {
			clearInterval(botListRefreshInterval);
		}
		
		// Check for changes every 10 seconds (loadAllBots will skip if hash unchanged)
		botListRefreshInterval = setInterval(() => {
			loadAllBots(); // Will only refresh if hash changed
		}, 10000);
		
		console.log('✅ Started auto-refresh for bot list (checks every 10 seconds, refreshes only if changed)');
	}

	function stopBotListAutoRefresh() {
		if (botListRefreshInterval) {
			clearInterval(botListRefreshInterval);
			botListRefreshInterval = null;
			console.log('⏹️  Stopped auto-refresh for bot list');
		}
	}

	function fmtTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
		const s = Math.floor(seconds % 60);
		const m = Math.floor((seconds / 60) % 60);
		const h = Math.floor(seconds / 3600);
		const pad = (n) => String(n).padStart(2, '0');
		if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
		return `${pad(m)}:${pad(s)}`;
	}

	function fmtDate(timestamp) {
		if (!timestamp) return 'N/A';
		const date = new Date(timestamp);
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function setBadges(botId, captionsCount) {
		badgesEl.innerHTML = '';
		if (!botId) return;
		const idBadge = document.createElement('span');
		idBadge.className = 'badge';
		idBadge.innerHTML = `<span class="badge-label">Bot ID:</span> ${botId}`;
		badgesEl.appendChild(idBadge);

		if (typeof captionsCount === 'number' && captionsCount > 0) {
			const capBadge = document.createElement('span');
			capBadge.className = 'badge';
			capBadge.innerHTML = `<span class="badge-label">Captions:</span> ${captionsCount}`;
			badgesEl.appendChild(capBadge);
		}
	}

	function buildUtterances(captions, meetingStartTime = null) {
		if (!Array.isArray(captions) || captions.length === 0) return [];

		const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
		const utterances = [];
		let current = null;
		
		// Use meeting start time from bot data (from extension's meetingStartTimeStamp)
		let meetingStartTimeMs = null;
		if (meetingStartTime) {
			try {
				meetingStartTimeMs = new Date(meetingStartTime).getTime();
				console.log(`📅 Using meeting start time from bot: ${meetingStartTime}`);
			} catch (e) {
				console.warn('Failed to parse meeting start time:', meetingStartTime);
			}
		}
		
		// Fallback: find the earliest timestampMs
		if (!meetingStartTimeMs) {
			for (const cap of sorted) {
				if (cap.timestampMs) {
					if (!meetingStartTimeMs || cap.timestampMs < meetingStartTimeMs) {
						meetingStartTimeMs = cap.timestampMs;
					}
				}
			}
			console.log(`📅 Fallback: using earliest caption time: ${meetingStartTimeMs ? new Date(meetingStartTimeMs).toISOString() : 'not found'}`);
		}

		for (const cap of sorted) {
			const speaker = (cap.personName || cap.speaker || 'Unknown Speaker').trim();
			const text = String(cap.personTranscript || cap.text || '').trim();
			
			// Use timestampMs - meetingStartTimeMs to get the actual speaker start time
			let startTimeSeconds = 0;
			if (cap.timestampMs && meetingStartTimeMs) {
				// Calculate seconds from meeting start using timestampMs
				startTimeSeconds = (cap.timestampMs - meetingStartTimeMs) / 1000;
				console.log(`🎤 Speaker ${speaker} start time: ${startTimeSeconds.toFixed(1)}s from meeting start`);
			} else {
				// Fallback to offsetSeconds if no timestampMs
				startTimeSeconds = Number.isFinite(cap.offsetSeconds) ? cap.offsetSeconds : 0;
				console.warn(`⚠️ Using offsetSeconds fallback for ${speaker}: ${startTimeSeconds}s`);
			}

			if (!text) continue;

			if (!current) {
				current = { speaker, startOffset: startTimeSeconds, text, lastText: text, lastOffset: startTimeSeconds };
				continue;
			}

			const sameSpeaker = speaker === current.speaker;
			const gapSeconds = startTimeSeconds - current.lastOffset;

			if (sameSpeaker && gapSeconds <= 5) {
				if (text.length >= current.lastText.length && text.startsWith(current.lastText.slice(0, 10))) {
					current.text = text;
					current.lastText = text;
					current.lastOffset = startTimeSeconds;
				} else {
					current.text = `${current.text} ${text}`;
					current.lastText = current.text;
					current.lastOffset = startTimeSeconds;
				}
			} else {
				utterances.push({
					speaker: current.speaker,
					startOffset: current.startOffset,
					text: current.text,
				});
				current = { speaker, startOffset: startTimeSeconds, text, lastText: text, lastOffset: startTimeSeconds };
			}
		}

		if (current) {
			utterances.push({
				speaker: current.speaker,
				startOffset: current.startOffset,
				text: current.text,
			});
		}

		return utterances;
	}


	function getBotHistoryKey() {
		const email = getUserEmail();
		if (!email) return null;
		return `${STORAGE_BOT_PREFIX}${email}`;
	}

	function saveBotToHistory(botId, meetUrl) {
		const key = getBotHistoryKey();
		if (!key) return;
		let list = [];
		try {
			const raw = localStorage.getItem(key);
			list = raw ? JSON.parse(raw) : [];
			if (!Array.isArray(list)) list = [];
		} catch {
			list = [];
		}
		list.unshift({ botId, meetUrl, createdAt: new Date().toISOString() });
		localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
	}

	function loadBotHistory() {
		const key = getBotHistoryKey();
		if (!key) return [];
		try {
			const raw = localStorage.getItem(key);
			const list = raw ? JSON.parse(raw) : [];
			return Array.isArray(list) ? list : [];
		} catch {
			return [];
		}
	}

	async function fetchAllBots() {
		try {
			// Check token expiration before making request
			if (!checkTokenExpiration()) {
				return { bots: [], hash: null };
			}

			const token = getAuthToken();
			const response = await fetch('/api/bots', {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`
				}
			});

			if (response.status === 401) {
				clearAuth();
				return { bots: [], hash: null };
			}

			if (response.ok) {
				const data = await response.json();
				// Handle both old format (array) and new format (object with hash)
				if (Array.isArray(data)) {
					return { bots: data, hash: null };
				}
				return data; // { bots: [], hash: '', timestamp: ... }
			}
			return { bots: [], hash: null };
		} catch (error) {
			
			return { bots: [], hash: null };
		}
	}

	async function loadAllBots(forceRefresh = false) {
		try {
			// Fetch bots from API (includes DB bots + historical bots from runtime directory)
			const data = await fetchAllBots();
			const { bots, hash } = data;
			
			// Check if data changed (hash comparison)
			if (!forceRefresh && lastBotListHash !== null && hash !== null && hash === lastBotListHash) {
				// No changes, skip rendering
				return;
			}
			
			// Update hash and render
			lastBotListHash = hash;
			renderBotList(bots || []);
		} catch (error) {
			console.error('Error loading bots:', error);
			botList.innerHTML = `
				<div class="empty-state">
					<div class="empty-state-icon">⚠️</div>
					<div class="empty-state-text">Failed to load bots. Please refresh the page.</div>
				</div>
			`;
		}
	}

	function renderBotList(bots) {
		botList.innerHTML = '';

		if (bots.length === 0) {
			botList.innerHTML = `
				<div class="empty-state">
					<div class="empty-state-icon">
						<img src="https://www.cxflow.io/app/images/logo.png" alt="CXFlow Logo" style="width: 48px; height: 48px;">
					</div>
					<div class="empty-state-text">No bots created yet. Go to "Create Bot" tab to start!</div>
				</div>
			`;
			return;
		}

		bots.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		for (const bot of bots) {
			const item = document.createElement('div');
			item.className = 'bot-item';

			const statusClass = bot.status === 'completed' ? 'status-completed' : 
							   bot.status === 'recording' ? 'status-recording' : 
							   'status-failed';

			item.innerHTML = `
				<div class="bot-info">
					<div class="bot-id">
						<img src="https://www.cxflow.io/app/images/logo.png" alt="CXFlow Logo" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px;">${bot.isHistorical ? ' (Historical)' : ''} ${bot.id}
						${bot.isHistorical ? '<span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 8px; font-size: 10px; margin-left: 8px; font-weight: 500;">HISTORICAL</span>' : ''}
					</div>
					<div class="bot-meta">
						<span>📅 Created: ${fmtDate(bot.createdAt)}</span>
						<span>🎯 Status: <span class="status-badge ${statusClass}">${bot.status || 'unknown'}</span></span>
						${bot.title ? `<span>📝 ${bot.title}</span>` : ''}
					</div>
				</div>
				<div class="bot-actions">
					<button class="btn-small" onclick="window.openBotDetail('${bot.id}')">View Details</button>
				</div>
			`;

			botList.appendChild(item);
		}
	}

	async function openBotDetail(botId) {
		botListView.classList.add('hidden');
		botDetailView.classList.remove('hidden');

		botDetailContent.innerHTML = '<div class="empty-state"><p>Loading bot details...</p></div>';

		try {
			// Check token expiration before making request
			if (!checkTokenExpiration()) {
				return;
			}

			const token = getAuthToken();
			const response = await fetch(`/api/bots/${botId}`, {
				headers: {
					'Authorization': `Bearer ${token}`
				}
			});

			if (!response.ok) {
				botDetailContent.innerHTML = '<div class="empty-state"><p>Failed to load bot details</p></div>';
				return;
			}

			const bot = await response.json();
			console.log(`✅ Bot data received:`, {
				id: bot.id,
				status: bot.status,
				hasTranscript: bot.transcript && bot.transcript.length > 0,
				hasSummary: !!bot.summary,
				transcriptLength: bot.transcript ? bot.transcript.length : 0,
				summaryLength: bot.summary ? bot.summary.length : 0
			});
			
			// Use transcript from API response (already loaded from RUNTIME_ROOT)
			let transcript = bot.transcript || [];
			let summary = bot.summary || '';

			// Try legacy API only if needed
			if (!transcript || transcript.length === 0) {
				try {
					const tRes = await fetch(`/v1/transcripts/${encodeURIComponent(botId)}`);
					if (tRes.ok) {
						const tData = await tRes.json();
						transcript = Array.isArray(tData.captions) ? tData.captions : [];
						console.log(`✅ Loaded ${transcript.length} captions from legacy API`);
					}
				} catch (e) {
					console.error('Failed to fetch transcript from legacy API:', e);
				}
			}

			// Use meeting start time from metrics if available, otherwise fall back to createdAt
			const meetingStartTime = bot.metrics?.duration?.startTime || bot.createdAt;
			const utterances = buildUtterances(transcript, meetingStartTime);
			console.log(`📝 Built ${utterances.length} utterances from transcript`);
			
			// Check if OpenAI is generating summary (bot completed but no summary yet)
			const isSummaryGenerating = bot.status === 'completed' && (!summary || summary.trim() === '') && utterances.length > 0;
			
			// No manual summary generation - only use OpenAI-generated summaries
			if (!summary) {
				summary = null;
			}

			renderBotDetail(bot, utterances, summary);
			
			// If summary is being generated, poll for updates
			if (isSummaryGenerating) {
				startSummaryPolling(botId);
			}
		} catch (error) {
			botDetailContent.innerHTML = '<div class="empty-state"><p>Error loading bot details</p></div>';
		}
	}

	let summaryPollingInterval = null;
	function startSummaryPolling(botId) {
		// Clear any existing polling
		if (summaryPollingInterval) {
			clearInterval(summaryPollingInterval);
		}
		
		let pollCount = 0;
		const maxPolls = 60; // Poll for up to 5 minutes (60 * 5 seconds)
		
		summaryPollingInterval = setInterval(async () => {
			pollCount++;
			
			if (pollCount > maxPolls) {
				clearInterval(summaryPollingInterval);
				summaryPollingInterval = null;
				// Show timeout message
				const summaryContent = document.querySelector('.summary-content');
				if (summaryContent) {
					summaryContent.innerHTML = '<div class="summary-loading"><p style="color: #ef4444;">Summary generation is taking longer than expected. Please refresh the page.</p></div>';
				}
				return;
			}
			
			try {
				const token = getAuthToken();
				const response = await fetch(`/api/bots/${botId}`, {
					headers: {
						'Authorization': `Bearer ${token}`
					}
				});
				
				if (response.ok) {
					const bot = await response.json();
					const summary = bot.summary || '';
					
					// If summary is now available, update the UI and stop polling
					if (summary && summary.trim() !== '') {
						clearInterval(summaryPollingInterval);
						summaryPollingInterval = null;
						
						// Format and update summary
						const formattedSummary = summary
							.replace(/^# (.+)$/gm, '<h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600;">$1</h3>')
							.replace(/^## (.+)$/gm, '<h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">$1</h4>')
							.replace(/^### (.+)$/gm, '<h5 style="margin: 8px 0 4px 0; font-size: 13px; font-weight: 600;">$1</h5>')
							.replace(/^• (.+)$/gm, '<li style="margin-left: 20px;">$1</li>')
							.replace(/\n\n/g, '<br><br>')
							.replace(/\n/g, '<br>');
						
						const summaryContent = document.querySelector('.summary-content');
						if (summaryContent) {
							summaryContent.innerHTML = formattedSummary;
						}
						
						// Update keywords if available
						if (bot.keywords && Array.isArray(bot.keywords) && bot.keywords.length > 0) {
							const keywordsTags = document.getElementById('keywordsTags');
							if (keywordsTags) {
								keywordsTags.innerHTML = renderKeywords(bot.keywords);
							}
						}
					}
				}
			} catch (error) {
				console.error('Error polling for summary:', error);
			}
		}, 5000); // Poll every 5 seconds
	}

	// Shared color palette for speakers (consistent across all tabs)
	const SPEAKER_COLORS = [
		'#3b82f6', // blue
		'#10b981', // green
		'#f59e0b', // orange
		'#ef4444', // red
		'#8b5cf6', // purple
		'#ec4899', // pink
		'#06b6d4', // cyan
		'#84cc16', // lime
		'#f97316', // orange-red
		'#6366f1'  // indigo
	];

	// Shared function to get speaker color (consistent across all tabs)
	function getSpeakerColor(speaker, allSpeakers) {
		if (!speaker || !allSpeakers) return '#6b7280';
		const speakerIndex = allSpeakers.indexOf(speaker);
		if (speakerIndex === -1) return '#6b7280';
		return SPEAKER_COLORS[speakerIndex % SPEAKER_COLORS.length];
	}

	// Shared function to get speaker initial
	function getSpeakerInitial(name) {
		if (!name) return '?';
		const parts = name.trim().split(/\s+/);
		if (parts.length >= 2) {
			return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
		}
		return name[0].toUpperCase();
	}

	function renderKeywords(keywordsData) {
		// Handle both array (OpenAI-generated) and object (metrics-based) formats
		let keywords = [];
		if (Array.isArray(keywordsData)) {
			// OpenAI-generated keywords (array)
			keywords = keywordsData;
		} else if (keywordsData && typeof keywordsData === 'object') {
			// Metrics-based keywords (object with counts)
			keywords = Object.keys(keywordsData).sort((a, b) => keywordsData[b] - keywordsData[a]);
		}
		
		if (!keywords || keywords.length === 0) {
			return '<span class="no-keywords">No keywords found</span>';
		}
		
		const keywordColors = [
			'#a78bfa', // purple
			'#86efac', // light green
			'#fca5a5', // light red/pink
			'#fde047', // pale yellow-green
			'#93c5fd', // light blue
			'#f9a8d4', // light pink
			'#c4b5fd', // light purple
			'#6ee7b7'  // mint green
		];
		
		let html = '';
		keywords.forEach((keyword, index) => {
			const color = keywordColors[index % keywordColors.length];
			html += `<span class="keyword-tag" style="background-color: ${color};">${keyword}</span>`;
		});
		return html;
	}

	function renderSpeakerTalkTime(bot, utterances, container) {
		const talkTime = bot.metrics?.talkTime?.byParticipant || {};
		
		if (!talkTime || Object.keys(talkTime).length === 0) {
			container.innerHTML = '<div class="empty-state"><p>No speaker talk time data available</p></div>';
			return;
		}
		
		// Calculate word count per speaker from utterances
		const speakerWordCounts = {};
		if (utterances && utterances.length > 0) {
			utterances.forEach(utt => {
				if (utt.speaker && utt.text) {
					const wordCount = utt.text.trim().split(/\s+/).filter(w => w.length > 0).length;
					speakerWordCounts[utt.speaker] = (speakerWordCounts[utt.speaker] || 0) + wordCount;
				}
			});
		}
		
		// Sort speakers by total time (descending)
		const speakers = Object.entries(talkTime).sort((a, b) => b[1].totalMs - a[1].totalMs);
		
		// Get all unique speakers in consistent order (same as transcript) for color mapping
		const allSpeakers = utterances && utterances.length > 0 
			? [...new Set(utterances.map(u => u.speaker).filter(Boolean))]
			: Object.keys(talkTime);
		
		let html = `
			<div class="talktime-table">
				<div class="talktime-header-row">
					<div class="talktime-header-cell speakers-header">SPEAKERS</div>
					<div class="talktime-header-cell wpm-header">WPM</div>
					<div class="talktime-header-cell talktime-header">TALKTIME</div>
				</div>
		`;
		
		speakers.forEach(([speaker, data]) => {
			const percentage = data.percentage || 0;
			const totalMinutes = data.totalMinutes || (data.totalSeconds / 60);
			const wordCount = speakerWordCounts[speaker] || 0;
			const wpm = totalMinutes > 0 ? Math.round(wordCount / totalMinutes) : 0;
			
			const speakerInitial = getSpeakerInitial(speaker);
			const speakerColor = getSpeakerColor(speaker, allSpeakers);
			
			// Create donut chart SVG
			const radius = 16;
			const circumference = 2 * Math.PI * radius;
			const offset = circumference - (percentage / 100) * circumference;
			
			html += `
				<div class="talktime-row">
					<div class="talktime-cell speaker-cell">
						<div class="speaker-icon" style="background-color: ${speakerColor};">
							${speakerInitial}
						</div>
						<span class="speaker-name">${speaker}</span>
					</div>
					<div class="talktime-cell wpm-cell">
						<span class="wpm-dot"></span>
						<span class="wpm-value">${wpm}</span>
					</div>
					<div class="talktime-cell talktime-cell-chart">
						<svg class="donut-chart" width="40" height="40">
							<circle class="donut-background" cx="20" cy="20" r="${radius}" fill="none" stroke="#e5e7eb" stroke-width="4"/>
							<circle class="donut-progress" cx="20" cy="20" r="${radius}" fill="none" stroke="#8b5cf6" stroke-width="4" 
								stroke-dasharray="${circumference}" 
								stroke-dashoffset="${offset}"
								transform="rotate(-90 20 20)"/>
						</svg>
						<span class="talktime-percentage">${percentage.toFixed(0)}%</span>
					</div>
				</div>
			`;
		});
		
		html += '</div>';
		container.innerHTML = html;
	}

	function renderBotDetail(bot, utterances, summary) {
		// Declare highlighting variables at the top for proper scope
		let lastHighlightedItem = null;
		let isUserSeeking = false; // Track if user is manually seeking
		
		// Reset user seeking flag after a delay
		function resetUserSeekingFlag() {
			setTimeout(() => {
				isUserSeeking = false;
			}, 1000);
		}
		
		// Force reset user seeking flag (for immediate reset)
		function forceResetUserSeekingFlag() {
			const wasUserSeeking = isUserSeeking;
			const oldLastHighlighted = lastHighlightedItem;
			
			isUserSeeking = false;
			
			// Force a highlighting update when we reset the flag
			if (wasUserSeeking && videoPlayer && videoPlayer.video) {
				const currentTime = videoPlayer.video.currentTime;
				
				// Reset lastHighlightedItem to force a fresh highlight
				lastHighlightedItem = null;
				try {
					highlightCurrentTranscript(currentTime);
				} catch (error) {
					console.error(`🚨 Error in highlightCurrentTranscript:`, error);
				}
			} else {
				console.log(`🔄 Skipping forced highlight update: wasUserSeeking=${wasUserSeeking}, videoPlayer=${!!videoPlayer}, video=${!!(videoPlayer && videoPlayer.video)}`);
			}
		}
		
		// Prioritize S3 URL, then videoUrl, then local endpoint
		let videoUrl;
		if (bot.s3VideoUrl) {
			videoUrl = bot.s3VideoUrl;
			console.log(`🎥 Using S3 video URL: ${videoUrl}`);
		} else if (bot.videoUrl && bot.videoUrl.includes('s3.amazonaws.com')) {
			videoUrl = bot.videoUrl;
			console.log(`🎥 Using S3 video URL from videoUrl: ${videoUrl}`);
		} else if (bot.videoUrl) {
			videoUrl = bot.videoUrl;
			console.log(`🎥 Using custom video URL: ${videoUrl}`);
		} else {
			videoUrl = `/v1/recordings/${encodeURIComponent(bot.id)}`;
			console.log(`🎥 Using local video endpoint: ${videoUrl}`);
		}

		// Format bot metadata
		const createdDate = fmtDate(bot.createdAt);
		const endedDate = bot.endTime ? fmtDate(bot.endTime) : 'N/A';
		const duration = bot.endTime && bot.createdAt ? 
			Math.round((bot.endTime - bot.createdAt) / 60000) + ' min' : 'N/A';
		
		// Calculate speaking time for each utterance
		utterances.forEach((utt, index) => {
			// Find next utterance to determine end time
			const nextUtt = utterances.find((u, i) => i > index && u.startOffset > utt.startOffset);
			const endTime = nextUtt ? nextUtt.startOffset : (utt.startOffset + 3); // Default 3 seconds if last
			utt.speakingTime = Math.max(0, endTime - utt.startOffset);
		});

		// Format summary (convert markdown headers to HTML for better display)
		// Check if summary is being generated (bot is completed but no summary yet)
		const isSummaryGenerating = bot.status === 'completed' && (!summary || summary.trim() === '') && utterances.length > 0;
		
		let formattedSummary;
		if (isSummaryGenerating) {
			// Show "Meeting is still in process" message while OpenAI is generating summary
			formattedSummary = `
				<div class="summary-loading">
					<p style="color: #6b7280; font-size: 14px; text-align: center; padding: 20px;">Meeting is still in process</p>
				</div>
			`;
		} else if (summary && summary.trim() !== '') {
			// Format existing summary
			formattedSummary = summary
				.replace(/^# (.+)$/gm, '<h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600;">$1</h3>')
				.replace(/^## (.+)$/gm, '<h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">$1</h4>')
				.replace(/^### (.+)$/gm, '<h5 style="margin: 8px 0 4px 0; font-size: 13px; font-weight: 600;">$1</h5>')
				.replace(/^• (.+)$/gm, '<li style="margin-left: 20px;">$1</li>')
				.replace(/\n\n/g, '<br><br>')
				.replace(/\n/g, '<br>');
		} else {
			// No summary available
			formattedSummary = 'No summary available yet.';
		}

		const shareUrl = `${window.location.origin}/share.html?token=${encodeURIComponent(bot.id)}`;
		
		botDetailContent.innerHTML = `
			${bot.isHistorical ? `
			<div class="card" style="margin-bottom: 16px; background: #fffbeb; border-color: #fbbf24;">
				<div style="display: flex; align-items: center; gap: 8px;">
					<span style="font-size: 20px;">📂</span>
					<div>
						<div style="font-weight: 600; color: #92400e; font-size: 14px;">Historical Meeting</div>
						<div style="font-size: 12px; color: #78350f; margin-top: 2px;">
							This meeting data was recovered from storage. Database entry was removed but files remain intact.
						</div>
					</div>
				</div>
			</div>
			` : ''}
			<div class="card bot-info-card" style="margin-bottom: 16px; background: #f9fafb; border-color: #e5e7eb;">
				<div class="bot-info-header" style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
					<div class="bot-info-main" style="flex: 1; min-width: 200px;">
						<strong style="font-size: 16px;"><img src="https://www.cxflow.io/app/images/logo.png" alt="CXFlow Logo" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px;">${bot.isHistorical ? ' (Historical)' : ''} ${bot.title || bot.id}</strong>
						<div class="bot-meta-info" style="font-size: 13px; color: #6b7280; margin-top: 4px;">
							<span>📅 Created: ${createdDate}</span> • 
							<span>⏱️ Duration: ${duration}</span> • 
							<span>Status: <span class="status-badge status-${bot.status}">${bot.status}</span></span>
						</div>
					</div>
					<div class="bot-url-info" style="font-size: 12px; color: #9ca3af; text-align: right;">
						<div>🔗 <a href="${bot.meetUrl}" target="_blank" style="color: #2563eb; text-decoration: none; word-break: break-all;">${bot.meetUrl}</a></div>
					</div>
				</div>
			</div>
			<div class="card" style="margin-bottom: 20px; background: #eff6ff; border-color: #bfdbfe;">
				<div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
					<div style="flex: 1; min-width: 250px;">
						<div style="font-size: 14px; font-weight: 600; color: #1e40af; margin-bottom: 6px;">📤 Shareable Link</div>
						<div style="font-size: 13px; color: #1e40af; margin-bottom: 8px;">Share this link to allow others to view the meeting recording and transcript</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
							<input type="text" id="shareUrlInput" readonly value="${shareUrl}" style="flex: 1; min-width: 200px; padding: 8px 12px; background: white; border: 1px solid #93c5fd; border-radius: 6px; font-size: 13px; color: #1e40af;">
							<button id="copyShareLinkBtn" class="btn-small" style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;">
								Copy Link
							</button>
							<a href="${shareUrl}" target="_blank" class="btn-small" style="background: white; color: #2563eb; border: 1px solid #2563eb; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 500;">
								Open
							</a>
							<a href="/v1/bots/${encodeURIComponent(bot.id)}/export/pdf" class="btn-small" style="background: #dc2626; color: white; border: none; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;" download>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
									<path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
								</svg>
								Export PDF
							</a>
							<button id="shareEmailBtn" class="btn-small" style="background: #059669; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
									<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
								</svg>
								Share via Email
							</button>
						</div>
					</div>
				</div>
			</div>
			<div class="bot-detail">
				<div class="bot-detail-left">
					<div id="professionalVideoPlayer"></div>
					<div class="summary-section">
						<div class="keywords-section">
							<div class="keywords-header">
								<div class="keywords-title">Keywords:</div>
								<button class="edit-keywords-btn" id="editKeywordsBtn" title="Edit keywords">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
										<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
									</svg>
								</button>
							</div>
							<div class="keywords-tags" id="keywordsTags">
								${renderKeywords(bot.keywords || bot.metrics?.keywords?.byKeyword || {})}
							</div>
						</div>
						<div class="summary-header">
							<div class="summary-title">AI Meeting Summary</div>
							<button class="copy-summary-btn" id="copySummaryBtn" title="Copy summary">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
									<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
								</svg>
							</button>
						</div>
						<div class="summary-content">${formattedSummary}</div>
					</div>
				</div>
				<div class="transcript-section">
					<div class="transcript-header-sticky">
						<div class="transcript-tabs">
						<button class="transcript-tab active" data-tab="transcript" id="transcriptTab">Transcript <span id="transcriptCount"></span></button>
						<button class="transcript-tab" data-tab="talktime" id="talktimeTab">Speaker Talktime</button>
						</div>
						<div class="transcript-search" id="transcriptSearchContainer">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9ca3af;">
								<circle cx="11" cy="11" r="8"></circle>
								<path d="m21 21-4.35-4.35"></path>
							</svg>
							<input type="text" id="transcriptSearch" placeholder="Find or Replace" class="transcript-search-input";">
						</div>
					</div>
					<div id="transcriptContainer" class="transcript-scrollable"></div>
					<div id="talktimeContainer" class="transcript-scrollable" style="display: none;"></div>
				</div>
			</div>
		`;

		const transcriptContainer = document.getElementById('transcriptContainer');
		
		// Setup copy share link button
		const copyShareLinkBtn = document.getElementById('copyShareLinkBtn');
		if (copyShareLinkBtn) {
			copyShareLinkBtn.addEventListener('click', () => {
				const shareUrlInput = document.getElementById('shareUrlInput');
				shareUrlInput.select();
				navigator.clipboard.writeText(shareUrl).then(() => {
					const originalText = copyShareLinkBtn.textContent;
					copyShareLinkBtn.textContent = '✅ Copied!';
					copyShareLinkBtn.style.background = '#10b981';
					setTimeout(() => {
						copyShareLinkBtn.textContent = originalText;
						copyShareLinkBtn.style.background = '#2563eb';
					}, 2000);
				}).catch(err => {
					alert('Failed to copy link. Please copy manually.');
				});
			});
		}

		// Setup share via email button
		const shareEmailBtn = document.getElementById('shareEmailBtn');
		if (shareEmailBtn) {
			shareEmailBtn.addEventListener('click', async () => {
				const originalHTML = shareEmailBtn.innerHTML;
				shareEmailBtn.disabled = true;
				shareEmailBtn.innerHTML = `
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="animation: spin 1s linear infinite;">
						<path d="M21 12a9 9 0 11-6.219-8.56"/>
					</svg>
					Sending...
				`;
				
				// Add spinning animation if not already added
				if (!document.querySelector('#spin-animation')) {
					const style = document.createElement('style');
					style.id = 'spin-animation';
					style.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
					document.head.appendChild(style);
				}

				try {
					const token = getAuthToken();
					const response = await fetch('/api/share-via-email', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${token}`
						},
						body: JSON.stringify({
							botId: bot.id,
							shareUrl: shareUrl,
							isPublicShare: false
						})
					});

					const data = await response.json();

					if (response.ok && data.success) {
						shareEmailBtn.innerHTML = `
							<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
								<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
							</svg>
							Email Sent!
						`;
						shareEmailBtn.style.background = '#10b981';
						
						setTimeout(() => {
							shareEmailBtn.innerHTML = originalHTML;
							shareEmailBtn.style.background = '#059669';
							shareEmailBtn.disabled = false;
						}, 3000);
					} else {
						throw new Error(data.error || 'Failed to send email');
					}
				} catch (error) {
					console.error('Share email error:', error);
					shareEmailBtn.innerHTML = `
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 2L2 7v10c0 5.55 3.84 9.95 9 11 5.16-1.05 9-5.45 9-11V7l-10-5z"/>
						</svg>
						Failed
					`;
					shareEmailBtn.style.background = '#dc2626';
					
					setTimeout(() => {
						shareEmailBtn.innerHTML = originalHTML;
						shareEmailBtn.style.background = '#059669';
						shareEmailBtn.disabled = false;
					}, 3000);
				}
			});
		}
		
		// Initialize professional video player (unchanged)
		let videoPlayer = null;
		try {
			// Get duration from metrics if available
			let videoDuration = 0;
			if (bot.metrics && bot.metrics.duration && bot.metrics.duration.totalSeconds) {
				videoDuration = bot.metrics.duration.totalSeconds;
			}
			
			// Throttle transcript highlighting for better performance
			let lastHighlight = 0;
			const HIGHLIGHT_INTERVAL = 0.1; // seconds - more responsive highlighting
			
			videoPlayer = new ProfessionalVideoPlayer('professionalVideoPlayer', videoUrl, {
				
				transcript: utterances,
				duration: videoDuration, // Pass duration from metrics
				onTimeUpdate: (currentTime) => {
					// Always log to verify this is being called
					if (Math.floor(currentTime) % 5 === 0) {
						console.log(`📹 Video playing at ${currentTime.toFixed(1)}s - onTimeUpdate is working`);
					}
					
					// Auto-reset user seeking flag after sufficient time has passed
					if (isUserSeeking && videoPlayer) {
						const timeSinceLastSeek = Date.now() - (window.lastSeekTime || 0);
						
						// Reset after 2 seconds regardless of play state, or immediately if playing for 2+ seconds
						const shouldReset = timeSinceLastSeek > 2000 || (videoPlayer.isPlaying && timeSinceLastSeek > 1500);
						
						if (shouldReset) {
							console.log(`🔄 Auto-resetting user seeking flag after ${timeSinceLastSeek}ms (video playing: ${videoPlayer.isPlaying}, currentTime: ${currentTime.toFixed(1)}s)`);
							forceResetUserSeekingFlag();
						} else if (timeSinceLastSeek > 1000) {
							// Debug: show we're waiting for reset
							console.log(`⏳ Waiting for auto-reset: ${timeSinceLastSeek}ms since last seek (need ${videoPlayer.isPlaying ? '1500' : '2000'}ms, video playing: ${videoPlayer.isPlaying})`);
						}
					}
					
					// Additional safety: reset if user seeking has been true for too long
					if (isUserSeeking && (Date.now() - (window.lastSeekTime || 0)) > 3000) {
						forceResetUserSeekingFlag();
					}
					
					// Sync transcript highlighting with video playback (throttled)
					// Use absolute difference so it still runs even after seeking backwards.
					if (Math.abs(currentTime - lastHighlight) > HIGHLIGHT_INTERVAL) {
						lastHighlight = currentTime;
						highlightCurrentTranscript(currentTime);
					}
				}
			});
			
			// Make videoPlayer globally accessible for debugging
			window.videoPlayer = videoPlayer;
			
			// Make debugging functions globally accessible
			window.resetAutoSync = forceResetUserSeekingFlag;
			window.checkSyncStatus = () => {
				const timeSince = Date.now() - (window.lastSeekTime || 0);
				const isPlaying = videoPlayer && videoPlayer.isPlaying;
				if (isUserSeeking && timeSince > 2000 && isPlaying) {
					forceResetUserSeekingFlag();
				}
			};
		} catch (error) {
			document.getElementById('professionalVideoPlayer').innerHTML = 
				'<div class="empty-state"><p>Video player failed to load</p></div>';
		}
		
		// Audio player removed - video player now controls transcript synchronization

		if (!utterances || utterances.length === 0) {
			transcriptContainer.innerHTML = '<div class="empty-state"><p>No transcript available</p></div>';
			// Clear count if no transcript
			const transcriptCountEl = document.getElementById('transcriptCount');
			if (transcriptCountEl) {
				transcriptCountEl.textContent = '';
			}
			return;
		}
		
		// Update transcript count (same as share page)
		const transcriptCountEl = document.getElementById('transcriptCount');
		if (transcriptCountEl) {
			transcriptCountEl.textContent = `(${utterances.length})`;
		}

		// Get unique speakers for color assignment (consistent order)
		const uniqueSpeakers = [...new Set(utterances.map(u => u.speaker).filter(Boolean))];
		const speakerColorMap = {};
		uniqueSpeakers.forEach((speaker) => {
			speakerColorMap[speaker] = getSpeakerColor(speaker, uniqueSpeakers);
		});

		// Calculate speaking time for each utterance (same as share.html)
		utterances.forEach((utt, index) => {
			// Find next utterance to determine end time
			const nextUtt = utterances.find((u, i) => i > index && u.startOffset > utt.startOffset);
			const endTime = nextUtt ? nextUtt.startOffset : (utt.startOffset + 3); // Default 3 seconds if last
			utt.speakingTime = Math.max(0, endTime - utt.startOffset);
		});

		// Render transcript items
		for (const utt of utterances) {
			const item = document.createElement('div');
			item.className = 'transcript-item';
			const startTime = utt.startOffset || 0;
			const uttSpeakingTime = utt.speakingTime || 0;
			const endTime = startTime + uttSpeakingTime;
			item.dataset.startTime = startTime;
			item.dataset.endTime = endTime;
			
			// Debug: log first few items
			if (utterances.indexOf(utt) < 3) {
				console.log(`🔍 Item ${utterances.indexOf(utt)}: "${utt.text.substring(0, 30)}..." (${startTime}s-${endTime}s)`);
			}
			// Make entire transcript item clickable for better UX
			item.style.cursor = 'pointer';
			item.addEventListener('click', (e) => {
				// Only trigger if clicking on the item itself (not on nested clickable elements)
				if (e.target === item) {
					if (videoPlayer) {
						const startTime = utt.startOffset || 0;
						isUserSeeking = true; // Mark as user-initiated seek
						window.lastSeekTime = Date.now(); // Track when user last seeked
						
						// Force pause first to ensure seek works
						if (videoPlayer.isPlaying) {
							videoPlayer.video.pause();
						}
						
						// Immediately highlight the clicked item
						if (lastHighlightedItem) {
							lastHighlightedItem.classList.remove('active');
						}
						item.classList.add('active');
						lastHighlightedItem = item;
						
						// Seek and wait for buffer, then play - ensure sync is perfect
						videoPlayer.seekTo(startTime).then(() => {
							// Verify we're at the right position before playing
							const currentTime = videoPlayer.video.currentTime;
							const timeDiff = Math.abs(currentTime - startTime);
							if (timeDiff < 0.5) {
								// Position is correct, play
								videoPlayer.video.play().catch(err => {
									console.error('Play error:', err);
								});
							} else {
								// Position mismatch, try seeking again
								console.warn('Seek position mismatch, retrying...');
								videoPlayer.video.currentTime = startTime;
								videoPlayer.video.addEventListener('seeked', () => {
									videoPlayer.video.play().catch(err => {
										console.error('Play error:', err);
									});
								}, { once: true });
							}
							resetUserSeekingFlag();
						}).catch(err => {
							console.error('Seek error:', err);
							// Fallback: force seek and play
							videoPlayer.video.pause();
							videoPlayer.video.currentTime = startTime;
							videoPlayer.video.addEventListener('seeked', () => {
								videoPlayer.video.play().catch(e => console.error('Play error:', e));
							}, { once: true });
							resetUserSeekingFlag();
						});
					}
				}
			});

			const speakerInitial = getSpeakerInitial(utt.speaker);
			const speakerColor = speakerColorMap[utt.speaker] || '#6b7280';

			// Create speaker circle
			const speakerCircle = document.createElement('div');
			speakerCircle.className = 'speaker-circle';
			speakerCircle.textContent = speakerInitial;
			speakerCircle.style.backgroundColor = speakerColor;
			speakerCircle.style.color = '#fff';
			speakerCircle.style.width = '32px';
			speakerCircle.style.height = '32px';
			speakerCircle.style.borderRadius = '50%';
			speakerCircle.style.display = 'flex';
			speakerCircle.style.alignItems = 'center';
			speakerCircle.style.justifyContent = 'center';
			speakerCircle.style.fontSize = '13px';
			speakerCircle.style.fontWeight = '600';
			speakerCircle.style.flexShrink = '0';

			// Create speaker info container
			const speakerInfo = document.createElement('div');
			speakerInfo.className = 'speaker-info';
			speakerInfo.style.display = 'flex';
			speakerInfo.style.alignItems = 'center';
			speakerInfo.style.gap = '8px';
			speakerInfo.style.marginBottom = '6px';

			const speakerName = document.createElement('span');
			speakerName.className = 'speaker-name';
			speakerName.textContent = utt.speaker;
			speakerName.style.fontWeight = '500';
			speakerName.style.fontSize = '14px';
			speakerName.style.color = '#111827';

			const timeStamp = document.createElement('span');
			timeStamp.className = 'time-stamp';
			timeStamp.textContent = fmtTime(utt.startOffset || 0);
			timeStamp.style.fontSize = '12px';
			timeStamp.style.color = '#6b7280';
			timeStamp.style.cursor = 'pointer';
			timeStamp.addEventListener('click', (e) => {
				e.stopPropagation(); // Prevent item click from firing
				if (videoPlayer) {
					const startTime = utt.startOffset || 0;
					isUserSeeking = true; // Mark as user-initiated seek
					window.lastSeekTime = Date.now(); // Track when user last seeked
					
					// Force pause first to ensure seek works
					if (videoPlayer.isPlaying) {
						videoPlayer.video.pause();
					}
					
					// Immediately highlight the clicked item
					if (lastHighlightedItem) {
						lastHighlightedItem.classList.remove('active');
					}
					timeStamp.closest('.transcript-item').classList.add('active');
					lastHighlightedItem = timeStamp.closest('.transcript-item');
					
					// Seek and wait for buffer, then play - ensure sync is perfect
					videoPlayer.seekTo(startTime).then(() => {
						// Verify we're at the right position before playing
						const currentTime = videoPlayer.video.currentTime;
						const timeDiff = Math.abs(currentTime - startTime);
						if (timeDiff < 0.5) {
							// Position is correct, play
							videoPlayer.video.play().catch(err => {
								console.error('Play error:', err);
							});
						} else {
							// Position mismatch, try seeking again
							console.warn('Seek position mismatch, retrying...');
							videoPlayer.video.currentTime = startTime;
							videoPlayer.video.addEventListener('seeked', () => {
								videoPlayer.video.play().catch(err => {
									console.error('Play error:', err);
								});
							}, { once: true });
						}
						resetUserSeekingFlag();
					}).catch(err => {
						console.error('Seek error:', err);
						// Fallback: force seek and play
						videoPlayer.video.pause();
						videoPlayer.video.currentTime = startTime;
						videoPlayer.video.addEventListener('seeked', () => {
							videoPlayer.video.play().catch(e => console.error('Play error:', e));
						}, { once: true });
						resetUserSeekingFlag();
					});
				}
			});

			speakerInfo.appendChild(speakerCircle);
			speakerInfo.appendChild(speakerName);
			speakerInfo.appendChild(document.createTextNode(' · '));
			speakerInfo.appendChild(timeStamp);

			const text = document.createElement('div');
			text.className = 'transcript-text';
			text.textContent = utt.text;
			text.style.fontSize = '14px';
			text.style.lineHeight = '1.6';
			text.style.color = '#374151';
			text.style.marginLeft = '40px';
			text.style.cursor = 'pointer';
			// Make text clickable to seek video
			text.addEventListener('click', (e) => {
				e.stopPropagation(); // Prevent item click from firing
				if (videoPlayer) {
					const startTime = utt.startOffset || 0;
					isUserSeeking = true; // Mark as user-initiated seek
					window.lastSeekTime = Date.now(); // Track when user last seeked
					
					// Force pause first to ensure seek works
					if (videoPlayer.isPlaying) {
						videoPlayer.video.pause();
					}
					
					// Immediately highlight the clicked item
					if (lastHighlightedItem) {
						lastHighlightedItem.classList.remove('active');
					}
					text.closest('.transcript-item').classList.add('active');
					lastHighlightedItem = text.closest('.transcript-item');
					
					// Seek and wait for buffer, then play - ensure sync is perfect
					videoPlayer.seekTo(startTime).then(() => {
						// Verify we're at the right position before playing
						const currentTime = videoPlayer.video.currentTime;
						const timeDiff = Math.abs(currentTime - startTime);
						if (timeDiff < 0.5) {
							// Position is correct, play
							videoPlayer.video.play().catch(err => {
								console.error('Play error:', err);
							});
						} else {
							// Position mismatch, try seeking again
							console.warn('Seek position mismatch, retrying...');
							videoPlayer.video.currentTime = startTime;
							videoPlayer.video.addEventListener('seeked', () => {
								videoPlayer.video.play().catch(err => {
									console.error('Play error:', err);
								});
							}, { once: true });
						}
						resetUserSeekingFlag();
					}).catch(err => {
						console.error('Seek error:', err);
						// Fallback: force seek and play
						videoPlayer.video.pause();
						videoPlayer.video.currentTime = startTime;
						videoPlayer.video.addEventListener('seeked', () => {
							videoPlayer.video.play().catch(e => console.error('Play error:', e));
						}, { once: true });
						resetUserSeekingFlag();
					});
				}
			});

			item.appendChild(speakerInfo);
			item.appendChild(text);
			transcriptContainer.appendChild(item);
		}

		const transcriptItems = Array.from(
			transcriptContainer.querySelectorAll('.transcript-item')
		).map(item => ({
			item,
			start: parseFloat(item.dataset.startTime || 0),
			end: parseFloat(item.dataset.endTime || item.dataset.startTime || 0)
		}));
		  
		let lastHighlightedIndex = -1;

		// Setup copy summary button
		const copySummaryBtn = document.getElementById('copySummaryBtn');
		if (copySummaryBtn) {
			copySummaryBtn.addEventListener('click', () => {
				const summaryText = document.querySelector('.summary-content').textContent;
				navigator.clipboard.writeText(summaryText).then(() => {
					const originalHTML = copySummaryBtn.innerHTML;
					copySummaryBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
					setTimeout(() => {
						copySummaryBtn.innerHTML = originalHTML;
					}, 2000);
				}).catch(err => {
					console.error('Failed to copy summary:', err);
				});
			});
		}

		// Setup transcript tabs
		const transcriptTab = document.getElementById('transcriptTab');
		const talktimeTab = document.getElementById('talktimeTab');
		const transcriptSearchContainer = document.getElementById('transcriptSearchContainer');
		const talktimeContainer = document.getElementById('talktimeContainer');
		
		if (transcriptTab && talktimeTab) {
			transcriptTab.addEventListener('click', () => {
				transcriptTab.classList.add('active');
				talktimeTab.classList.remove('active');
				transcriptContainer.style.display = '';
				talktimeContainer.style.display = 'none';
				if (transcriptSearchContainer) transcriptSearchContainer.style.display = '';
				
				// Reset highlighting when switching to transcript tab
				if (typeof lastHighlightedItem !== 'undefined' && lastHighlightedItem) {
					lastHighlightedItem.classList.remove('active');
					lastHighlightedItem = null;
				}
				if (typeof isUserSeeking !== 'undefined') {
					isUserSeeking = false;
				}
				
				// Re-trigger highlighting for current video time if video is playing
				if (videoPlayer && videoPlayer.video && !videoPlayer.video.paused) {
					const currentTime = videoPlayer.video.currentTime;
					if (typeof highlightCurrentTranscript === 'function') {
						highlightCurrentTranscript(currentTime);
					}
				}
			});
			
			talktimeTab.addEventListener('click', () => {
				talktimeTab.classList.add('active');
				transcriptTab.classList.remove('active');
				transcriptContainer.style.display = 'none';
				talktimeContainer.style.display = '';
				if (transcriptSearchContainer) transcriptSearchContainer.style.display = 'none';
				
				// Render speaker talk time if not already rendered
				if (talktimeContainer && talktimeContainer.children.length === 0) {
					renderSpeakerTalkTime(bot, utterances, talktimeContainer);
				}
			});
		}

		// Setup transcript search
		const transcriptSearch = document.getElementById('transcriptSearch');
		if (transcriptSearch) {
			transcriptSearch.addEventListener('input', (e) => {
				const searchTerm = e.target.value.toLowerCase();
				const items = transcriptContainer.querySelectorAll('.transcript-item');
				items.forEach(item => {
					const text = item.textContent.toLowerCase();
					if (text.includes(searchTerm)) {
						item.style.display = '';
					} else {
						item.style.display = 'none';
					}
				});
			});
		}

		
		// Function to highlight current transcript item based on video time
		function highlightCurrentTranscript(currentTime) {
			const seekAge = Date.now() - (window.lastSeekTime || 0);
			if (isUserSeeking && seekAge < 2000) {
				return;
			}

			// After the grace period, automatically re-enable auto-highlighting
			if (isUserSeeking && seekAge >= 2000) {
				isUserSeeking = false;
			}
			
			// Get fresh list of transcript items each time to avoid stale references
			const items = document.querySelectorAll('.transcript-item');
			if (!items.length) {
				return;
			}
			
			let currentItem = null;
			let currentIndex = -1;
		  
			// Find the item that contains the current time (within start and end time)
			items.forEach((item, index) => {
				const startTime = parseFloat(item.dataset.startTime || 0);
				const endTime = parseFloat(item.dataset.endTime || startTime);
				
				// Debug: log first few items to see their time ranges
				if (index < 3) {
					console.log(`📋 Item ${index}: startTime=${startTime}, endTime=${endTime}, currentTime=${currentTime.toFixed(1)}`);
				}
				
				// Check if current time is within this item's time range
				if (currentTime >= startTime && currentTime < endTime) {
					currentItem = item;
					currentIndex = index;
				}
			});
			
			// If no exact match found, find the closest previous item
			if (!currentItem) {
				let closestItem = null;
				let closestTime = -1;
				let closestIndex = -1;
				
				items.forEach((item, index) => {
					const startTime = parseFloat(item.dataset.startTime || 0);
					if (startTime <= currentTime && startTime > closestTime) {
						closestTime = startTime;
						closestItem = item;
						closestIndex = index;
					}
				});
				
				currentItem = closestItem;
				currentIndex = closestIndex;
				
				if (currentItem) {
					console.log(`🔍 Using closest match: Item ${closestIndex} (startTime=${closestTime}s) for time ${currentTime.toFixed(1)}s`);
				} else {
					console.log(`❌ No suitable transcript item found for time ${currentTime.toFixed(1)}s`);
				}
			}
		  
			// Update highlighting - be more aggressive about ensuring correct visual state
			if (currentItem) {
				const needsUpdate = currentItem !== lastHighlightedItem || !currentItem.classList.contains('active');
				
				if (needsUpdate) {
					// Remove previous highlight from all items (ensure clean state)
					document.querySelectorAll('.transcript-item').forEach(item => {
						item.classList.remove('active');
						item.style.background = '';
						item.style.borderLeft = '';
					});
			  
					// Add new highlight using CSS class
					currentItem.classList.add('active');
					lastHighlightedItem = currentItem;
					lastHighlightedIndex = currentIndex;
				} else {
					// Even if we don't update, ensure the current item has the active class
					if (!currentItem.classList.contains('active')) {
						console.log(`🔧 Fixing missing active class on item ${currentIndex}`);
						currentItem.classList.add('active');
					}
				}
		  
				// Scroll into view smoothly (only if not user seeking to avoid jumpy behavior)
				if (!isUserSeeking) {
					currentItem.scrollIntoView({
						behavior: 'smooth',
						block: 'center',
						inline: 'nearest'
					});
				}
			} else if (currentItem) {
				console.log(`✅ Highlight confirmed for item ${currentIndex} at ${currentTime.toFixed(1)}s (already correct)`);
			} else {
				console.log(`⚠️ No matching transcript item found for time ${currentTime.toFixed(1)}s`);
			}
		}
	}

	window.openBotDetail = openBotDetail;

	backButton.addEventListener('click', () => {
		botDetailView.classList.add('hidden');
		botListView.classList.remove('hidden');
	});

	async function checkBotStatus(botId) {
		try {
			const res = await fetch(`/v1/bots/${encodeURIComponent(botId)}`);
			if (!res.ok) return null;
			const data = await res.json();
			return data.status;
		} catch {
			return null;
		}
	}

	function startPolling(botId) {
		if (pollInterval) clearInterval(pollInterval);
		pollInterval = setInterval(async () => {
			// No token expiration check during polling - user is actively using the app
			const status = await checkBotStatus(botId);
			if (status === 'completed' || status === 'failed') {
				clearInterval(pollInterval);
				pollInterval = null;
				if (status === 'completed') {
					setStatus(`✅ Recording completed! Bot ID: ${botId}`);
				} else {
					setStatus('❌ Bot finished with errors. Check server logs.');
				}
			} else if (status === 'recording') {
				setStatus(`🔴 Recording in progress... (Bot ID: ${botId})`);
			} else if (status === 'starting') {
				setStatus('⏳ Bot is starting...');
			}
		}, 3000);
	}

	async function startBot(meetingUrl, botName, captionLanguage) {
		// Check token expiration before creating bot
		if (!checkTokenExpiration()) {
			setStatus('❌ Session expired. Please sign in again.');
			return;
		}

		setStatus('Creating bot...');
		const token = getAuthToken();
		
		const payload = { 
			meeting_url: meetingUrl
		};
		
		// Add optional bot name
		if (botName && botName.trim()) {
			payload.bot_name = botName.trim();
		}
		
		// Add caption language (defaults to 'en' on server if not provided)
		if (captionLanguage) {
			payload.caption_language = captionLanguage;
		}
		
		const resp = await fetch('/v1/bots', {
			method: 'POST',
			headers: { 
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`
			},
			body: JSON.stringify(payload)
		});
		if (resp.status === 401) {
			clearAuth();
			throw new Error('Session expired. Please sign in again.');
		}
		if (!resp.ok) {
			const err = await resp.json().catch(() => ({}));
			throw new Error(err.error || `Failed: ${resp.status}`);
		}
		const data = await resp.json();
		return data.bot_id;
	}

	startBtn.addEventListener('click', async () => {
		try {
			if (!currentUser) {
				alert('Please sign in first.');
				return;
			}
			const url = meetUrlInput.value.trim();
			if (!url) return alert('Enter Google Meet URL');
			if (!url.includes('meet.google.com')) {
				return alert('Please enter a valid Google Meet URL');
			}
			
			const botName = botNameInput.value.trim();
			const captionLanguage = captionLanguageSelect.value;
			
			startBtn.disabled = true;
			setStatus('⏳ Starting bot...');
			
			const displayBotName = botName || 'CXFlow Meeting Bot';
			const languageName = captionLanguageSelect.options[captionLanguageSelect.selectedIndex].text;
			
			setStatus(`⏳ Starting ${displayBotName} with ${languageName} captions...`);
			
			botId = await startBot(url, botName, captionLanguage);
			setBadges(botId, 0);
			saveBotToHistory(botId, url);
			setStatus(`✅ Bot started successfully! (Language: ${languageName})`);
			startPolling(botId);
			
			// Clear form
			meetUrlInput.value = '';
			botNameInput.value = '';
			// Reset language selector to default Spanish
			captionLanguageSelect.value = 'es';
		} catch (e) {
			alert(e.message || 'Failed to start bot');
			setStatus('❌ Failed to start bot.');
		} finally {
			startBtn.disabled = false;
		}
	});

	// Initialize
	initAuth();
	initTabs();
})();
