chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'GET_STREAM_ID') return;
  try {
    chrome.tabCapture.capture({ audio: true, video: true }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'capture failed' });
        return;
      }
      const tracks = stream.getVideoTracks();
      if (!tracks.length) {
        sendResponse({ ok: false, error: 'no video track' });
        return;
      }
      const settings = tracks[0].getSettings();
      sendResponse({ ok: true, streamId: settings.deviceId || '' });
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return true; // async
});
