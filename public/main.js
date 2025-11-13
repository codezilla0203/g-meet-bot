(() => {
	const meetUrlInput = document.getElementById('meetUrl');
	const startBtn = document.getElementById('startBtn');
	const statusEl = document.getElementById('status');
	const transcriptsEl = document.getElementById('transcripts');
	const botIdBadge = document.getElementById('botId');

	let botId = null;
	let evtSrc = null;

	function setStatus(text) {
		statusEl.textContent = text;
	}

	function normalizeText(s) {
		return String(s || '').replace(/\s+/g, ' ').trim();
	}

	function addOrUpdateUtterance({ utteranceId, speaker, text, pending }) {
		const id = utteranceId || `utt-${Math.random().toString(36).slice(2)}`;
		let el = document.getElementById(id);
		if (!el) {
			el = document.createElement('div');
			el.className = 'utt';
			el.id = id;
			transcriptsEl.appendChild(el);
		}
		el.classList.toggle('pending', !!pending);
		el.innerHTML = `<span class="speaker">${speaker || ''}</span>${normalizeText(text)}`;
		// Scroll to bottom for new updates
		el.scrollIntoView({ behavior: 'smooth', block: 'end' });
	}

	function finalizeUtterance({ utteranceId, speaker, text }) {
		addOrUpdateUtterance({ utteranceId, speaker, text, pending: false });
		const el = document.getElementById(utteranceId);
		if (el) el.classList.remove('pending');
	}

	async function startBot(meetingUrl) {
		setStatus('Creating bot…');
		const resp = await fetch('/v1/bots', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ meeting_url: meetingUrl })
		});
		if (!resp.ok) throw new Error(`Failed: ${resp.status}`);
		const data = await resp.json();
		return data.bot_id;
	}

	function connectStreams(botId) {
		// SSE for captions and audio level
		evtSrc = new EventSource(`/v1/stream/${botId}`);
		evtSrc.addEventListener('hello', () => setStatus(`Connected to bot ${botId}`));
		evtSrc.addEventListener('caption_update', (ev) => {
			try {
				const m = JSON.parse(ev.data);
				addOrUpdateUtterance({ utteranceId: m.utteranceId, speaker: m.speaker, text: m.text, pending: true });
			} catch {}
		});
		evtSrc.addEventListener('caption_final', (ev) => {
			try {
				const m = JSON.parse(ev.data);
				finalizeUtterance({ utteranceId: m.utteranceId, speaker: m.speaker, text: m.text });
			} catch {}
		});
		evtSrc.onerror = () => setStatus('SSE disconnected (will retry on refresh)');
		// Show badge
		botIdBadge.style.display = 'inline-block';
		botIdBadge.textContent = botId;
	}

	startBtn.addEventListener('click', async () => {
		try {
			const url = meetUrlInput.value.trim();
			if (!url) return alert('Enter Google Meet URL');
			startBtn.disabled = true;
			setStatus('Starting…');
			botId = await startBot(url);
			connectStreams(botId);
		} catch (e) {
			alert(e.message || 'Failed to start bot');
		} finally {
			startBtn.disabled = false;
		}
	});
})(); 


