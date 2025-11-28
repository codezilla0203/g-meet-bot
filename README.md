# Google Meet Recording Bot

An advanced bot for joining Google Meet sessions, recording audio/video, capturing live transcripts, and generating comprehensive meeting metrics.

## Features

- 🎥 **WebRTC Recording** - Direct stream capture for high-quality recording
- 📝 **Live Transcription** - Real-time captions from Google Meet
- 🎯 **Speaker Detection** - Track who's speaking and when
- 📊 **Meeting Metrics** - Comprehensive analytics (duration, talk time, interruptions, silence, keywords)
- 🤖 **Headless Operation** - Runs in the background without GUI
- 🔄 **Auto-cleanup** - Exits gracefully when meeting ends
- 💾 **Persistent Storage** - Saves recordings, transcripts, and metrics

## Installation

### Prerequisites

- Node.js 16+ 
- Chrome/Chromium browser
- FFmpeg (for audio processing)

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd g-meet-bot
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables (create `.env` file):
```env
# Server Configuration
PORT=3000
RUNTIME_ROOT=./runtime

# Meeting Configuration
MAX_RECORDING_DURATION=60
INACTIVITY_LIMIT=10
ACTIVATE_INACTIVITY_AFTER=2

# OpenAI (optional - for AI-powered summaries)
OPENAI_API_KEY=your_api_key_here

# Custom Keywords (optional)
MEETING_KEYWORDS=["action item","deadline","task","decision"]

# Database
DATABASE_PATH=./meeting_bot.db
```

4. Start the server (modular server):
```bash
# start with npm (recommended)
npm start

# or run directly
node src/start.js

```

## Usage

Quick smoke test

After installing dependencies, you can run a fast smoke test that starts the app on an ephemeral port and validates a few lightweight endpoints:

```bash
npm run smoke
```

Starting a Bot

Send a POST request to create and join a meeting (example):

```bash
curl -X POST http://localhost:3000/api/bot \
  -H "Content-Type: application/json" \
  -d '{
    "meetUrl": "https://meet.google.com/xxx-yyyy-zzz",
    "botName": "Meeting Recorder"
  }'
```

### Checking Bot Status

```bash
curl http://localhost:3000/api/bot/:botId
```

### Stopping a Bot

```bash
curl -X POST http://localhost:3000/api/bot/:botId/leave
```

### Listing All Bots

```bash
curl http://localhost:3000/api/bots
```

## Meeting Metrics

The bot automatically tracks comprehensive meeting metrics:

### Metrics Included

1. **Duration** - Total meeting time with start/end timestamps
2. **Talk Time** - Speaking time per participant with percentages
3. **Interruptions** - Detected speaker interruptions and overlaps
4. **Silence** - Periods of silence during the meeting
5. **Keywords** - Tracking of important keywords (action items, deadlines, etc.)
6. **Participation** - Engagement stats for all participants

### Accessing Metrics

Metrics are saved to `runtime/<botId>/MeetingMetrics.json` and included in bot stats:

```javascript
const stats = bot.getStats();
console.log(stats.meetingMetrics);
```

See [MEETING_METRICS.md](./MEETING_METRICS.md) for detailed documentation.

### Example Usage

```bash
# Run the metrics example script
node examples/metrics-example.js <botId>
```

## File Structure

```
runtime/
└── <botId>/
    ├── video/
    │   └── <botId>.webm          # Recording file
    ├── transcripts/
    │   └── captions.json         # Live captions
    ├── SpeakerTimeframes.json    # Speaker activity
    ├── MeetingMetrics.json       # Meeting metrics
    └── summary.txt               # AI-generated summary
```

## API Reference

### POST /api/bot
Create a new bot and join a meeting

**Request Body:**
```json
{
  "meetUrl": "https://meet.google.com/xxx-yyyy-zzz",
  "botName": "Meeting Recorder",
  "captionLanguage": "en"
}
```

**Response:**
```json
{
  "success": true,
  "botId": "unique-bot-id",
  "message": "Bot created and joining meeting"
}
```

### GET /api/bot/:botId
Get bot status and metrics

**Response:**
```json
{
  "success": true,
  "bot": {
    "id": "bot-id",
    "isCapturing": true,
    "participants": ["John Doe", "Jane Smith"],
    "recordingDuration": 120000,
    "captionsCount": 45,
    "meetingMetrics": {
      "duration": { ... },
      "talkTime": { ... },
      "interruptions": { ... },
      "silence": { ... },
      "keywords": { ... }
    }
  }
}
```

### POST /api/bot/:botId/leave
Stop bot and leave meeting

### GET /api/bots
List all active bots

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `RUNTIME_ROOT` | Storage directory | ./runtime |
| `MAX_RECORDING_DURATION` | Max recording time (minutes) | 60 |
| `INACTIVITY_LIMIT` | Auto-exit after inactivity (minutes) | 10 |
| `ACTIVATE_INACTIVITY_AFTER` | When to start inactivity check (minutes) | 2 |
| `OPENAI_API_KEY` | OpenAI API key (optional) | - |
| `MEETING_KEYWORDS` | Custom keywords to track (JSON array) | Default list |

### Custom Keywords

Customize keywords tracked in meetings:

```env
MEETING_KEYWORDS=["sprint", "standup", "blocker", "review", "demo"]
```

Default keywords include: action item, follow up, deadline, decision, agreement, task, assign, responsible, next steps, priority, budget, timeline, milestone, risk, issue, blocker.

## Advanced Features

### Speaker Timeframes

Track when each participant speaks:

```json
[
  {
    "speakerName": "John Doe",
    "start": 1234567890,
    "end": 1234567950
  }
]
```

### AI-Powered Summaries

When `OPENAI_API_KEY` is configured, the bot generates AI summaries:

- Meeting overview
- Key discussion points
- Action items
- Participant insights

### Automatic Cleanup

The bot automatically:
- Exits when meeting ends
- Saves all data before exiting
- Cleans up browser processes
- Handles errors gracefully

## Deployment

### Systemd Service

Use the provided systemd service file:

```bash
sudo cp meeting-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable meeting-bot
sudo systemctl start meeting-bot
```

### Docker (Coming Soon)

Docker support is planned for easier deployment.

## Troubleshooting

### Bot won't join meeting

- Verify meeting URL is correct
- Check Chrome/Chromium is installed
- Ensure meeting allows guests

### No captions captured

- Verify Google Meet captions are enabled
- Check caption language setting
- Some meetings may have captions disabled

### Recording quality issues

- Increase bitrate in WebRTC settings
- Ensure sufficient CPU/memory
- Check network connection

### Metrics not generating

- Verify captions are being captured
- Check `captions.json` exists
- Review bot logs for errors

## Development

### Running in Development

```bash
# Start with auto-reload
npm run dev

# Run tests
npm test

# Check logs
tail -f meeting-bot-logs.txt
```

### Adding New Metrics

1. Update `calculateMeetingMetrics()` in `bot.js`
2. Add metric calculation logic
3. Include in metrics object
4. Update documentation

## Performance

Typical resource usage per bot:
- **Memory**: 200-400 MB
- **CPU**: 10-20%
- **Disk**: ~100 MB per hour of recording
- **Network**: 1-2 Mbps

## Security

- No credentials stored
- Temporary browser profiles
- Auto-cleanup on exit
- Process isolation
- Secure WebSocket connections

## License

[Your License Here]

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing documentation
- Review logs for errors

## Changelog

### v1.0.0 (Latest)
- ✅ Meeting metrics tracking
- ✅ Duration, talk time, interruptions, silence
- ✅ Keyword tracking and analysis
- ✅ Participation statistics
- ✅ Comprehensive reporting

### v0.9.0
- WebRTC recording
- Live transcription
- Speaker detection
- AI summaries

## Acknowledgments

Built with:
- Puppeteer for browser automation
- Google Meet for video conferencing
- FFmpeg for media processing
- OpenAI for AI summaries

