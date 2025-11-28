import React, { useRef, useState, useEffect } from 'react';

interface TranscriptItem {
  startOffset: number;
  endOffset?: number;
  speaker: string;
  text: string;
  speakingTime?: number;
}

interface TranscriptWidgetProps {
  utterances: TranscriptItem[];
  activeTab: 'transcript' | 'talktime' | 'keywords';
  onTabChange: (tab: 'transcript' | 'talktime' | 'keywords') => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onTranscriptClick: (startTime: number) => void;
  isUserSeeking: boolean;
  talkTimeContent?: React.ReactNode;
  keywordsContent?: React.ReactNode;
}

export default function TranscriptWidget({
  utterances,
  activeTab,
  onTabChange,
  searchTerm,
  onSearchChange,
  onTranscriptClick,
  isUserSeeking,
  talkTimeContent,
  keywordsContent
}: TranscriptWidgetProps) {
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const [highlightedItem, setHighlightedItem] = useState<HTMLElement | null>(null);

  // Escape user input to safely build regex
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Return an array of React nodes with matched searchTerm wrapped in a span
  const renderWithHighlight = (text: string): React.ReactNode => {
    if (!searchTerm) return text;
    try {
      const regex = new RegExp(escapeRegExp(searchTerm), 'gi');
      const nodes: React.ReactNode[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = regex.lastIndex;
        if (start > lastIndex) {
          nodes.push(text.slice(lastIndex, start));
        }
        nodes.push(
          <span key={`${start}-${end}-${match[0]}`} className="search-highlight">
            {match[0]}
          </span>
        );
        lastIndex = end;
      }
      if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
      }
      return nodes.length > 0 ? nodes : text;
    } catch (err) {
      return text; // fallback
    }
  };

  const getSpeakerColor = (speaker: string, speakers: string[]) => {
    const colors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#2563eb',
      '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
    ];
    const index = speakers.indexOf(speaker);
    return colors[index % colors.length];
  };

  const getSpeakerInitial = (speaker: string) => {
    if (!speaker) return '?';
    const parts = speaker.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return speaker[0].toUpperCase();
  };

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  };

  const uniqueSpeakers = Array.from(new Set(utterances.map(u => u.speaker).filter(Boolean)));
  const filteredUtterances = utterances.filter(item => {
    if (!searchTerm) return true;
    return item.text.toLowerCase().includes(searchTerm.toLowerCase()) ||
           item.speaker.toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div className="transcript-section hide-scrollbar" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      <div className="transcript-header-sticky">
        <div className="transcript-tabs">
          <button
            className={`transcript-tab ${activeTab === 'transcript' ? 'active' : ''}`}
            onClick={() => onTabChange('transcript')}
          >
            Transcript {utterances.length > 0 ? `(${utterances.length})` : ''}
          </button>
          <button
            className={`transcript-tab ${activeTab === 'talktime' ? 'active' : ''}`}
            onClick={() => onTabChange('talktime')}
          >
            Speaker Talktime
          </button>
          <button
            className={`transcript-tab ${activeTab === 'keywords' ? 'active' : ''}`}
            onClick={() => onTabChange('keywords')}
          >
            Keywords
          </button>
        </div>
        {activeTab === 'transcript' && (
          <div className="transcript-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transcript-search-icon">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.35-4.35"></path>
            </svg>
            <input
              type="text"
              id="transcriptSearch"
              placeholder="Find or Replace"
              className="transcript-search-input"
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        )}
      </div>

      {activeTab === 'transcript' ? (
        <div ref={transcriptContainerRef} className="transcript-scrollable" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, paddingBottom: '100px' }}>
          {filteredUtterances.length === 0 ? (
            <div className="empty-state">
              <p style={{ color: '#6b7280', marginBottom: '12px' }}>📝 No transcript available</p>
            </div>
          ) : (
            filteredUtterances.map((utt, index) => {
              const speakerColor = getSpeakerColor(utt.speaker, uniqueSpeakers);
              return (
                <div
                  key={index}
                  className="transcript-item"
                  data-start-time={utt.startOffset}
                  data-end-time={utt.endOffset || utt.startOffset + 3}
                  onClick={() => onTranscriptClick(utt.startOffset)}
                >
                  <div className="speaker-info">
                    <div
                      className="speaker-circle"
                      style={{ backgroundColor: speakerColor }}
                    >
                      {getSpeakerInitial(utt.speaker)}
                    </div>
                    <span className="speaker-name">{renderWithHighlight(utt.speaker)}</span>
                    <span> · </span>
                    <span
                      className="time-stamp"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTranscriptClick(utt.startOffset);
                      }}
                    >
                      {formatTime(utt.startOffset)}
                    </span>
                  </div>
                  <div
                    className="transcript-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTranscriptClick(utt.startOffset);
                    }}
                  >
                    {renderWithHighlight(utt.text)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : activeTab === 'talktime' ? (
        <div className="transcript-scrollable" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, paddingBottom: '100px' }}>
          {talkTimeContent}
        </div>
      ) : (
        <div className="transcript-scrollable" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, paddingBottom: '100px' }}>
          {keywordsContent}
        </div>
      )}
    </div>
  );
}

