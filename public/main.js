(() => {
	const meetUrlInput = document.getElementById('meetUrl');
	const startBtn = document.getElementById('startBtn');
	const statusEl = document.getElementById('status');
	const badgesEl = document.getElementById('badges');
	const audioEl = document.getElementById('audio');
	const audioHintEl = document.getElementById('audioHint');
	const transcriptListEl = document.getElementById('transcriptList');
	const recordingCard = document.getElementById('recordingCard');
	const transcriptCard = document.getElementById('transcriptCard');

	let botId = null;
	let pollInterval = null;

	function setStatus(text) {
		statusEl.textContent = text;
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

	function setBadges(botId, captionsCount) {
		badgesEl.innerHTML = '';
		if (!botId) return;
		const idBadge = document.createElement('span');
		idBadge.className = 'badge';
		idBadge.innerHTML = `<span class="badge-label">Bot</span> ${botId}`;
		badgesEl.appendChild(idBadge);

		if (typeof captionsCount === 'number' && captionsCount > 0) {
			const capBadge = document.createElement('span');
			capBadge.className = 'badge';
			capBadge.innerHTML = `<span class="badge-label">Captions</span> ${captionsCount}`;
			badgesEl.appendChild(capBadge);
		}
	}

	function buildUtterances(captions) {
		if (!Array.isArray(captions) || captions.length === 0) return [];

		const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
		const utterances = [];
		let current = null;

		for (const cap of sorted) {
			const speaker = (cap.speaker || 'Unknown Speaker').trim();
			const text = String(cap.text || '').trim();
			const offsetSeconds = Number.isFinite(cap.offsetSeconds) ? cap.offsetSeconds : 0;

			if (!text) continue;

			if (!current) {
				current = { speaker, startOffset: offsetSeconds, text, lastText: text, lastOffset: offsetSeconds };
				continue;
			}

			const sameSpeaker = speaker === current.speaker;
			const gapSeconds = offsetSeconds - current.lastOffset;

			if (sameSpeaker && gapSeconds <= 5) {
				if (text.length >= current.lastText.length && text.startsWith(current.lastText.slice(0, 10))) {
					current.text = text;
					current.lastText = text;
					current.lastOffset = offsetSeconds;
				} else {
					current.text = `${current.text} ${text}`;
					current.lastText = current.text;
					current.lastOffset = offsetSeconds;
				}
			} else {
				utterances.push({
					speaker: current.speaker,
					startOffset: current.startOffset,
					text: current.text,
				});
				current = { speaker, startOffset: offsetSeconds, text, lastText: text, lastOffset: offsetSeconds };
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

	function renderTranscript(utterances, audioReady) {
		transcriptListEl.innerHTML = '';
		if (!utterances || utterances.length === 0) {
			transcriptListEl.innerHTML = '<div class="small">No captions found for this bot.</div>';
			return;
		}

		for (const utt of utterances) {
			const row = document.createElement('div');
			row.className = 'utt';

			const header = document.createElement('div');
			header.className = 'utt-header';

			const speakerEl = document.createElement('span');
			speakerEl.className = 'speaker';
			speakerEl.textContent = utt.speaker;
			header.appendChild(speakerEl);

			const timeBtn = document.createElement('button');
			timeBtn.type = 'button';
			timeBtn.className = 'time-btn';
			timeBtn.dataset.offset = String(utt.startOffset || 0);
			timeBtn.disabled = !audioReady;
			timeBtn.innerHTML = `${fmtTime(utt.startOffset || 0)} <span>▶</span>`;
			timeBtn.addEventListener('click', () => {
				if (!audioReady || !audioEl.src) return;
				const t = Number(timeBtn.dataset.offset || 0);
				audioEl.currentTime = t;
				audioEl.play().catch(() => {});
			});
			header.appendChild(timeBtn);

			row.appendChild(header);

			const textEl = document.createElement('div');
			textEl.className = 'utt-text';
			textEl.textContent = utt.text;
			row.appendChild(textEl);

			transcriptListEl.appendChild(row);
		}
	}

	async function loadBotTranscript(botId) {
		try {
			const tRes = await fetch(`/v1/transcripts/${encodeURIComponent(botId)}`);
			if (!tRes.ok) return null;
			const tData = await tRes.json();
			const captions = Array.isArray(tData.captions) ? tData.captions : [];

			const audioUrl = `/v1/bots/${encodeURIComponent(botId)}/audio`;
			let audioReady = false;
			try {
				const headRes = await fetch(audioUrl, { method: 'HEAD' });
				if (headRes.ok) {
					audioEl.src = audioUrl;
					audioEl.classList.remove('muted');
					audioHintEl.textContent = 'Click a time button to jump playback to that moment.';
					audioReady = true;
				} else {
					audioEl.removeAttribute('src');
					audioEl.classList.add('muted');
					audioHintEl.textContent = 'Audio file not found for this bot.';
				}
			} catch {
				audioEl.removeAttribute('src');
				audioEl.classList.add('muted');
				audioHintEl.textContent = 'Audio file not available.';
			}

			const utterances = buildUtterances(captions);
			renderTranscript(utterances, audioReady);
			setBadges(botId, captions.length);

			if (utterances.length > 0) {
				recordingCard.classList.remove('hidden');
				transcriptCard.classList.remove('hidden');
				// Add/refresh download link for recording (no leading colon)
				try {
					let dl = document.getElementById('downloadLink');
					if (!dl) {
						dl = document.createElement('a');
						dl.id = 'downloadLink';
						dl.style.marginLeft = '12px';
						dl.className = 'small';
						dl.textContent = 'Download recording';
						dl.setAttribute('download', '');
						dl.target = '_blank';
						audioEl.parentElement.appendChild(dl);
					}
					dl.href = `/v1/recordings/${encodeURIComponent(botId)}`;
				} catch (e) {}
				return true;
			}
			return false;
		} catch (e) {
			console.error('Failed to load transcript:', e);
			return false;
		}
	}

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
			const status = await checkBotStatus(botId);
			if (status === 'completed' || status === 'failed') {
				clearInterval(pollInterval);
				pollInterval = null;
				if (status === 'completed') {
					setStatus('Recording finished. Loading transcript...');
					const loaded = await loadBotTranscript(botId);
					if (loaded) {
						setStatus('Recording finished. Transcript loaded.');
					} else {
						setStatus('Recording finished, but transcript is not available yet. Please refresh in a moment.');
					}
				} else {
					setStatus('Bot finished with errors. Check server logs.');
				}
			} else if (status === 'recording') {
				setStatus(`Recording in progress... (Bot ID: ${botId})`);
			} else if (status === 'starting') {
				setStatus('Bot is starting...');
			}
		}, 2000);
	}

	async function startBot(meetingUrl) {
		setStatus('Creating bot...');
		const resp = await fetch('/v1/bots', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ meeting_url: meetingUrl })
		});
		if (!resp.ok) {
			const err = await resp.json().catch(() => ({}));
			throw new Error(err.error || `Failed: ${resp.status}`);
		}
		const data = await resp.json();
		return data.bot_id;
	}

	startBtn.addEventListener('click', async () => {
		try {
			const url = meetUrlInput.value.trim();
			if (!url) return alert('Enter Google Meet URL');
			startBtn.disabled = true;
			setStatus('Starting bot...');
			botId = await startBot(url);
			setBadges(botId, 0);
			setStatus('Bot started. Waiting for recording to finish...');
			startPolling(botId);
		} catch (e) {
			alert(e.message || 'Failed to start bot');
			setStatus('Failed to start bot.');
		} finally {
			startBtn.disabled = false;
		}
	});
})();
