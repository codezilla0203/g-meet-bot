import React, { useState, useEffect } from 'react';
import { configApi } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

interface ConfigData {
  botName: string;
  webhookUrl: string;
  summaryTemplate: string;
  botLogoUrl: string;
  maxRecordingTime: number;
  totalRecordingMinutes: number;
}

interface ConfigurationProps {
  isActive?: boolean;
}

export default function Configuration({ isActive = true }: ConfigurationProps) {
  const { user, isLoading: authLoading } = useAuth();
  const [config, setConfig] = useState<ConfigData>({
    botName: '',
    webhookUrl: '',
    summaryTemplate: '',
    botLogoUrl: '',
    maxRecordingTime: 60,
    totalRecordingMinutes: 0,
  });
  
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Load configuration when:
    // 1. User is authenticated and auth check is complete
    // 2. Tab becomes active (isActive changes to true)
    if (!authLoading && user && isActive) {
      loadConfiguration();
    }
  }, [user, authLoading, isActive]);

  const loadConfiguration = async () => {
    try {
      setIsLoading(true);
      console.log('Loading configuration...');
      const savedConfig = await configApi.getConfig();
      console.log('Configuration loaded:', savedConfig);
      console.log('Summary template length:', savedConfig.summaryTemplate?.length || 0);
      console.log('Summary template value:', savedConfig.summaryTemplate?.substring(0, 100) || 'empty');
      setConfig(prev => ({ ...prev, ...savedConfig }));
    } catch (error) {
      console.error('Failed to load configuration:', error);
      setStatus('❌ Failed to load configuration.');
      setTimeout(() => setStatus(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setConfig(prev => ({
      ...prev,
      [name]: name === 'maxRecordingTime' || name === 'totalRecordingMinutes' 
        ? parseInt(value) || 0 
        : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      console.log('Saving configuration:', config);
      const result = await configApi.saveConfig(config);
      console.log('Configuration saved:', result);
      setStatus('✅ Configuration saved successfully!');
      setTimeout(() => setStatus(''), 3000);
      
      // Reload configuration after save to get the latest data from server
      await loadConfiguration();
    } catch (error: any) {
      console.error('Failed to save configuration:', error);
      console.error('Error details:', error.response);
      const errorMessage = error.response?.data?.error || 'Failed to save configuration.';
      setStatus(`❌ ${errorMessage}`);
      setTimeout(() => setStatus(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  // Show loading if auth is still checking or config is loading
  if (authLoading || (isLoading && !config.botName && !config.webhookUrl && !config.summaryTemplate)) {
    return (
      <div className="card">
        <h2 className="card-title">Configuration</h2>
        <div className="text-center py-8">
          <div className="loading-spinner"></div>
          <p className="mt-2 text-gray-600">Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card-title">Configuration</h2>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Bot Name */}
        <div className="form-group">
          <label className="form-label" htmlFor="botName">
            Bot Name
          </label>
          <input
            id="botName"
            name="botName"
            type="text"
            placeholder="CXFlow Meeting Bot"
            value={config.botName}
            onChange={handleInputChange}
          />
          <div className="form-help">
            This name may be shown when the bot joins the meeting.
          </div>
        </div>

        {/* Webhook URL */}
        <div className="form-group">
          <label className="form-label" htmlFor="webhookUrl">
            Webhook URL
          </label>
          <input
            id="webhookUrl"
            name="webhookUrl"
            type="text"
            placeholder="https://yourapp.com/webhooks/meeting-bot"
            value={config.webhookUrl}
            onChange={handleInputChange}
          />
          <div className="form-help">
            We will send meeting events, transcript and summary to this endpoint.
          </div>
        </div>

        {/* Summary Template */}
        <div className="form-group">
          <label className="form-label" htmlFor="summaryTemplate">
            Summary Template (AI Prompt)
          </label>
          <textarea
            id="summaryTemplate"
            name="summaryTemplate"
            rows={8}
            placeholder="Describe how the AI should summarize the meeting, structure key points, decisions, and next steps..."
            value={config.summaryTemplate}
            onChange={handleInputChange}
          />
          <div className="form-help">
            Custom AI prompt used to generate the meeting summary.
          </div>
        </div>

        {/* Bot Logo URL */}
        <div className="form-group">
          <label className="form-label" htmlFor="botLogoUrl">
            Bot Logo URL
          </label>
          <input
            id="botLogoUrl"
            name="botLogoUrl"
            type="text"
            placeholder="https://www.cxflow.io/app/images/logo.png"
            value={config.botLogoUrl}
            onChange={handleInputChange}
          />
          <div className="form-help">
            Logo shown when the bot joins the meeting. Default: https://www.cxflow.io/app/images/logo.png
          </div>
        </div>

        {/* Recording Time Settings */}
        <div className="form-row two-columns">
          <div className="form-group">
            <label className="form-label" htmlFor="maxRecordingTime">
              Maximum Recording Time per Meeting (minutes)
            </label>
            <input
              id="maxRecordingTime"
              name="maxRecordingTime"
              type="number"
              min="1"
              max="480"
              value={config.maxRecordingTime}
              onChange={handleInputChange}
            />
            <div className="form-help">
              The bot will automatically stop recording after this time.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="totalRecordingMinutes">
              Total recording minutes
            </label>
            <input
              id="totalRecordingMinutes"
              name="totalRecordingMinutes"
              type="number"
              value={config.totalRecordingMinutes}
              onChange={handleInputChange}
              readOnly
            />
            <div className="form-help">
              Total recording minutes available in your current plan (read-only).
            </div>
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isLoading}
          className="btn-primary w-full"
        >
          {isLoading ? 'Saving...' : 'Save Configuration'}
        </button>

        {/* Status */}
        {status && (
          <div className={status.includes('✅') ? 'success-message' : status.includes('❌') ? 'error-message' : 'text-sm text-center mt-2'}>
            {status}
          </div>
        )}
      </form>
    </div>
  );
}
