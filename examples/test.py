import requests
import time

API_BASE = "http://localhost:3000"
MEETING_URL = "https://meet.google.com/hqz-rsif-xjp"  # Replace with your meeting URL

print("🤖 Creating bot...")
response = requests.post(f"{API_BASE}/v1/bots", json={
    'meeting_url': MEETING_URL,
    'bot_name': 'AI Notetaker',
    'transcription': {
        'enabled': True  # Requires DEEPGRAM_API_KEY in .env
    }
})

if response.status_code != 200:
    print(f"❌ Failed to create bot: {response.text}")
    exit(1)

bot_data = response.json()
bot_id = bot_data['bot_id']  # Fixed: was 'id', should be 'bot_id'
print(f"✅ Bot created: {bot_id}")
print(f"📝 IMPORTANT: Admit '{bot_data['bot_name']}' from the waiting room!\n")

# Monitor status
print("📊 Monitoring bot status...")
check_count = 0
while True:
    try:
        status_response = requests.get(f"{API_BASE}/v1/bots/{bot_id}")
        if status_response.status_code != 200:
            print(f"❌ Failed to get status: {status_response.text}")
            break
            
        status = status_response.json()
        check_count += 1
        
        print(f"[Check {check_count}] Status: {status['status']}, Recording: {status.get('stats', {}).get('isRecording', False)}")
        
        if status['status'] == 'completed':
            print("\n✅ Meeting ended, recording complete!")
            break
        elif status['status'] == 'failed':
            print(f"\n❌ Bot failed: {status.get('error', 'Unknown error')}")
            break
        elif status['status'] == 'stopped':
            print("\n⏹️ Bot was stopped")
            break
            
    except Exception as e:
        print(f"Error checking status: {e}")
        break
    
    time.sleep(5)

# Get final details
print("\n📋 Getting final details...")
try:
    details = requests.get(f"{API_BASE}/v1/bots/{bot_id}").json()
    print(f"\nBot ID: {details['bot_id']}")
    print(f"Status: {details['status']}")
    print(f"Output File: {details['output_file']}")
    if details.get('transcript_file'):
        print(f"Transcript File: {details['transcript_file']}")
except Exception as e:
    print(f"Error getting details: {e}")

# List and download recordings
print(f"\n📥 Checking for recordings...")
try:
    recordings = requests.get(f"{API_BASE}/v1/recordings").json()
    bot_recording = None
    
    for recording in recordings['recordings']:
        if recording['recording_id'] == bot_id:
            bot_recording = recording
            break
    
    if bot_recording:
        print(f"Found recording: {bot_recording['filename']} ({bot_recording['size_mb']} MB)")
        
        # Download video
        print("Downloading video...")
        video_response = requests.get(f"{API_BASE}/v1/recordings/{bot_id}")
        if video_response.status_code == 200:
            output_filename = f'meeting_{bot_id}.webm'
            with open(output_filename, 'wb') as f:
                f.write(video_response.content)
            print(f"✅ Downloaded: {output_filename}")
        
        # Download transcript if available
        if bot_recording.get('has_transcript'):
            print("Downloading transcript...")
            transcript_response = requests.get(f"{API_BASE}/v1/recordings/{bot_id}?type=transcript")
            if transcript_response.status_code == 200:
                transcript_filename = f'meeting_{bot_id}_transcript.txt'
                with open(transcript_filename, 'wb') as f:
                    f.write(transcript_response.content)
                print(f"✅ Downloaded: {transcript_filename}")
    else:
        print("⚠️ No recording found yet. The meeting may not have started or recording failed.")
        
except Exception as e:
    print(f"Error downloading: {e}")

print("\n🎉 Test complete!")