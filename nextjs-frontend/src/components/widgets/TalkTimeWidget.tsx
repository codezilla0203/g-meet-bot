import React from 'react';

interface TranscriptItem {
  startOffset: number;
  endOffset?: number;
  speaker: string;
  text: string;
  speakingTime?: number;
}

interface TalkTimeWidgetProps {
  metrics?: any;
  utterances: TranscriptItem[];
}

export default function TalkTimeWidget({ metrics, utterances }: TalkTimeWidgetProps) {
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

  const renderSpeakerTalkTime = () => {
    // Check if there's no transcript data or metrics
    if (!utterances || utterances.length === 0) {
      return (
        <div className="empty-state">
          <p>No speaker talk time data available</p>
        </div>
      );
    }

    if (!metrics?.talkTime?.byParticipant) {
      return (
        <div className="empty-state">
          <p>No speaker talk time data available</p>
        </div>
      );
    }

    const talkTime = metrics.talkTime.byParticipant;
    if (!talkTime || Object.keys(talkTime).length === 0) {
      return (
        <div className="empty-state">
          <p>No speaker talk time data available</p>
        </div>
      );
    }

    const speakers = Object.entries(talkTime)
      .sort((a, b) => (b[1] as any).totalMs - (a[1] as any).totalMs)
      .map(([speaker, data]) => ({ speaker, data: data as any }));

    const uniqueSpeakers = utterances.map(u => u.speaker).filter(Boolean);
    const totalTime = speakers.reduce((sum, s) => sum + (s.data.totalMs || 0), 0);

    return (
      <div className="talktime-table">
        <div className="talktime-header-row">
          <div className="talktime-header-cell speakers-header">SPEAKERS</div>
          <div className="talktime-header-cell wpm-header">WPM</div>
          <div className="talktime-header-cell talktime-header">TALKTIME</div>
        </div>
        {speakers.map((stat) => {
          const percentage = totalTime > 0 ? ((stat.data.totalMs || 0) / totalTime) * 100 : 0;
          const color = getSpeakerColor(stat.speaker, uniqueSpeakers);
          const totalMinutes = stat.data.totalMinutes || ((stat.data.totalMs || 0) / 60000);
          const speakerUtterances = utterances.filter(u => u.speaker === stat.speaker);
          const wordCount = speakerUtterances.reduce((sum, u) => sum + (u.text.trim().split(/\s+/).filter(w => w.length > 0).length), 0);
          const wpm = totalMinutes > 0 ? Math.round(wordCount / totalMinutes) : 0;

          const radius = 16;
          const circumference = 2 * Math.PI * radius;
          const offset = circumference - (percentage / 100) * circumference;

          return (
            <div className="talktime-row" key={stat.speaker}>
              <div className="talktime-cell speaker-cell">
                <div className="speaker-icon" style={{ backgroundColor: color }}>
                  {getSpeakerInitial(stat.speaker)}
                </div>
                <span className="speaker-name">{stat.speaker}</span>
              </div>
              <div className="talktime-cell wpm-cell">
                <span className="wpm-dot" />
                <span className="wpm-value">{wpm}</span>
              </div>
              <div className="talktime-cell talktime-cell-chart">
                <svg className="donut-chart" width={40} height={40}>
                  <circle className="donut-background" cx={20} cy={20} r={radius} fill="none" />
                  <circle
                    className="donut-progress"
                    cx={20}
                    cy={20}
                    r={radius}
                    fill="none"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    transform="rotate(-90 20 20)"
                  />
                </svg>
                <span className="talktime-percentage">{percentage.toFixed(0)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      {renderSpeakerTalkTime()}
    </div>
  );
}

