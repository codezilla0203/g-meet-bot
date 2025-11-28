import React, { useState, useEffect } from 'react';
import { botApi, configApi } from '@/lib/api';

interface CreateBotProps {
  onBotCreated?: (botId: string) => void;
}

export default function CreateBot({ onBotCreated }: CreateBotProps) {
  const [formData, setFormData] = useState({
    meetingUrl: '',
    captionLanguage: 'es',
    recordingType: 'audio-video',
    meetingType: 'hr-interview',
    notificationEmails: '',
  });
  
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [botId, setBotId] = useState<string | null>(null);

  const languageOptions = [
    { value: 'es', label: '🇪🇸 Spanish' },
    { value: 'en', label: '🇬🇧 English' },
    { value: 'fr', label: '🇫🇷 French' },
    { value: 'de', label: '🇩🇪 German' },
    { value: 'pt', label: '🇵🇹 Portuguese' },
    { value: 'it', label: '🇮🇹 Italian' },
    { value: 'ja', label: '🇯🇵 Japanese' },
    { value: 'ko', label: '🇰🇷 Korean' },
    { value: 'zh', label: '🇨🇳 Chinese' },
    { value: 'hi', label: '🇮🇳 Hindi' },
    { value: 'ar', label: '🇸🇦 Arabic' },
    { value: 'ru', label: '🇷🇺 Russian' },
    { value: 'nl', label: '🇳🇱 Dutch' },
    { value: 'pl', label: '🇵🇱 Polish' },
    { value: 'tr', label: '🇹🇷 Turkish' },
    { value: 'vi', label: '🇻🇳 Vietnamese' },
    { value: 'th', label: '🇹🇭 Thai' },
    { value: 'id', label: '🇮🇩 Indonesian' },
    { value: 'sv', label: '🇸🇪 Swedish' },
    { value: 'da', label: '🇩🇰 Danish' },
    { value: 'no', label: '🇳🇴 Norwegian' },
    { value: 'fi', label: '🇫🇮 Finnish' },
  ];

  const meetingTypeOptions = [
    { value: 'hr-interview', label: 'HR Interview' },
    { value: 'team-meeting', label: 'Team Meeting' },
    { value: 'client-call', label: 'Client Call' },
    { value: 'training-session', label: 'Training Session' },
    { value: 'project-review', label: 'Project Review' },
    { value: 'sales-call', label: 'Sales Call' },
    { value: 'standup-meeting', label: 'Standup Meeting' },
    { value: 'brainstorming', label: 'Brainstorming Session' },
    { value: 'presentation', label: 'Presentation' },
    { value: 'other', label: 'Other' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.meetingUrl.trim()) {
      alert('Please enter a Google Meet URL');
      return;
    }
    
    if (!formData.meetingUrl.includes('meet.google.com')) {
      alert('Please enter a valid Google Meet URL');
      return;
    }

    setIsLoading(true);
    setStatus('⏳ Starting bot...');

    try {
      const response = await botApi.createBot({
        meeting_url: formData.meetingUrl,
        caption_language: formData.captionLanguage,
        recording_type: formData.recordingType,
        meeting_type: formData.meetingType,
        notification_emails: formData.notificationEmails || undefined,
      });

      setBotId(response.bot_id);
      setStatus('✅ Bot started successfully!');
      onBotCreated?.(response.bot_id);
      
      // Clear form
      setFormData({
        meetingUrl: '',
        captionLanguage: 'es',
        recordingType: 'audio-video',
        meetingType: 'hr-interview',
        notificationEmails: '',
      });

    } catch (error: any) {
      console.error('Failed to create bot:', error);
      setStatus('❌ Failed to start bot.');
      alert(error.message || 'Failed to start bot');
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  return (
    <div className="card">
      <h2 className="card-title">Send Bot to Meeting</h2>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Meeting URL */}
        <div className="form-group">
          <label className="form-label" htmlFor="meetingUrl">
            Meeting URL *
          </label>
          <input
            id="meetingUrl"
            name="meetingUrl"
            type="text"
            placeholder="https://meet.google.com/xxx-xxxx-xxx"
            value={formData.meetingUrl}
            onChange={handleInputChange}
            required
          />
        </div>

        {/* Three column row */}
        <div className="form-row">
          {/* Language */}
          <div className="form-group">
            <label className="form-label" htmlFor="captionLanguage">
              Language
            </label>
            <select
              id="captionLanguage"
              name="captionLanguage"
              value={formData.captionLanguage}
              onChange={handleInputChange}
            >
              {languageOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Recording Type */}
          <div className="form-group">
            <label className="form-label" htmlFor="recordingType">
              Recording
            </label>
            <select
              id="recordingType"
              name="recordingType"
              value={formData.recordingType}
              onChange={handleInputChange}
            >
              <option value="audio-video">Audio + Video</option>
              <option value="audio-only">Audio Only</option>
            </select>
          </div>

          {/* Meeting Type */}
          <div className="form-group">
            <label className="form-label" htmlFor="meetingType">
              Meeting Type
            </label>
            <select
              id="meetingType"
              name="meetingType"
              value={formData.meetingType}
              onChange={handleInputChange}
            >
              {meetingTypeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="form-help">
              Used to enrich the AI prompt and summary template.
            </div>
          </div>
        </div>

        {/* Notification Emails */}
        <div className="form-group">
          <label className="form-label" htmlFor="notificationEmails">
            Emails to receive transcript when meeting ends
          </label>
          <textarea
            id="notificationEmails"
            name="notificationEmails"
            rows={3}
            placeholder="host@example.com, manager@example.com"
            value={formData.notificationEmails}
            onChange={handleInputChange}
          />
          <div className="form-help">Separate multiple emails with commas.</div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isLoading}
          className="btn-primary w-full"
        >
          {isLoading ? 'Starting Bot...' : 'Send Bot'}
        </button>

        {/* Status */}
        {status && (
          <div className={status.includes('✅') ? 'success-message' : status.includes('❌') ? 'error-message' : 'text-sm text-center mt-2'}>
            {status}
          </div>
        )}

        {/* Bot ID Badge */}
        {botId && (
          <div className="badge badge-success" style={{ display: 'block', textAlign: 'center', marginTop: '12px' }}>
            <strong>Bot ID:</strong> {botId}
          </div>
        )}
      </form>
    </div>
  );
}
