import React, { useState, useEffect } from 'react';
import { Play, Square, Trash2, Eye, ArrowLeft } from 'lucide-react';
import { botApi, configApi } from '@/lib/api';
import BotDetail from './BotDetail';

interface Bot {
  id: string;
  meetUrl?: string;
  meeting_url?: string;
  status: string;
  createdAt?: string;
  created_at?: string;
  title?: string;
  caption_language?: string;
  recording_type?: string;
  meeting_type?: string;
  isHistorical?: boolean;
}

interface MyBotsProps {
  onBotDetailView?: (isViewing: boolean) => void;
  onBackRequest?: () => void;
}

export default function MyBots({ onBotDetailView, onBackRequest }: MyBotsProps) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [userConfigLogo, setUserConfigLogo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    onBotDetailView?.(selectedBot !== null);
  }, [selectedBot, onBotDetailView]);

  useEffect(() => {
    if (onBackRequest) {
      // Store the callback to be called when back is requested
      (window as any).__myBotsBackHandler = () => {
        setSelectedBot(null);
      };
      return () => {
        delete (window as any).__myBotsBackHandler;
      };
    }
  }, [onBackRequest]);

  useEffect(() => {
    loadBots();
    // load user configuration (to get bot logo URL)
    (async () => {
      try {
        const cfg = await configApi.getConfig();
        // config API returns an object with botLogoUrl per api.ts saveConfig signature
        setUserConfigLogo(cfg?.botLogoUrl || null);
      } catch (err) {
        // ignore config load errors silently
      }
    })();
    
    // Start auto-refresh
    const interval = setInterval(loadBots, 3000);
    setRefreshInterval(interval);
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);

  const loadBots = async () => {
    try {
      const response = await botApi.getBots();
      setBots(response.bots || []);
    } catch (error) {
      console.error('Failed to load bots:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStopBot = async (botId: string) => {
    if (!confirm('Are you sure you want to stop this bot?')) return;
    
    try {
      await botApi.stopBot(botId);
      await loadBots(); // Refresh the list
    } catch (error: any) {
      alert(error.message || 'Failed to stop bot');
    }
  };

  const handleDeleteBot = async (botId: string) => {
    if (!confirm('Are you sure you want to delete this bot? This action cannot be undone.')) return;
    
    try {
      await botApi.deleteBot(botId);
      await loadBots(); // Refresh the list
      if (selectedBot?.id === botId) {
        setSelectedBot(null);
      }
    } catch (error: any) {
      alert(error.message || 'Failed to delete bot');
    }
  };

  const handleViewDetails = async (bot: Bot) => {
    try {
      setSelectedBot(bot);
    } catch (error: any) {
      alert(error.message || 'Failed to load bot details');
    }
  };

  const getStatusClass = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
      case 'recording':
        return 'bot-status-badge bot-status-running';
      case 'stopped':
      case 'completed':
        return 'bot-status-badge bot-status-stopped';
      case 'error':
      case 'failed':
        return 'bot-status-badge bot-status-error';
      case 'starting':
      case 'joining':
        return 'bot-status-badge bot-status-starting';
      default:
        return 'bot-status-badge';
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return 'Invalid Date';
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Invalid Date';
    }
  };

  if (selectedBot) {
    return (
      <BotDetail
        botId={selectedBot.id}
        onBack={() => setSelectedBot(null)}
      />
    );
  }

  return (
    <div className="card">
      <h2 className="card-title">Your Meeting Bots</h2>
      
      {isLoading ? (
        <div className="empty-state">
          <div className="spinner spinner-center"></div>
          <p>Loading bots...</p>
        </div>
      ) : bots.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <img src="https://www.cxflow.io/app/images/logo.png" alt="CXFlow Logo" className="bot-logo-medium" />
          </div>
          <div className="empty-state-text">No bots created yet. Go to "Create Bot" tab to start!</div>
        </div>
      ) : (
        <div className="bots-list-container">
              {bots
            .sort((a, b) => {
              const dateA = new Date(a.createdAt || a.created_at || 0).getTime();
              const dateB = new Date(b.createdAt || b.created_at || 0).getTime();
              return dateB - dateA;
            })
            .map((bot) => {
              const statusClass = bot.status === 'completed' ? 'status-completed' : 
                                 bot.status === 'recording' || bot.status === 'running' ? 'status-recording' : 
                                 'status-failed';
              
              // Prepare shortened Meet code for display (remove protocol/host and any query string)
              const rawMeet = (bot.meetUrl || bot.meeting_url || '');
              const meetCode = rawMeet ? rawMeet.replace(/^https?:\/\/meet\.google\.com\//i, '').replace(/\?.*$/, '') : '';

              return (
                <div
                  key={bot.id}
                  className="bot-item"
                >
                  <div className="bot-info">
                    {/* Decide display name: if completed and a title exists, show title; otherwise show UUID */}
                    {(() => {
                      // Prefer an AI-generated or metadata title when available.
                      const metaTitle = (bot as any).metadata?.title || (bot as any).bot_metadata?.title || (bot as any).meta?.title || (bot as any).title || null;
                      // If metaTitle is the same as the meeting code/ID-like value, prefer bot.title if it's different.
                      const cleanedMetaTitle = metaTitle || null;
                      const displayName = (bot.status && bot.status.toLowerCase() === 'completed' && (cleanedMetaTitle && cleanedMetaTitle !== bot.id))
                        ? cleanedMetaTitle
                        : (bot.status && bot.status.toLowerCase() === 'completed' && bot.title && bot.title !== bot.id)
                          ? bot.title
                          : bot.id;
                      // Build avatar initials from title or id
                      const getInitials = (s: string) => {
                        if (!s) return 'BX';
                        const words = s.trim().split(/\s+|-|_/).filter(Boolean);
                        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
                        // fallback to first 2 alphanumerics
                        const cleaned = s.replace(/[^A-Za-z0-9]/g, '');
                        return cleaned.slice(0, 2).toUpperCase() || s.slice(0,2).toUpperCase();
                      };

                      // prefer user's configured bot logo (global); fallback to per-bot logo fields, then initials
                      const logoSrc = userConfigLogo || (bot as any).logo || (bot as any).logoUrl || (bot as any).thumbnail || (bot as any).config?.logo || (bot as any).botLogo || (bot as any).metadata?.logo || null;

                      return (
                        <div className="bot-id">
                          {logoSrc ? (
                            <img src={logoSrc} alt="bot logo" className="bot-logo-image" />
                          ) : (
                            <div className="bot-avatar">{getInitials(displayName)}</div>
                          )}
                          {bot.isHistorical ? ' (Historical) ' : ''}
                          <span className="bot-display-name">{displayName}</span>
                          {bot.isHistorical && (
                            <span className="historical-badge">
                              HISTORICAL
                            </span>
                          )}
                        </div>
                      );
                    })()}

                    <div className="bot-meta">
                      <div>
                        <span className="bot-meta-item">
                        📅 Created: {formatDate(bot.createdAt || bot.created_at || '')}
                      </span>
                      </div>
                      
                      <div style={{ display: 'flex',  justifyContent: 'space-between', alignItems: 'center'}}>
                        <div>
                          <span className="bot-meta-item">
                            🎯 Status: <span className={`status-badge ${statusClass}`}>
                              {bot.status || 'unknown'}
                            </span>
                          </span>
                          {rawMeet && (
                            <span className="bot-meta-item">
                              📝 {meetCode}
                            </span>
                          )}
                        </div>
                        <div className="bot-actions">
                          <button
                            onClick={() => handleViewDetails(bot)}
                            className="btn-small btn-view-details"
                          >
                            View Details
                          </button>
                        </div>
                      </div>
                      
                    </div>
                  </div>
                  
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
