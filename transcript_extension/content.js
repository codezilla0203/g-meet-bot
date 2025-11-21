// ============================================
// CLEAR ALL PREVIOUS STATE FOR FRESH START
// ============================================
// This ensures each bot instance starts clean, preventing localStorage pollution
console.log("🧹 CXFlow Extension: Clearing previous meeting state...");
try {
  localStorage.removeItem('transcript');
  localStorage.removeItem('userName');
  localStorage.removeItem('chatMessages');
  localStorage.removeItem('meetingStartTimeStamp');
  localStorage.removeItem('meetingTitle');
  localStorage.removeItem('operationMode'); // Clear operation mode
  console.log("✅ Previous state cleared successfully");
} catch (e) {
  console.warn("⚠️ Could not clear localStorage:", e);
}

const extensionStatusJSON_bug = {
  status: 400,
  message: "CXFlow Meeting Bot encountered a new error"
};
const mutationConfig = { childList: true, attributes: true, subtree: true };

// Initialize fresh state for this meeting
let userName = "You";
let transcript = [];
let personNameBuffer = "",
  transcriptTextBuffer = "",
  timeStampBuffer = undefined;
let beforePersonName = "",
  beforeTranscriptText = "";
let chatMessages = [];

// Get timezone from localStorage (set by bot.js) or default to Mexico City
const timezone = localStorage.getItem('timezone') || 'America/Mexico_City';
const locale = localStorage.getItem('locale') || 'es-MX';
console.log(`📅 Extension using timezone: ${timezone}, locale: ${locale}`);

let meetingStartTimeStamp = new Date().toISOString().toUpperCase();
let meetingStartTimeFormatted = new Date().toLocaleString(locale, { timeZone: timezone });
let meetingTitle = document.title;
let isTranscriptDomErrorCaptured = false;
let isChatMessagesDomErrorCaptured = false;
let hasMeetingStarted = false;
let hasMeetingEnded = false;

// Global reference to the transcript observer so we don't duplicate it
let transcriptObserver = null;

// Save initial clean state
overWriteChromeStorage(["userName", "chatMessages", "meetingStartTimeStamp", "meetingTitle"], false);

const checkElement = async (selector, text) => {
  if (text) {
    while (!Array.from(document.querySelectorAll(selector)).find(element => element.textContent === text)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } else {
    while (!document.querySelector(selector)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  return document.querySelector(selector);
};

// Initialize extension status (always force to 200 for new meeting)
checkExtensionStatus();
const extensionStatusJSON = {
  status: 200,
  message: "<strong>CXFlow Meeting Bot is running</strong> <br /> Do not turn off captions"
};
console.log("🚀 Extension initialized with status: " + extensionStatusJSON.status);

// Start meeting routines for both UI types
checkElement(".awLEm").then(() => {
  const captureUserNameInterval = setInterval(() => {
    userName = document.querySelector(".awLEm").textContent;
    if (userName || hasMeetingStarted) {
      clearInterval(captureUserNameInterval);
      if (userName !== "")
        overWriteChromeStorage(["userName"], false);
    }
  }, 100);
});

// Try both UI types
meetingRoutines(1);
meetingRoutines(2);

function checkExtensionStatus() {
  localStorage.setItem('extensionStatusJSON', JSON.stringify({
    status: 200,
    message: "<strong>CXFlow Meeting Bot is running</strong> <br /> Do not turn off captions"
  }));
}

/**
 * Set Google Meet caption language based on user preference
 * Supported languages: English, Spanish, French, German, Portuguese, Italian, Japanese, Korean, Chinese, Hindi, etc.
 */
async function setCaptionLanguage() {
  try {
    // Get preferred language from localStorage (default: 'es' for Spanish)
    const preferredLanguage = localStorage.getItem('captionLanguage') || 'es';

    console.log(`Setting caption language to: ${preferredLanguage}`);

    // Map short codes to Google Meet's data-value format
    const languageDataValues = {
      'en': 'en-US',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'it': 'it-IT',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'zh': 'cmn-Hans-CN',
      'hi': 'hi-IN',
      'ar': 'ar-EG',
      'ru': 'ru-RU',
      'nl': 'nl-NL',
      'pl': 'pl-PL',
      'tr': 'tr-TR',
      'vi': 'vi-VN',
      'th': 'th-TH',
      'id': 'id-ID',
      'sv': 'sv-SE',
      'da': 'da-DK',
      'no': 'nb-NO',
      'fi': 'fi-FI'
    };

    const targetDataValue = languageDataValues[preferredLanguage] || 'es-ES';

    // Wait for language selector to be available
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find the language combobox
    const languageCombobox = document.querySelector('[role="combobox"][aria-label*="language" i]');

    if (!languageCombobox) {
      console.warn('Could not find language selector combobox');
      return;
    }

    console.log('Found language combobox, clicking to open...');

    // Click to open the language selector
    languageCombobox.click();
    await new Promise(resolve => setTimeout(resolve, 500));

    // Find the listbox with language options
    const listbox = document.querySelector('[role="listbox"][aria-label*="language" i]');

    if (!listbox) {
      console.warn('Could not find language listbox');
      return;
    }

    // Find the target language option by data-value
    const targetOption = listbox.querySelector(`[role="option"][data-value="${targetDataValue}"]`);

    if (targetOption) {
      console.log(`Found language option: ${targetDataValue}, clicking...`);
      targetOption.click();
      await new Promise(resolve => setTimeout(resolve, 300));
      console.log(`✓ Caption language set to: ${preferredLanguage} (${targetDataValue})`);
    } else {
      console.warn(`Language option not found for: ${preferredLanguage} (${targetDataValue})`);
      // Close the dropdown
      languageCombobox.click();
    }
  } catch (error) {
    console.error('Error setting caption language:', error);
  }
}

async function meetingRoutines(uiType) {
  const meetingEndIconData = {
    selector: "",
    text: ""
  };
  const captionsIconData = {
    selector: "",
    text: ""
  };
  switch (uiType) {
    case 1:
      meetingEndIconData.selector = ".google-material-icons";
      meetingEndIconData.text = "call_end";
      captionsIconData.selector = ".material-icons-extended";
      captionsIconData.text = "closed_caption_off";
      break;
    case 2:
      meetingEndIconData.selector = ".google-symbols";
      meetingEndIconData.text = "call_end";
      captionsIconData.selector = ".google-symbols";
      captionsIconData.text = "closed_caption_off";
      break;
    default:
      break;
  }

  // WAIT UNTIL BOT.JS MARKS ADMISSION (botAdmitted flag set in localStorage)
  try {
    console.log(`⏳ Waiting for bot admission flag (uiType=${uiType})...`);
    const admitted = await waitForBotAdmitted(300000, 500);
    if (!admitted) {
      console.warn(`⚠️ botAdmitted flag not set within timeout (uiType=${uiType})`);
      return;
    }
    console.log(`✅ Bot admitted (uiType=${uiType})`);
  } catch (err) {
    console.warn(`⚠️ Error while waiting for botAdmitted flag (uiType=${uiType}):`, err && err.message ? err.message : err);
    return;
  }

  // If another instance already started the flow, don't duplicate observers
  if (hasMeetingStarted) {
    console.log(`ℹ️ Caption flow already started by another UI type, skipping uiType=${uiType}`);
    return;
  }
  hasMeetingStarted = true;

  chrome.runtime.sendMessage({ type: "new_meeting_started" }, function (response) {
    console.log(response);
  });

  try {
    setTimeout(() => updateMeetingTitle(), 5000);

    // Wait a bit for UI to fully settle after admission
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Robust search for the captions (CC) button that works across UI variations
    let captionsButton = null;
    try {
      const timeoutMs = 30000;
      const pollIntervalMs = 500;
      const start = Date.now();

      const findCaptionsButtonOnce = () => {
        // 1) Prefer a button whose aria-label mentions captions (covers both
        //    "Turn on captions" and "Turn off captions" and localized variants)
        let btn =
          document.querySelector('button[aria-label*="captions" i]') ||
          document.querySelector('button[aria-label*="subtitles" i]');

        if (btn) return btn;

        // 2) Fallback: search icon elements whose text is closed_caption / closed_caption_off
        const icon = Array.from(
          document.querySelectorAll('.google-symbols, .google-material-icons, .material-icons-extended')
        ).find(el => /closed_caption(_off)?/i.test(el.textContent || ''));

        if (icon) {
          // Try to get the closest button ancestor
          return icon.closest('button') || icon.parentElement?.closest('button') || icon;
        }

        return null;
      };

      while (!captionsButton && (Date.now() - start) < timeoutMs) {
        captionsButton = findCaptionsButtonOnce();
        if (!captionsButton) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }

      if (!captionsButton) {
        throw new Error('Timed out waiting for captions button');
      }
    } catch (e) {
      console.warn('Captions button not found in time:', e.message || e);
    }

    // Check operation mode (default to automatic for bot operation)
    let operationMode = localStorage.getItem('operationMode');
    console.log(`📋 Operation mode: ${operationMode || 'automatic (default)'}`);

    if (operationMode === "manual") {
      console.log("⚠️ Manual mode detected - leaving transcript off");
    } else if (captionsButton) {
      // Decide whether we actually need to click (only if captions are OFF)
      const ariaLabel = (captionsButton.getAttribute('aria-label') || '').toLowerCase();
      const iconEl = captionsButton.querySelector('.google-symbols, .google-material-icons, .material-icons-extended');
      const iconText = (iconEl && iconEl.textContent ? iconEl.textContent : '').toLowerCase();

      const shouldTurnOn =
        /turn on/.test(ariaLabel) ||              // "Turn on captions"
        /closed_caption_off/.test(iconText);      // icon shows CC off

      if (shouldTurnOn) {
        console.log("Clicking caption button to TURN ON captions...");
        captionsButton.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        console.log("Captions already appear to be ON (aria-label / icon state), not toggling button.");
      }

      // Verify captions region exists and set language
      const captionRegionCheck =
        document.querySelector('[role="region"][aria-label="Captions"]') ||
        document.querySelector('[role="region"][aria-label*="caption" i]');

      if (captionRegionCheck) {
        console.log("✅ Captions enabled (region detected). Setting language...");
        await setCaptionLanguage();
      } else if (shouldTurnOn) {
        console.warn("⚠️ Caption region not found after enabling - retrying one more time...");
        captionsButton.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await setCaptionLanguage();
      } else {
        console.error("❌ Caption region not found and button state indicates captions are already on/off unexpectedly");
      }
    } else {
      console.error("❌ Caption button not found - transcript will not be collected");
    }

    const transcriptTargetNode =
      document.querySelector('[role="region"][aria-label="Captions"]') ||
      document.querySelector('[role="region"][aria-label*="caption" i]');
    try {
      if (transcriptTargetNode && transcriptTargetNode.childNodes[1]) {
        transcriptTargetNode.childNodes[1].style.opacity = 0.2;
      }
    } catch (error) {
      console.error(error);
    }

    // Start transcript observer (global, per-utterance timing)
    startTranscriptObserver();

    const chatMessagesButton = contains(".google-symbols", "chat")[0];
    if (chatMessagesButton) {
      chatMessagesButton.click();
      let chatMessagesObserver;
      setTimeout(() => {
        if (chatMessagesButton) {
          chatMessagesButton.click();
        }
        try {
          const chatMessagesTargetNode = document.querySelectorAll('div[aria-live="polite"]')[0];

          if (chatMessagesTargetNode) {
            chatMessagesObserver = new MutationObserver(chatMessagesRecorder);
            chatMessagesObserver.observe(chatMessagesTargetNode, mutationConfig);
            console.log("✅ Chat messages observer started");
          } else {
            console.warn("⚠️ Chat messages target not found");
          }
        } catch (error) {
          console.error("❌ Error setting up chat observer:", error);
          showNotification(extensionStatusJSON_bug);
        }
      }, 500);
    } else {
      console.warn("⚠️ Chat button not found - chat messages will not be collected");
    }

    if (operationMode === "manual")
      showNotification({ status: 400, message: "<strong>CXFlow Meeting Bot is not running</strong> <br /> Turn on captions using the CC icon, if needed" });
    else
      showNotification(extensionStatusJSON);

  } catch (error) {
    console.error(error);
    showNotification(extensionStatusJSON_bug);
  }
}

function contains(selector, text) {
  var elements = document.querySelectorAll(selector);
  return Array.prototype.filter.call(elements, function (element) {
    return RegExp(text).test(element.textContent);
  });
}

function showNotification(extensionStatusJSON) {
  let html = document.querySelector("html");
  let obj = document.createElement("div");
  let text = document.createElement("p");

  setTimeout(() => {
    obj.style.display = "none";
  }, 5000);

  if (extensionStatusJSON.status === 200) {
    obj.style.cssText = `color: #2A9ACA; ${commonCSS}`;
    text.innerHTML = extensionStatusJSON.message;
  }
  else {
    obj.style.cssText = `color: orange; ${commonCSS}`;
    text.innerHTML = extensionStatusJSON.message;
  }

  obj.prepend(text);
  if (html)
    html.append(obj);
}

const commonCSS = `background: rgb(255 255 255 / 10%); 
    backdrop-filter: blur(16px); 
    position: fixed;
    top: 5%; 
    left: 0; 
    right: 0; 
    margin-left: auto; 
    margin-right: auto;
    max-width: 780px;  
    z-index: 1000; 
    padding: 0rem 1rem;
    border-radius: 8px; 
    display: flex; 
    justify-content: center; 
    align-items: center; 
    gap: 16px;  
    font-size: 1rem; 
    line-height: 1.5; 
    font-family: 'Google Sans',Roboto,Arial,sans-serif; 
    box-shadow: rgba(0, 0, 0, 0.16) 0px 10px 36px 0px, rgba(0, 0, 0, 0.06) 0px 0px 0px 1px;`;

function chatMessagesRecorder(mutationsList, observer) {
  mutationsList.forEach(mutation => {
    try {
      const chatMessagesElement = document.querySelector('div[aria-live="polite"]');
      if (!chatMessagesElement) return;

      const chatMessageElement = chatMessagesElement.lastElementChild;
      if (!chatMessageElement) return;

      const personName = (chatMessageElement.querySelector('[data-sender-name]')?.textContent ||
        chatMessageElement.firstElementChild?.textContent || '').trim();

      const chatMessageText = (chatMessageElement.querySelector('[data-message-text]')?.textContent ||
        chatMessageElement.lastElementChild?.textContent || '').trim();

      if (!personName || !chatMessageText) return;

      const now = new Date();
      const timeStamp = now.toISOString();
      const timeStampFormatted = now.toLocaleString(locale, { timeZone: timezone });

      const chatMessageBlock = {
        personName: personName,
        timeStamp: timeStamp,
        timeStampFormatted: timeStampFormatted,
        chatMessageText: chatMessageText
      };

      pushUniqueChatBlock(chatMessageBlock);
      overWriteChromeStorage(["chatMessages"], false);
    }
    catch (error) {
      console.error(error);
      if (isChatMessagesDomErrorCaptured === false && hasMeetingEnded === false) {
        console.log("There is a bug in CXFlow Meeting Bot.", error);
        showNotification(extensionStatusJSON_bug);
      }
      isChatMessagesDomErrorCaptured = true;
    }
  });
}

function pushBufferToTranscript() {
  transcript.push({
    "personName": personNameBuffer,
    "timeStamp": timeStampBuffer,
    "personTranscript": transcriptTextBuffer
  });
}

function pushUniqueChatBlock(chatBlock) {
  const isExisting = chatMessages.some(item =>
    item.personName === chatBlock.personName &&
    item.timeStamp === chatBlock.timeStamp &&
    chatBlock.chatMessageText.includes(item.chatMessageText)
  );
  if (!isExisting)
    chatMessages.push(chatBlock);
}

function overWriteChromeStorage(keys, sendDownloadMessage) {
  if (keys.includes("userName"))
    localStorage.setItem('userName', JSON.stringify(userName));
  if (keys.includes("transcript"))
    localStorage.setItem('transcript', JSON.stringify(transcript));
  if (keys.includes("meetingTitle"))
    localStorage.setItem('meetingTitle', meetingTitle);
  if (keys.includes("meetingStartTimeStamp"))
    localStorage.setItem('meetingStartTimeStamp', JSON.stringify(meetingStartTimeStamp));
  if (keys.includes("chatMessages"))
    localStorage.setItem('chatMessages', JSON.stringify(chatMessages));

  if (sendDownloadMessage) {
    if (transcript.length > 0) {
      chrome.runtime.sendMessage({ type: "download" }, function (response) {
        console.log(response);
      });
    }
  }
}

function updateMeetingTitle() {
  try {
    // Prefer explicit header element; fall back to document.title
    const titleElem =
      document.querySelector('.u6vdEc') || // legacy selector
      document.querySelector('.PDXcif');   // newer selector observed Nov 2025

    const rawTitle = (titleElem?.textContent || document.title || '').trim();
    if (!rawTitle) return; // nothing to store

    const invalidFilenameRegex = /[^\w\-_.() ]/g;
    meetingTitle = rawTitle.replace(invalidFilenameRegex, '_');

    overWriteChromeStorage(['meetingTitle'], false);
  } catch (error) {
    console.error('[CXFlow Meeting Bot] updateMeetingTitle error:', error);
  }
}

// Utility: wait until an element containing specific text is present
async function waitForContains(selector, text, timeout = 10000, interval = 200) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const el = contains(selector, text)[0];
      if (el) {
        clearInterval(timer);
        resolve(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${text}`));
      }
    }, interval);
  });
}

// Wait until bot.js marks that the bot has been admitted into the meeting.
// This relies on bot.js doing: localStorage.setItem('botAdmitted', '1') after waitForAdmission().
async function waitForBotAdmitted(timeoutMs = 300000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const flag = localStorage.getItem('botAdmitted');
      if (flag === '1') {
        return true;
      }
    } catch (e) {
      console.warn('⚠️ Error reading botAdmitted flag:', e);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Start the transcript observer and track per-utterance timing.
 * Each entry in `transcript` looks like:
 * {
 *   personName,
 *   timeStamp,          // ISO when this utterance started
 *   timeStampFormatted, // localized string
 *   personTranscript    // final caption text for that utterance
 * }
 */
function startTranscriptObserver(retryCount = 0, maxRetries = 30) {
  // Avoid duplicate observers if we were already started by another UI type
  if (transcriptObserver) {
    console.log("ℹ️ Transcript observer already running, skipping re-init");
    return;
  }

  const captionsRegion =
    document.querySelector('[role="region"][aria-label="Captions"]') ||
    document.querySelector('[role="region"][aria-label*="caption" i]');

  if (!captionsRegion) {
    if (retryCount < maxRetries) {
      const retryDelay = Math.min(500 * Math.pow(1.2, retryCount), 2000); // max 2s
      console.warn(`⚠️ Caption region not found, retry ${retryCount + 1}/${maxRetries} in ${Math.round(retryDelay)}ms...`);
      setTimeout(() => startTranscriptObserver(retryCount + 1, maxRetries), retryDelay);
    } else {
      console.error(`❌ Caption region not found after ${maxRetries} retries - transcript collection failed`);
    }
    return;
  }

  console.log("✅ Caption region found, starting transcript observer");

  // First time we see ANY caption, we set this
  let meetingStartTime = null;

  // One *current* utterance being built
  let activeUtterance = null; // { speaker, text, startedAt: Date }

  // Track when current speaker first appeared in this utterance (for accurate start times)
  let currentSpeakerFirstSeenTime = null;
  let currentSpeakerName = null;

  // For debounced saving
  let lastTranscriptContent = '';
  let saveTimeout = null;
  let lastActiveUtteranceText = '';
  let lastActiveUtteranceSaveTime = null;
  const ACTIVE_UTTERANCE_SAVE_INTERVAL = 2000; // Save active utterance every 2 seconds

  function extractAllLines(region) {
    const lines = [];
    const items = Array.from(region.children).filter(
      el => el.children && el.children.length >= 2
    );

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const speaker = (item.children[0].textContent || '').trim();
      const message = (item.children[1].textContent || '').trim();

      if (speaker && message) {
        lines.push({
          index: i,
          speaker,
          message
        });
      }
    }

    return lines;
  }

  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(() => {
      const currentContent = JSON.stringify(transcript);
      if (currentContent !== lastTranscriptContent) {
        lastTranscriptContent = currentContent;
        overWriteChromeStorage(['transcript'], false);
        console.log(`💾 Transcript saved to localStorage (${transcript.length} entries)`);
      }
    }, 100);
  }

  function saveActiveUtteranceToTranscript() {
    if (!activeUtterance || !activeUtterance.speaker || !activeUtterance.text) return;

    const startedAt = activeUtterance.startedAt || new Date();

    const entry = {
      personName: activeUtterance.speaker,
      timeStamp: startedAt.toISOString(),
      timeStampFormatted: startedAt.toLocaleString(locale, { timeZone: timezone }),
      personTranscript: activeUtterance.text
    };

    const lastEntry = transcript[transcript.length - 1];

    // Check if this is a new entry or an update to the last entry
    if (
      !lastEntry ||
      lastEntry.personName !== entry.personName ||
      lastEntry.personTranscript !== entry.personTranscript
    ) {
      // If same speaker but different text, update the last entry
      if (lastEntry && lastEntry.personName === entry.personName && lastEntry.timeStamp === entry.timeStamp) {
        lastEntry.personTranscript = entry.personTranscript;
      } else {
        // New entry
        transcript.push(entry);
      }
      scheduleSave();
    }
  }

  function finalizeActiveUtterance() {
    if (!activeUtterance || !activeUtterance.speaker || !activeUtterance.text) return;

    const startedAt = activeUtterance.startedAt || new Date();

    const entry = {
      personName: activeUtterance.speaker,
      timeStamp: startedAt.toISOString(),
      timeStampFormatted: startedAt.toLocaleString(locale, { timeZone: timezone }),
      personTranscript: activeUtterance.text
    };

    const lastEntry = transcript[transcript.length - 1];

    // Avoid obvious duplicates (same speaker + same text back-to-back)
    if (
      !lastEntry ||
      lastEntry.personName !== entry.personName ||
      lastEntry.personTranscript !== entry.personTranscript
    ) {
      transcript.push(entry);
      scheduleSave();
    }

    activeUtterance = null;
  }

  transcriptObserver = new MutationObserver(() => {
    const allLines = extractAllLines(captionsRegion);
    if (allLines.length === 0) {
      // Optional: you could finalize after X seconds of silence here
      return;
    }

    const now = new Date();

    // First time we see any captions → set meeting start
    if (!meetingStartTime) {
      meetingStartTime = now;
      meetingStartTimeStamp = meetingStartTime.toISOString();
      meetingStartTimeFormatted = meetingStartTime.toLocaleString(
        locale,
        { timeZone: timezone }
      );
      console.log(`📅 Meeting start time recorded: ${meetingStartTimeStamp}`);
    }

    // Last line is the "current" caption (current speaker)
    const lastLine = allLines[allLines.length - 1];
    const currentSpeaker = lastLine.speaker;
    const currentMessage = lastLine.message.trim();

    if (!currentSpeaker || !currentMessage) return;

    // Track when we first see this speaker in the current utterance
    // If speaker changed, reset the first seen time
    if (currentSpeaker !== currentSpeakerName) {
      currentSpeakerName = currentSpeaker;
      currentSpeakerFirstSeenTime = now;
      console.log(`🎤 Speaker changed to ${currentSpeaker} at ${now.toISOString()}`);
    } else if (!currentSpeakerFirstSeenTime) {
      // Same speaker but first time tracking (shouldn't happen, but safety check)
      currentSpeakerFirstSeenTime = now;
    }

    // First utterance ever
    if (!activeUtterance) {
      activeUtterance = {
        speaker: currentSpeaker,
        text: currentMessage,
        startedAt: currentSpeakerFirstSeenTime || now
      };
      return;
    }

    // Same speaker still talking → update text, keep original startedAt
    if (currentSpeaker === activeUtterance.speaker) {
      if (currentMessage !== activeUtterance.text) {
        const previousText = activeUtterance.text;
        activeUtterance.text = currentMessage;
        
        // Save active utterance periodically or when text changes significantly
        const nowTime = Date.now();
        const textChangedSignificantly = previousText && 
                                        (currentMessage.length > previousText.length + 20);
        const shouldSave = !lastActiveUtteranceSaveTime || 
                         (nowTime - lastActiveUtteranceSaveTime) > ACTIVE_UTTERANCE_SAVE_INTERVAL ||
                         textChangedSignificantly;
        
        if (shouldSave) {
          saveActiveUtteranceToTranscript();
          lastActiveUtteranceSaveTime = nowTime;
          lastActiveUtteranceText = currentMessage;
        }
      }
      return;
    }

    // === Speaker changed here ===
    // 1) finalize previous utterance with its original startedAt
    finalizeActiveUtterance();

    // 2) start new utterance for the new speaker
    // Use the time when we first saw this speaker in this utterance (already tracked above)
    activeUtterance = {
      speaker: currentSpeaker,
      text: currentMessage,
      startedAt: currentSpeakerFirstSeenTime || now
    };
  });

  transcriptObserver.observe(captionsRegion, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Periodic save of active utterance (in case speaker doesn't change for a while)
  const periodicSaveInterval = setInterval(() => {
    if (activeUtterance && activeUtterance.speaker && activeUtterance.text) {
      saveActiveUtteranceToTranscript();
      lastActiveUtteranceSaveTime = Date.now();
    }
  }, ACTIVE_UTTERANCE_SAVE_INTERVAL);

  // Save final utterance when page unloads or meeting ends
  window.addEventListener('beforeunload', () => {
    finalizeActiveUtterance();
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      scheduleSave();
    }
  });

  // Optional: expose a way to flush the last utterance on unload / meeting end
  window.cxFlowFinalizeLastUtterance = () => {
    finalizeActiveUtterance();
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      scheduleSave();
    }
    clearInterval(periodicSaveInterval);
  };
}
