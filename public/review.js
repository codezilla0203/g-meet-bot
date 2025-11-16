(() => {
  const botIdInput = document.getElementById('botIdInput');
  const loadBtn = document.getElementById('loadBtn');
  const audioEl = document.getElementById('audio');
  const audioHintEl = document.getElementById('audioHint');
  const transcriptListEl = document.getElementById('transcriptList');
  const metaEl = document.getElementById('meta');
  const badgesEl = document.getElementById('badges');

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function clearTranscript() {
    transcriptListEl.innerHTML = '';
  }

  function setBadges(botId, captionsCount) {
    badgesEl.innerHTML = '';
    if (!botId) return;
    const idBadge = document.createElement('span');
    idBadge.className = 'badge';
    idBadge.innerHTML = `<span class="badge-label">Bot</span> ${botId}`;
    badgesEl.appendChild(idBadge);

    if (typeof captionsCount === 'number') {
      const capBadge = document.createElement('span');
      capBadge.className = 'badge';
      capBadge.style.marginLeft = '6px';
      capBadge.innerHTML = `<span class="badge-label">Captions</span> ${captionsCount}`;
      badgesEl.appendChild(capBadge);
    }
  }

  function buildUtterances(captions) {
    if (!Array.isArray(captions) || captions.length === 0) return [];

    // Sort by timestamp to ensure chronological order
    const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

    const utterances = [];
    let current = null;

    for (const cap of sorted) {
      const speaker = (cap.speaker || 'Unknown Speaker').trim();
      const text = String(cap.text || '').trim();
      const offsetSeconds = Number.isFinite(cap.offsetSeconds) ? cap.offsetSeconds : 0;

      if (!text) continue;

      if (!current) {
        current = {
          speaker,
          startOffset: offsetSeconds,
          text,
          lastText: text,
          lastOffset: offsetSeconds,
        };
        continue;
      }

      const sameSpeaker = speaker === current.speaker;
      const gapSeconds = offsetSeconds - current.lastOffset;

      if (sameSpeaker && gapSeconds <= 5) {
        // Merge growing captions: prefer the longer text that usually contains the full sentence
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
        current = {
          speaker,
          startOffset: offsetSeconds,
          text,
          lastText: text,
          lastOffset: offsetSeconds,
        };
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
    clearTranscript();
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

  async function loadBot(botId) {
    botId = (botId || '').trim();
    if (!botId) throw new Error('Bot ID is required');
    metaEl.textContent = 'Loading bot data...';
    clearTranscript();
    setBadges('', 0);

    // Fetch transcript (captions)
    const tRes = await fetch(`/v1/transcripts/${encodeURIComponent(botId)}`);
    if (!tRes.ok) {
      throw new Error(`Failed to load transcript: ${tRes.status}`);
    }
    const tData = await tRes.json();
    const captions = Array.isArray(tData.captions) ? tData.captions : [];

    // Attempt to set audio source
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
      const first = utterances[0];
      metaEl.textContent = `Loaded ${utterances.length} utterances from ${captions.length} caption updates.`;
      // Add a download link to explicitly fetch the recording
      try {
        let dl = document.getElementById('downloadLink');
        if (!dl) {
          dl = document.createElement('a');
          dl.id = 'downloadLink';
          dl.className = 'small';
          dl.style.marginLeft = '12px';
          dl.textContent = 'Download recording';
          dl.target = '_blank';
          audioEl.parentElement.appendChild(dl);
        }
        dl.href = `/v1/recordings/${encodeURIComponent(botId)}`;
      } catch (e) {}
    } else if (captions.length > 0) {
      metaEl.textContent = `Loaded ${captions.length} raw captions, but could not build utterances.`;
    } else {
      metaEl.textContent = 'No captions found for this bot.';
    }
  }

  loadBtn.addEventListener('click', async () => {
    try {
      loadBtn.disabled = true;
      await loadBot(botIdInput.value);
    } catch (e) {
      alert(e.message || 'Failed to load bot data');
      metaEl.textContent = e.message || 'Failed to load bot data';
    } finally {
      loadBtn.disabled = false;
    }
  });

  // Allow ?botId=... in query string
  const params = new URLSearchParams(window.location.search);
  const initialBotId = params.get('botId');
  if (initialBotId) {
    botIdInput.value = initialBotId;
    loadBtn.click();
  }
})();


