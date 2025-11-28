/**
 * ProfessionalVideoPlayer
 *
 * Usage:
 *   const player = new ProfessionalVideoPlayer('professionalVideoPlayer', videoUrl, {
 *     transcript: utterances,       // optional
 *     duration: 3600,               // optional (seconds, fallback to metadata)
 *     onTimeUpdate: (currentTime) => {
 *       // e.g. highlight transcript
 *     }
 *   });
 */

class ProfessionalVideoPlayer {
  constructor(containerId, videoSrc, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      throw new Error(`ProfessionalVideoPlayer: container #${containerId} not found`);
    }

    this.videoSrc = videoSrc;
    this.options = {
      transcript: options.transcript || [],
      onTimeUpdate: typeof options.onTimeUpdate === 'function' ? options.onTimeUpdate : null,
      duration: options.duration || 0, // optional override
      defaultPlaybackRate: 1.0,
      ...options,
    };

    this.video = null;
    this.hls = null; // HLS instance (for .m3u8 sources)
    this.isPlaying = false;
    this.isSeeking = false;
    this.isMetadataLoaded = false;
    this.duration = this.options.duration || 0;
    this.pendingSeekTime = null;
    this.isLoading = false;
    this._lastOnTimeUpdate = 0; // throttle transcript callbacks

    this._keyboardHandler = this._handleKeydown.bind(this);

    this._injectStyles();
    this._buildDOM();
    this._attachEvents();
  }

  // -----------------------------
  // Public API
  // -----------------------------

  /**
   * Seek to a specific time (seconds).
   * Returns a Promise resolved when `seeked` fires or after a safety timeout.
   */
  seekTo(seconds) {
    return new Promise((resolve, reject) => {
      if (!this.video) {
        return reject(new Error('Video element not initialized'));
      }

      const safeTime = Math.max(0, seconds || 0);
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        try { this.video.removeEventListener('seeked', onSeeked); } catch {}
        try { this.video.removeEventListener('seeking', onSeeking); } catch {}
        clearTimeout(timer);
        this._hideLoading();
        resolve();
      };

      const onSeeked = () => {
        done();
      };

      const onSeeking = () => {
        // some browsers fire both; we just treat it as done
        done();
      };

      const timer = setTimeout(() => {
        // If seeked never fires, we still resolve and avoid hanging
        done();
      }, 2000);

      const doSeek = () => {
        this.video.addEventListener('seeked', onSeeked, { once: true });
        this.video.addEventListener('seeking', onSeeking, { once: true });

        try {
          this._showLoading('Seeking...');
          // Use fastSeek when available for near-instant seeking
          if (typeof this.video.fastSeek === 'function') {
            try {
              this.video.fastSeek(safeTime);
            } catch (err) {
              this.video.currentTime = safeTime;
            }
          } else {
            this.video.currentTime = safeTime;
          }
        } catch (err) {
          try { this.video.removeEventListener('seeked', onSeeked); } catch {}
          try { this.video.removeEventListener('seeking', onSeeking); } catch {}
          clearTimeout(timer);
          this._hideLoading();
          reject(err);
        }
      };

      if (this.isMetadataLoaded) {
        doSeek();
      } else {
        this.pendingSeekTime = safeTime;
        const onLoaded = () => {
          this.video.removeEventListener('loadedmetadata', onLoaded);
          doSeek();
        };
        this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      }
    });
  }

  /**
   * Destroy player and clean up listeners
   */
  destroy() {
    window.removeEventListener('keydown', this._keyboardHandler);

    if (this.hls) {
      try {
        this.hls.destroy();
      } catch (e) {}
      this.hls = null;
    }

    if (this.video) {
      this.video.pause();
      this.video.src = '';
      this.video.load();
    }
    this.container.innerHTML = '';
  }

  // -----------------------------
  // Private helpers
  // -----------------------------

  _injectStyles() {
    // Check if styles already injected
    if (document.getElementById('pv-player-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'pv-player-styles';
    style.textContent = `
      .pv-root {
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #020617;
        border-radius: 12px;
        border: 1px solid #1f2937;
        overflow: hidden;
        width: 100%;
      }

      .pv-video-wrapper {
        position: relative;
        background: #000;
        width: 100%;
        height: 0;
        padding-bottom: 56.25%; /* 16:9 aspect ratio */
        overflow: hidden;
      }

      .pv-video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: block;
        background: #000;
        object-fit: cover;
      }

      .pv-big-play {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 64px;
        height: 64px;
        border-radius: 999px;
        border: none;
        background: rgba(15,23,42,0.85);
        color: #e5e7eb;
        font-size: 28px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s ease, transform 0.1s ease, opacity 0.2s ease;
      }

      .pv-big-play:hover {
        background: rgba(30,64,175,0.95);
        transform: scale(1.04);
      }

      .pv-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: #020617;
        border-top: 1px solid #111827;
      }

      .pv-btn {
        border: none;
        background: transparent;
        color: #e5e7eb;
        cursor: pointer;
        padding: 4px 6px;
        font-size: 14px;
        border-radius: 6px;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .pv-btn:hover {
        background: #111827;
      }

      .pv-play-toggle {
        font-size: 16px;
      }

      .pv-time {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        color: #9ca3af;
        white-space: nowrap;
      }

      .pv-progress {
        flex: 1;
        cursor: pointer;
      }

      .pv-spacer {
        flex: 0 0 4px;
      }

      .pv-volume-wrapper {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .pv-volume {
        width: 50px;
        cursor: pointer;
      }

      .pv-speed {
        border-radius: 4px;
        border: 1px solid #1f2937;
        background: #020617;
        color: #e5e7eb;
        padding: 6px 8px;
        font-size: 11px;
        cursor: pointer;
        min-width: auto;
        width: auto;
        height: auto;
        line-height: 1;
        text-align: center;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .pv-speed:focus {
        outline: none;
        border-color: #2563eb;
      }

      .pv-pip,
      .pv-fullscreen {
        font-size: 14px;
      }

      .pv-download {
        font-size: 16px;
        padding: 6px 8px;
      }

      .pv-loading {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 20;
        display: none;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 12px;
      }

      .pv-loading.show {
        display: flex;
      }

      .pv-loading-spinner {
        width: 48px;
        height: 48px;
        border: 4px solid rgba(255, 255, 255, 0.2);
        border-top-color: #fff;
        border-radius: 50%;
        animation: pv-spin 0.8s linear infinite;
      }

      @keyframes pv-spin {
        to { transform: rotate(360deg); }
      }

      .pv-loading-text {
        color: #fff;
        font-size: 14px;
        font-weight: 500;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      }

      /* Fullscreen mode styles */
      .pv-root:fullscreen {
        width: 100vw;
        height: 100vh;
        border-radius: 0;
        background: #000;
      }

      .pv-root:fullscreen .pv-video-wrapper {
        flex: 1;
        height: calc(100vh - 60px);
        padding-bottom: 0;
      }

      .pv-root:fullscreen .pv-video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .pv-root:fullscreen .pv-controls {
        position: relative;
        z-index: 10;
        background: rgba(2, 6, 23, 0.95);
        backdrop-filter: blur(10px);
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
      }

      /* Alternative fullscreen selector for better browser support */
      .pv-root:-webkit-full-screen {
        width: 100vw;
        height: 100vh;
        border-radius: 0;
        background: #000;
      }

      .pv-root:-moz-full-screen {
        width: 100vw;
        height: 100vh;
        border-radius: 0;
        background: #000;
      }

      .pv-root:-ms-fullscreen {
        width: 100vw;
        height: 100vh;
        border-radius: 0;
        background: #000;
      }
    `;
    document.head.appendChild(style);
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="pv-root">
        <div class="pv-video-wrapper">
          <video class="pv-video" preload="auto" playsinline crossorigin="anonymous"></video>
          <div class="pv-loading" id="pvLoading">
            <div class="pv-loading-spinner"></div>
            <div class="pv-loading-text">Loading...</div>
          </div>
          <button class="pv-big-play" aria-label="Play video">
            ▶
          </button>
        </div>
        <div class="pv-controls">
          <button class="pv-btn pv-play-toggle" aria-label="Play/Pause">
            ▶
          </button>
          <div class="pv-time">
            <span class="pv-current-time">00:00</span> /
            <span class="pv-duration">00:00</span>
          </div>
          <input
            type="range"
            class="pv-progress"
            min="0"
            max="1000"
            value="0"
            aria-label="Seek"
          />
          <div class="pv-spacer"></div>
          <div class="pv-volume-wrapper">
            <button class="pv-btn pv-mute-toggle" aria-label="Mute/Unmute">
              🔊
            </button>
            <input
              type="range"
              class="pv-volume"
              min="0"
              max="100"
              value="100"
              aria-label="Volume"
            />
          </div>
          <button class="pv-btn pv-pip" aria-label="Picture in Picture">
            ⧉
          </button>
          <button class="pv-btn pv-fullscreen" aria-label="Fullscreen">
            ⛶
          </button>
        </div>
      </div>
    `;

    this.video = this.container.querySelector('.pv-video');
    this.bigPlayBtn = this.container.querySelector('.pv-big-play');
    this.playToggleBtn = this.container.querySelector('.pv-play-toggle');
    this.currentTimeEl = this.container.querySelector('.pv-current-time');
    this.durationEl = this.container.querySelector('.pv-duration');
    this.progressEl = this.container.querySelector('.pv-progress');
    this.volumeEl = this.container.querySelector('.pv-volume');
    this.muteToggleBtn = this.container.querySelector('.pv-mute-toggle');
    this.pipBtn = this.container.querySelector('.pv-pip');
    this.fullscreenBtn = this.container.querySelector('.pv-fullscreen');
    this.loadingEl = this.container.querySelector('#pvLoading');
    this.loadingTextEl = this.loadingEl?.querySelector('.pv-loading-text');

    this.video.playbackRate = this.options.defaultPlaybackRate || 1.0;
    this.video.volume = 1.0;
    this.video.muted = false;

    this._initSource(); // set src / HLS
  }

  /**
   * Initialize source: plain MP4/WebM or HLS (.m3u8 via hls.js)
   */
  _initSource() {
    if (!this.video || !this.videoSrc) return;

    const isHls = /\.m3u8($|\?)/i.test(this.videoSrc);

    if (isHls) {
      // Safari / iOS have native HLS support
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = this.videoSrc;
        this.video.load();
      } else if (window.Hls && window.Hls.isSupported()) {
        this.hls = new window.Hls({
          enableWorker: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        this.hls.loadSource(this.videoSrc);
        this.hls.attachMedia(this.video);
      } else {
        console.warn('HLS not supported, falling back to direct src');
        this.video.src = this.videoSrc;
        this.video.load();
      }
    } else {
      // Regular file (mp4, webm, etc.)
      this.video.src = this.videoSrc;
      this.video.load();
    }
  }

  _attachEvents() {
    if (!this.video) return;

    // Metadata
    this.video.addEventListener('loadedmetadata', () => {
      this.isMetadataLoaded = true;
      const metaDuration = this.video.duration || 0;
      this.duration = this.options.duration || metaDuration || 0;
      this._updateDurationDisplay();

      // Apply pending seek if any
      if (this.pendingSeekTime != null) {
        this.video.currentTime = this.pendingSeekTime;
        this.pendingSeekTime = null;
      }
    });

    // Show loading when seeking
    this.video.addEventListener('seeking', () => {
      this.isSeeking = true;
      this._showLoading('Seeking...');
    });

    // Hide loading when seek completes
    this.video.addEventListener('seeked', () => {
      this.isSeeking = false;
      this._hideLoading();
    });

    // Show loading when waiting for data
    this.video.addEventListener('waiting', () => {
      if (this.isPlaying) {
        this._showLoading('Buffering...');
      }
    });

    // Hide loading when can play
    this.video.addEventListener('canplay', () => {
      if (!this.isSeeking) {
        this._hideLoading();
      }
    });

    this.video.addEventListener('canplaythrough', () => {
      if (!this.isSeeking) {
        this._hideLoading();
      }
    });

    // Time updates
    this.video.addEventListener('timeupdate', () => {
      if (!this.isSeeking) {
        this._updateTimeDisplay();
        this._updateProgressFromVideo();
      }
      if (this.options.onTimeUpdate) {
        // Throttle onTimeUpdate to ~5 times/sec
        const now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        if (now - this._lastOnTimeUpdate > 200) {
          this._lastOnTimeUpdate = now;
          this.options.onTimeUpdate(this.video.currentTime || 0);
        }
      }
    });

    // Play/pause state
    this.video.addEventListener('play', () => {
      this.isPlaying = true;
      this._updatePlayButtons();
    });
    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      this._updatePlayButtons();
    });
    this.video.addEventListener('ended', () => {
      this.isPlaying = false;
      this._updatePlayButtons();
      // Snap to end
      this._updateTimeDisplay(true);
      this._updateProgressFromVideo();
    });

    // Clicking on video or big button toggles playback
    this.video.addEventListener('click', () => this.togglePlay());
    if (this.bigPlayBtn) {
      this.bigPlayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePlay();
      });
    }

    // Play/pause button
    this.playToggleBtn.addEventListener('click', () => this.togglePlay());

    // Progress seeking
    this.progressEl.addEventListener('mousedown', () => {
      this.isSeeking = true;
    });
    this.progressEl.addEventListener('touchstart', () => {
      this.isSeeking = true;
    });

    const finishSeek = () => {
      if (!this.isSeeking) return;
      this.isSeeking = false;
      // Commit a single seek at the end
      this._seekFromProgress(false);
    };

    // While dragging → only preview label, no real seek
    this.progressEl.addEventListener('input', () => {
      this._seekFromProgress(true);
    });

    this.progressEl.addEventListener('mouseup', finishSeek);
    this.progressEl.addEventListener('mouseleave', () => {
      if (this.isSeeking) finishSeek();
    });
    this.progressEl.addEventListener('touchend', finishSeek);
    this.progressEl.addEventListener('touchcancel', finishSeek);

    // Volume
    this.volumeEl.addEventListener('input', () => {
      const vol = this.volumeEl.value / 100;
      this.video.volume = vol;
      this.video.muted = vol === 0;
      this._updateMuteButton();
    });

    this.muteToggleBtn.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      if (!this.video.muted && this.video.volume === 0) {
        this.video.volume = 0.5;
        this.volumeEl.value = 50;
      }
      this._updateMuteButton();
    });

    // PiP
    this.pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled) {
          await this.video.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP error:', err);
      }
    });

    // Fullscreen
    this.fullscreenBtn.addEventListener('click', () => {
      const root = this.container.querySelector('.pv-root') || this.container;
      if (!document.fullscreenElement) {
        if (root.requestFullscreen) {
          root.requestFullscreen();
        } else if (root.webkitRequestFullscreen) {
          root.webkitRequestFullscreen();
        } else if (root.mozRequestFullScreen) {
          root.mozRequestFullScreen();
        } else if (root.msRequestFullscreen) {
          root.msRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
          document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
          document.msExitFullscreen();
        }
      }
    });

    // Listen for fullscreen changes to ensure controls are visible
    document.addEventListener('fullscreenchange', () => {
      const root = this.container.querySelector('.pv-root');
      if (root && document.fullscreenElement === root) {
        const controls = root.querySelector('.pv-controls');
        if (controls) {
          controls.style.display = 'flex';
          controls.style.visibility = 'visible';
          controls.style.opacity = '1';
        }
      }
    });

    document.addEventListener('webkitfullscreenchange', () => {
      const root = this.container.querySelector('.pv-root');
      if (root && document.webkitFullscreenElement === root) {
        const controls = root.querySelector('.pv-controls');
        if (controls) {
          controls.style.display = 'flex';
          controls.style.visibility = 'visible';
          controls.style.opacity = '1';
        }
      }
    });

    // Keyboard shortcuts (global, but ignore when typing in inputs/textareas)
    window.addEventListener('keydown', this._keyboardHandler);
  }

  _handleKeydown(e) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 'ArrowRight') {
      const delta = e.shiftKey ? 10 : 5;
      this._seekRelative(delta);
    } else if (e.key === 'ArrowLeft') {
      const delta = e.shiftKey ? 10 : 5;
      this._seekRelative(-delta);
    }
  }

  togglePlay() {
    if (!this.video) return;
    if (this.isPlaying) {
      this.video.pause();
    } else {
      const playPromise = this.video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn('Autoplay blocked or play error:', err);
        });
      }
    }
  }

  _seekRelative(deltaSeconds) {
    if (!this.video) return;
    const current = this.video.currentTime || 0;
    const duration = this.duration || this.video.duration || 0;
    const target = Math.min(Math.max(current + deltaSeconds, 0), duration || current + deltaSeconds);
    // Prefer fastSeek for instant jump if supported
    try {
      if (typeof this.video.fastSeek === 'function') {
        this.video.fastSeek(target);
      } else {
        this.video.currentTime = target;
      }
    } catch (e) {
      try { this.video.currentTime = target; } catch (e2) {}
    }
  }

  /**
   * Seeking logic:
   * - previewOnly=true: update label only, DO NOT touch video.currentTime
   * - previewOnly=false: single actual seek (on release)
   */
  _seekFromProgress(previewOnly = false) {
    if (!this.video || !this.progressEl) return;

    const rawValue = parseFloat(this.progressEl.value);
    const ratio = Number.isFinite(rawValue) ? rawValue / 1000 : NaN;
    const duration = this.duration || this.video.duration || 0;

    if (!Number.isFinite(duration) || duration <= 0) return;

    const time = ratio * duration;
    if (!Number.isFinite(time)) return;

    const clamped = Math.min(Math.max(time, 0), duration);

    if (previewOnly) {
      // Only update the label; do NOT change the video position while dragging
      this.currentTimeEl.textContent = this._formatTime(clamped);
    } else {
      try {
        // Use fastSeek if available to reduce buffering delay
        if (typeof this.video.fastSeek === 'function') {
          try { this.video.fastSeek(clamped); } catch (e) { this.video.currentTime = clamped; }
        } else {
          this.video.currentTime = clamped;
        }
      } catch (err) {
        // ignore invalid assignment
      }
      this.currentTimeEl.textContent = this._formatTime(clamped);
    }
  }

  _updateTimeDisplay(forceEnd = false) {
    if (!this.video) return;
    const duration = this.duration || this.video.duration || 0;
    const current = forceEnd ? duration : (this.video.currentTime || 0);
    this.currentTimeEl.textContent = this._formatTime(current);
  }

  _updateDurationDisplay() {
    const duration = this.duration || this.video.duration || 0;
    this.durationEl.textContent = duration ? this._formatTime(duration) : '00:00';
  }

  _updateProgressFromVideo() {
    if (!this.video || !this.progressEl) return;
    const duration = this.duration || this.video.duration || 0;
    if (!duration) return;
    const current = this.video.currentTime || 0;
    const ratio = current / duration;
    this.progressEl.value = Math.min(1000, Math.max(0, Math.round(ratio * 1000)));
  }

  _updatePlayButtons() {
    const icon = this.isPlaying ? '⏸' : '▶';
    if (this.playToggleBtn) this.playToggleBtn.textContent = icon;
    if (this.bigPlayBtn) {
      this.bigPlayBtn.style.opacity = this.isPlaying ? '0' : '1';
      this.bigPlayBtn.style.pointerEvents = this.isPlaying ? 'none' : 'auto';
    }
  }

  _updateMuteButton() {
    if (!this.muteToggleBtn) return;
    const icon = this.video.muted || this.video.volume === 0 ? '🔇' : '🔊';
    this.muteToggleBtn.textContent = icon;
  }

  _formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  _showLoading(text = 'Loading...') {
    if (this.loadingEl) {
      this.loadingEl.classList.add('show');
      this.isLoading = true;
      if (this.loadingTextEl) {
        this.loadingTextEl.textContent = text;
      }
    }
  }

  _hideLoading() {
    if (this.loadingEl) {
      this.loadingEl.classList.remove('show');
      this.isLoading = false;
    }
  }

  async downloadVideo() {
    if (!this.videoSrc) return;

    try {
      const filename = this._getVideoFilename();

      // For same-origin URLs, use direct download
      try {
        const url = new URL(this.videoSrc);
        const isSameOrigin = url.origin === window.location.origin;

        if (isSameOrigin) {
          const link = document.createElement('a');
          link.href = this.videoSrc;
          link.download = filename;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return;
        }
      } catch (e) {
        // URL parsing failed, try fetch method
      }

      // For cross-origin URLs (like S3), fetch and create blob
      this._showLoading('Downloading...');
      const response = await fetch(this.videoSrc);
      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up blob URL
      setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
      this._hideLoading();
    } catch (error) {
      console.error('Download error:', error);
      this._hideLoading();
      // Fallback: open in new tab
      window.open(this.videoSrc, '_blank');
    }
  }

  _getVideoFilename() {
    // Extract filename from URL or use default
    try {
      const url = new URL(this.videoSrc);
      const pathname = url.pathname;
      const filename = pathname.split('/').pop();
      if (filename && filename.includes('.')) {
        return filename;
      }
    } catch (e) {
      // If URL parsing fails, try to extract from string
      const match = this.videoSrc.match(/\/([^\/]+\.(webm|mp4|mov|avi))(\?|$)/i);
      if (match && match[1]) {
        return match[1];
      }
    }
    // Default filename
    return 'video.webm';
  }
}

// Make available globally (for your inline script)
window.ProfessionalVideoPlayer = ProfessionalVideoPlayer;
