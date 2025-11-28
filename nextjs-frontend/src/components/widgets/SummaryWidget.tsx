import React, { useState, useEffect } from 'react';

interface SummaryWidgetProps {
  summary: string;
}

export default function SummaryWidget({ summary }: SummaryWidgetProps) {
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  // Prevent body scroll while fullscreen overlay is open
  useEffect(() => {
    if (!isFullScreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isFullScreen]);

  // Close fullscreen on Escape key
  useEffect(() => {
    if (!isFullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullScreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullScreen]);

  const formatSummary = (summaryText: string) => {
    if (!summaryText || summaryText === 'No summary available') {
      return 'No summary available';
    }
    
    return summaryText
      .replace(/^# (.+)$/gm, '<h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">$1</h4>')
      .replace(/^### (.+)$/gm, '<h5 style="margin: 8px 0 4px 0; font-size: 13px; font-weight: 600;">$1</h5>')
      .replace(/^• (.+)$/gm, '<li style="margin-left: 20px;">$1</li>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  };

  const handleCopySummary = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    } catch (error) {
      alert('Failed to copy summary');
    }
  };

  return (
    <div>
      <div className="summary-header" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>General Summary</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* fullscreen button - visible via CSS on mobile only */}
          <button
            aria-label="Open summary full screen"
            className="summary-fullscreen-btn"
            onClick={() => setIsFullScreen(true)}
            title="Full screen (mobile)"
            style={{ display: 'inline-flex' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M16 3h3a2 2 0 0 1 2 2v3" />
              <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>

          <button
            className="copy-summary-btn"
            onClick={handleCopySummary}
            title="Copy summary"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              color: '#6b7280',
              transition: 'color 0.2s ease'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#374151'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#6b7280'; }}
          >
            {copiedSummary ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            )}
          </button>
        </div>
      </div>

      <div className="summary-content summary-scrollable" style={{ fontSize: '14px', lineHeight: '1.7', color: summary === 'No summary available' ? '#6b7280' : '#374151' }} dangerouslySetInnerHTML={{ __html: formatSummary(summary) }} />

      {isFullScreen && (
        <div
          className="summary-fullscreen-overlay"
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: '#fff',
            zIndex: 10000,
            display: 'flex',
            flexDirection: 'column',
            padding: '20px',
            boxSizing: 'border-box'
          }}
        >
          <div className="summary-fullscreen-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '16px', fontWeight: 600 }}>Summary</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="copy-summary-btn"
                onClick={handleCopySummary}
                title="Copy summary"
                style={{ background: 'transparent', border: 'none', padding: '6px', color: '#111827', cursor: 'pointer' }}
              >
                {copiedSummary ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                )}
              </button>
              <button className="summary-fullscreen-close" onClick={() => setIsFullScreen(false)} aria-label="Close summary full screen" style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>
          </div>

          <div style={{ flex: '1 1 auto', overflowY: 'auto' }} className="summary-scrollable" dangerouslySetInnerHTML={{ __html: formatSummary(summary) }} />
        </div>
      )}
    </div>
  );
}

