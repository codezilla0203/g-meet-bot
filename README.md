# 🤖 Google Meet Recording Bot

A professional Google Meet recording bot that joins meetings as a participant, records audio/video using WebRTC, and provides real-time transcription.

## ✨ Features

- **WebRTC Direct Capture** - High-quality audio/video recording directly from browser streams
- **Real-time Transcription** - Live transcription using Deepgram API
- **Automatic Participant Monitoring** - Auto-exits when meeting is empty
- **Self-view Hiding** - Bot hides itself from the video grid
- **REST API** - Simple API for bot management
- **Clean Architecture** - Minimal, production-ready codebase
- **Raw Stream Extraction (NEW)** - Parallel raw audio (F32LE) & video (I420) dump for custom post-processing / ML

## 📁 Project Structure

```
g-meet-node/
├── src/
│   ├── bot.js                    # Main bot logic (537 lines)
│   ├── server.js                 # REST API server (409 lines)
│   └── modules/
│       └── webrtc-capture.js     # WebRTC stream capture
├── examples/
│   └── test.py                   # Python test script
├── docs/
│   ├── API_DOCUMENTATION.md      # API reference
│   └── TROUBLESHOOTING.md        # Common issues & fixes
├── .env                          # Environment variables
├── env.example                   # Environment template
├── package.json                  # Dependencies
├── LOCAL_TESTING_GUIDE.md        # Testing instructions
└── FINAL_STATUS_REPORT.md        # Latest status & fixes
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file:

```bash
PORT=3000
DEEPGRAM_API_KEY=your_deepgram_api_key_here
```

### 3. Start Server

```bash
npm start
```

Server will start on `http://localhost:3000`

### 4. Create a Bot

**Using PowerShell:**

```powershell
$body = @{
    meeting_url = "https://meet.google.com/your-meeting-code"
    bot_name = "AI Recorder"
    transcription = @{
        enabled = $true
    }
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/v1/bots" -Method POST -ContentType "application/json" -Body $body
```

**Using Python:**

```bash
cd examples
python test.py
```

### 5. Admit the Bot

When the bot joins, **manually admit it** from the Google Meet waiting room.

### 6. Bot Behavior

1. ✅ Bot joins meeting with specified name
2. ✅ Waits for admission (you must admit manually)
3. ✅ Starts WebRTC recording automatically
4. ✅ Hides itself from video view
5. ✅ Provides real-time transcription (if Deepgram configured)
6. ✅ Monitors participants every 5 seconds
7. ✅ Auto-exits when meeting is empty
8. ✅ Saves recording as `{bot-id}.webm`
9. ✅ Saves transcript as `{bot-id}_transcript.txt`

## 📡 API Endpoints

### Health Check
```
GET /health
```

### Create Bot
```
POST /v1/bots
Body: {
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "bot_name": "AI Recorder",
  "transcription": {
    "enabled": true
  }
}
```

### Get Bot Status
```
GET /v1/bots/:id
```

### List All Bots
```
GET /v1/bots
```

### Delete Bot
```
DELETE /v1/bots/:id
```

### List Recordings
```
GET /v1/recordings
```

### Download Recording
```
GET /v1/recordings/:id
```

See `docs/API_DOCUMENTATION.md` for complete API reference.

## 🔧 Dependencies

```json
{
  "puppeteer-extra": "^3.3.6",
  "puppeteer-extra-plugin-stealth": "^2.11.2",
  "@deepgram/sdk": "^3.0.0",
  "express": "^4.18.2",
  "uuid": "^9.0.0",
  "fs-extra": "^11.1.1",
  "dotenv": "^16.0.3"
}
```

## 📊 Recording Details

- **Format**: WebM (VP8 video, Opus audio)
- **Video Bitrate**: 2.5 Mbps
- **Audio Bitrate**: 128 kbps
- **Chunk Duration**: 1 second (real-time)
- **Resource Usage**: ~200MB RAM per bot
- **Raw Outputs (optional)**:
  - Audio: `<botId>.f32le` (Float32 little-endian PCM mono @ 48 kHz)
  - Video: `<botId>.i420` (Planar YUV420 frames preceded by 12-byte header: width(uint32LE), height(uint32LE), reserved(uint32LE=0))
  - Meta: `<botId>.raw.json` (capture parameters: fps, dimensions, sampleRate)

Raw capture defaults: 640x360 @ 5 fps to reduce overhead. Adjust inside `WebRTCCapture.startRawCapture()`.

### Converting Raw Files

Audio to WAV (FFmpeg):
```bash
ffmpeg -f f32le -ar 48000 -ac 1 -i BOTID.f32le BOTID.wav
```

Video to MP4 (FFmpeg):
```bash
ffmpeg -f rawvideo -pixel_format yuv420p -video_size 640x360 -framerate 5 -i BOTID.i420 -c:v libx264 -pix_fmt yuv420p BOTID_raw.mp4
```

Node.js first frame parse example:
```js
const fs = require('fs');
const meta = JSON.parse(fs.readFileSync('BOTID.raw.json','utf8'));
const fd = fs.openSync('BOTID.i420','r');
const header = Buffer.alloc(12);
fs.readSync(fd, header, 0, 12, null);
const w = header.readUInt32LE(0); const h = header.readUInt32LE(4);
const frameSize = w * h * 3 / 2; // I420
const frameBuf = Buffer.alloc(frameSize);
fs.readSync(fd, frameBuf, 0, frameSize, null);
// frameBuf now holds Y plane first, then U, then V.
```

## 🐛 Troubleshooting

### Bot Can't Join Meeting
- Ensure meeting URL is valid
- Check if Google Meet is accessible
- Review `docs/TROUBLESHOOTING.md`

### No Transcription
- Verify `DEEPGRAM_API_KEY` in `.env`
- Check Deepgram account has credits
- Review server console for errors

### Recording Not Saved
- Check disk space
- Ensure bot was admitted to meeting
- Verify WebRTC capture started (check console)

### Port Already in Use
```bash
# Windows
taskkill /F /IM node.exe

# Linux/Mac
killall node
```

See `docs/TROUBLESHOOTING.md` for more solutions.

## 📖 Documentation

- **API Documentation**: `docs/API_DOCUMENTATION.md`
- **Troubleshooting**: `docs/TROUBLESHOOTING.md`
- **Testing Guide**: `LOCAL_TESTING_GUIDE.md`
- **Latest Status**: `FINAL_STATUS_REPORT.md`

## 🎯 Architecture

### Bot Flow
1. Launch headless Chrome with stealth mode
2. Navigate to Google Meet URL
3. Enter bot name and request to join
4. Wait for manual admission (timeout: 10 minutes)
5. Inject WebRTC capture script
6. Start recording when tracks are available
7. Monitor participants every 5 seconds
8. Auto-exit when no other participants
9. Save recording and transcript
10. Clean up browser resources

### WebRTC Capture
- Intercepts `RTCPeerConnection` constructor
- Captures remote audio/video tracks
- Uses `MediaRecorder` API for encoding
- Writes chunks in real-time to disk
- No FFmpeg or screen capture required
- Raw mode additionally uses `AudioWorklet` + `MediaStreamTrackProcessor` (WebCodecs) for frame/sample extraction

## 🔒 Security Notes

- Bot requires manual admission to meetings
- No automatic meeting joining
- Recordings stored locally only
- No data sent to external services (except Deepgram for transcription)
- Stealth mode prevents automation detection

## 📝 License

MIT License - Feel free to use and modify

## 🤝 Contributing

This is a clean, minimal implementation. Keep it simple!

## 📞 Support

For issues and questions:
1. Check `docs/TROUBLESHOOTING.md`
2. Review `FINAL_STATUS_REPORT.md`
3. Check server console logs
4. Review error screenshots (saved as `error_*.png`)

---

**Built with ❤️ for seamless Google Meet recording**
