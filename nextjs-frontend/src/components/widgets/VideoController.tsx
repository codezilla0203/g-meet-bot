import React, { useRef } from 'react';

interface VideoControllerProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  videoPlayerRef: React.RefObject<any>;
  onTimeChange: (time: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onPlayPause: () => void;
  onSeekBackward: () => void;
  onSeekForward: () => void;
  onDownload: () => void;
}

export default function VideoController({
  currentTime,
  duration,
  isPlaying,
  playbackRate,
  videoPlayerRef,
  onTimeChange,
  onPlaybackRateChange,
  onPlayPause,
  onSeekBackward,
  onSeekForward,
  onDownload
}: VideoControllerProps) {
  const bottomProgressRef = useRef<HTMLInputElement>(null);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  };

  return (
    <div style={{ 
      background: '#fff', 
      borderTop: '1px solid #e5e7eb',
      padding: '8px 20px 16px',
      flexShrink: 0,
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      boxShadow: '0 -2px 8px rgba(0,0,0,0.1)',
      width: '100%'
    }}>
      {/* Progress Bar */}
      <div style={{ marginBottom: '8px', marginTop: '-24px' }}>
        <input
          ref={bottomProgressRef}
          type="range"
          min="0"
          max={duration || 1000}
          value={currentTime}
          onChange={(e) => {
            const newTime = parseFloat(e.target.value);
            onTimeChange(newTime);
          }}
          style={{
            width: '100%',
            height: '4px',
            background: `linear-gradient(to right, #9333ea 0%, #9333ea ${duration ? (currentTime / duration) * 100 : 0}%, #e5e7eb ${duration ? (currentTime / duration) * 100 : 0}%, #e5e7eb 100%)`,
            borderRadius: '2px',
            outline: 'none',
            cursor: 'pointer',
            WebkitAppearance: 'none',
            appearance: 'none'
          }}
        />
        <style dangerouslySetInnerHTML={{ __html: `
          input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #9333ea;
            cursor: pointer;
            border: 2px solid #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          }
          input[type="range"]::-moz-range-thumb {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #9333ea;
            cursor: pointer;
            border: 2px solid #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          }
        `}} />
      </div>
      
      {/* Time Display and Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* Left: Time Display */}
        <div style={{ fontSize: '14px', color: '#6b7280' }}>
          <span style={{ color: '#374151', fontWeight: 500 }}>{formatTime(currentTime)}</span> / {formatTime(duration)}
        </div>
        
        {/* Center: Control Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, justifyContent: 'center' }}>
          <button
            onClick={() => {
              const rates = [1, 1.25, 1.5, 2];
              const currentIndex = rates.indexOf(playbackRate);
              const nextIndex = (currentIndex + 1) % rates.length;
              onPlaybackRateChange(rates[nextIndex]);
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#374151',
              padding: '8px 12px',
              fontSize: '16px',
              cursor: 'pointer',
              fontFamily: "'Poppins', sans-serif",
              fontWeight: 500
            }}
          >
            {playbackRate}x
          </button>
          <button
            onClick={onSeekBackward}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '28px',
              cursor: 'pointer',
              color: '#374151',
              padding: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '48px',
              height: '48px'
            }}
          >
            ↶
          </button>
          <button
            onClick={onPlayPause}
            style={{
              background: '#9333ea',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              color: '#fff',
              padding: '12px 20px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '60px',
              height: '48px'
            }}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            onClick={onSeekForward}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '28px',
              cursor: 'pointer',
              color: '#374151',
              padding: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '48px',
              height: '48px'
            }}
          >
            ↷
          </button>
          <button
            onClick={onDownload}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '28px',
              cursor: 'pointer',
              color: '#374151',
              padding: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '48px',
              height: '48px'
            }}
          >
            ⬇
          </button>
        </div>
      </div>
    </div>
  );
}

