const http = require('http');
const { sendWebhook } = require('../src/utils/webhook');

const PORT = process.env.WEBHOOK_HARNESS_PORT ? Number(process.env.WEBHOOK_HARNESS_PORT) : 5005;

function startServer() {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') return res.end('OK');
        let body = '';
        req.on('data', (chunk) => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                console.log('\n---- Received webhook ----');
                console.log('Path:', req.url);
                console.log('Headers:', req.headers);
                console.log('Body:', JSON.stringify(parsed, null, 2));
                console.log('--------------------------\n');
            } catch (e) {
                console.log('Received non-JSON body:', body.slice(0, 200));
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(PORT, (err) => {
            if (err) return reject(err);
            console.log(`Webhook harness listening on http://localhost:${PORT}/webhook`);
            resolve(server);
        });
    });
}

async function run() {
    // Ensure the webhook URL points at this harness
    process.env.WEBHOOK_URL = `http://localhost:${PORT}/webhook`;

    const server = await startServer();

    // Small delay to ensure server is up
    await new Promise(r => setTimeout(r, 250));

    console.log('Sending test webhooks...');

    try {
        await sendWebhook('meeting.bot_joined', {
            meeting_id: 'test-meeting-123',
            meeting_url: 'https://meet.google.com/test-meeting-123',
            joined_at: (new Date()).toISOString(),
            timezone: 'America/Mexico_City'
        });

        await sendWebhook('transcript.completed', {
            meeting_id: 'test-meeting-123',
            language: 'es',
            transcript_url: '/runtime/test-meeting-123/transcripts/captions.json'
        });

        await sendWebhook('summary.completed', {
            meeting_id: 'test-meeting-123',
            summary: 'This is a test summary.',
            public_summary_url: null,
            language: 'es'
        });

        await sendWebhook('error.occurred', {
            meeting_id: 'test-meeting-123',
            code: 's3_upload_error',
            message: 'Simulated upload error',
            details: { localFilePath: '/tmp/fake.webm' }
        });

    } catch (e) {
        console.error('Error sending test webhooks:', e);
    }

    // Wait a second to allow requests to arrive
    await new Promise(r => setTimeout(r, 1000));

    server.close(() => console.log('Webhook harness server closed'));
}

if (require.main === module) {
    run().catch(err => {
        console.error('Harness failed:', err);
        process.exit(1);
    });
}

module.exports = { run, startServer };
