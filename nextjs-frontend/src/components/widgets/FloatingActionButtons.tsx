import React, { useState, useEffect, useRef, useCallback } from 'react';

interface FloatingActionButtonsProps {
  botId: string;
  getVideoUrl: () => string;
  onShareEmail: () => void;
  getShareUrl?: () => string; // Optional function to get share URL
}

export default function FloatingActionButtons({
  botId,
  getVideoUrl,
  onShareEmail,
  getShareUrl
}: FloatingActionButtonsProps) {
  // Constants for FAB and menu dimensions
  const CIRCLE_BUTTON_SIZE = 56;
  const BUTTON_WIDTH = 220; // Increased for combined Share button with copy icon
  const BUTTONS_HEIGHT = 280; // 3 buttons (Download, Export PDF, Share via Email)
  const VIEWPORT_PADDING = 20;

  const [showFloatingButtons, setShowFloatingButtons] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [emailAddress, setEmailAddress] = useState('');
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [fabPosition, setFabPosition] = useState(() => {
    // Initialize to bottom-right if window is available
    if (typeof window !== 'undefined') {
      return {
        x: window.innerWidth - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING,
        y: window.innerHeight - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING
      };
    }
    return { x: 0, y: 0 };
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const fabRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);
  // Save position when menu opens so we can restore on close (if user didn't drag)
  const openSavedPositionRef = useRef<{ x: number; y: number } | null>(null);
  // Track whether user dragged while the menu was open
  const draggedSinceOpenRef = useRef(false);

  // Update FAB position on window resize
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const updatePosition = () => {
        const { innerWidth, innerHeight } = window;
        setFabPosition({ 
          x: innerWidth - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING, 
          y: innerHeight - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING 
        });
      };
      
      // Update on resize
      window.addEventListener('resize', updatePosition);
      return () => window.removeEventListener('resize', updatePosition);
    }
  }, []);

  // Handle click outside to hide buttons
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (fabRef.current && !fabRef.current.contains(event.target as Node)) {
        // If menu is open, close and restore previous position if user didn't drag
        if (showFloatingButtons) {
          setShowFloatingButtons(false);
          if (!draggedSinceOpenRef.current && openSavedPositionRef.current) {
            setFabPosition(openSavedPositionRef.current);
          }
          openSavedPositionRef.current = null;
          draggedSinceOpenRef.current = false;
        }
      }
    };

    if (showFloatingButtons) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showFloatingButtons]);

  // Handle drag start (mouse and touch)
  const handleDragStart = (clientX: number, clientY: number) => {
    if (fabRef.current) {
      const rect = fabRef.current.getBoundingClientRect();
      setDragOffset({
        x: clientX - rect.left,
        y: clientY - rect.top
      });
      dragStartPos.current = { x: clientX, y: clientY };
      hasDraggedRef.current = false;
      setIsDragging(true);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    handleDragStart(e.clientX, e.clientY);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    if (touch) {
      handleDragStart(touch.clientX, touch.clientY);
    }
  };

  useEffect(() => {
    const updatePosition = (clientX: number, clientY: number) => {
      const moveDistance = Math.sqrt(
        Math.pow(clientX - dragStartPos.current.x, 2) + 
        Math.pow(clientY - dragStartPos.current.y, 2)
      );
      if (moveDistance > 5) {
        hasDraggedRef.current = true;
        // If menu was open while dragging, record that user dragged while open
        if (showFloatingButtons) {
          draggedSinceOpenRef.current = true;
        }
      }
      
      if (typeof window === 'undefined') return;
      
      const { innerWidth, innerHeight } = window;
      let newX = clientX - dragOffset.x;
      let newY = clientY - dragOffset.y;
      
      // Calculate max bounds based on whether menu is open
      let maxX = innerWidth - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING;
      let maxY = innerHeight - CIRCLE_BUTTON_SIZE - VIEWPORT_PADDING;
      
      if (showFloatingButtons) {
        maxX = innerWidth - BUTTON_WIDTH - VIEWPORT_PADDING;
        maxY = innerHeight - (BUTTONS_HEIGHT + CIRCLE_BUTTON_SIZE) - VIEWPORT_PADDING;
      }
      
      // Constrain to screen bounds
      newX = Math.max(VIEWPORT_PADDING, Math.min(maxX, newX));
      newY = Math.max(VIEWPORT_PADDING, Math.min(maxY, newY));
      
      setFabPosition({ x: newX, y: newY });
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        updatePosition(e.clientX, e.clientY);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isDragging) {
        e.preventDefault();
        const touch = e.touches[0];
        if (touch) {
          updatePosition(touch.clientX, touch.clientY);
        }
      }
    };

    const handleDragEnd = () => {
      setIsDragging(false);
      // Reset after a short delay to allow onClick to check
      setTimeout(() => {
        hasDraggedRef.current = false;
      }, 100);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove, { passive: false });
      document.addEventListener('mouseup', handleDragEnd);
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleDragEnd);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleDragEnd);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, dragOffset, showFloatingButtons]);

  // Toggle function that preserves or restores position
  const toggleFloatingButtons = useCallback(() => {
    if (!showFloatingButtons) {
      // Opening: save current position so we can restore later
      openSavedPositionRef.current = { ...fabPosition };
      draggedSinceOpenRef.current = false;
      setShowFloatingButtons(true);
    } else {
      // Closing: if user did not drag while menu was open, restore saved position
      setShowFloatingButtons(false);
      if (!draggedSinceOpenRef.current && openSavedPositionRef.current) {
        setFabPosition(openSavedPositionRef.current);
      }
      // Reset saved position
      openSavedPositionRef.current = null;
      draggedSinceOpenRef.current = false;
    }
  }, [showFloatingButtons, fabPosition]);

  // Constrain FAB position to stay within viewport bounds
  // When menu is open, account for the full menu dimensions
  // Only constrain when menu is OPEN to prevent position changes when closing
  useEffect(() => {
    if (typeof window === 'undefined' || isDragging || !showFloatingButtons) return;

    const { innerWidth, innerHeight } = window;

    // When the menu is open, reserve space for the extra width/height
    const maxX = innerWidth - BUTTON_WIDTH - VIEWPORT_PADDING;
    const maxY = innerHeight - (BUTTONS_HEIGHT + CIRCLE_BUTTON_SIZE) - VIEWPORT_PADDING;

    const nextX = Math.max(VIEWPORT_PADDING, Math.min(maxX, fabPosition.x));
    const nextY = Math.max(VIEWPORT_PADDING, Math.min(maxY, fabPosition.y));

    if (nextX !== fabPosition.x || nextY !== fabPosition.y) {
      setFabPosition({ x: nextX, y: nextY });
    }
  }, [fabPosition, isDragging, showFloatingButtons]);

  // Handle copy URL
  const handleCopyUrl = async () => {
    const shareUrl = getShareUrl ? getShareUrl() : (typeof window !== 'undefined' ? window.location.href : '');
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = shareUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  // Handle send email
  const handleSendEmail = async () => {
    if (!emailAddress.trim() || isSendingEmail) return;
    
    setIsSendingEmail(true);
    
    try {
      const shareUrl = getShareUrl ? getShareUrl() : (typeof window !== 'undefined' ? window.location.href : '');
      
      // Use relative URL - Next.js will proxy to backend
      const response = await fetch('/api/share-via-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          botId: botId,
          shareUrl: shareUrl,
          email: emailAddress.trim(),
          isPublicShare: true
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setToast({ type: 'success', message: 'Email sent successfully!' });
        setEmailAddress('');
        setTimeout(() => {
          setShowEmailModal(false);
        }, 1500);
      } else {
        throw new Error(data.error || 'Failed to send email');
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to send email. Please try again.';
      setToast({ type: 'error', message: errorMessage });
    } finally {
      setIsSendingEmail(false);
      // Auto-hide toast after 4 seconds
      setTimeout(() => {
        setToast(null);
      }, 4000);
    }
  };

  // Close toast manually
  const closeToast = () => {
    setToast(null);
  };

  // Calculate alignment for buttons (simplified since clamping prevents overflow)
  if (typeof window === 'undefined') {
    return null;
  }

  const isNearRight = fabPosition.x + CIRCLE_BUTTON_SIZE / 2 > window.innerWidth / 2;
  const isNearLeft = fabPosition.x < BUTTON_WIDTH;

  return (
    <>
      <div
        ref={fabRef}
        style={{
          position: 'fixed',
          left: `${fabPosition.x}px`,
          top: `${fabPosition.y}px`,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: isNearRight ? 'flex-end' : isNearLeft ? 'flex-start' : 'center',
          gap: '12px',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none'
        }}
      >
        {/* Action Buttons */}
        {showFloatingButtons && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              animation: 'fadeIn 0.2s ease-in',
              alignItems: 'stretch',
              transform: 'translate(0px, 0px)',
              transition: 'transform 0.2s ease'
            }}
          >
            <a
              href={getVideoUrl()}
              download={`meeting-${botId}.webm`}
              style={{
                background: 'white',
                color: '#2563eb',
                border: '1px solid #2563eb',
                borderRadius: '8px',
                padding: '12px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: 500,
                boxShadow: 'none',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap',
                width: '100%',
                justifyContent: 'center'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.9';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
              </svg>
              Download Video
            </a>
            <a
              href={`/v1/bots/${encodeURIComponent(botId)}/export/pdf`}
              download={`meeting-transcript-${botId}.pdf`}
              style={{
                background: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                padding: '12px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: 500,
                boxShadow: 'none',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap',
                width: '100%',
                justifyContent: 'center'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.9';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
              </svg>
              Export PDF
            </a>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0', width: '100%' }}>
              <button
                onClick={() => setShowEmailModal(true)}
                style={{
                  background: '#9333ea',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px 0 0 8px',
                  padding: '12px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '14px',
                  fontWeight: 500,
                  boxShadow: 'none',
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  borderRight: '1px solid rgba(255,255,255,0.2)',
                  flex: 1,
                  justifyContent: 'center'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
                Share
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyUrl();
                }}
                title={copiedUrl ? 'Copied!' : 'Copy URL'}
                style={{
                  background: '#9333ea',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0 8px 8px 0',
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: 'none',
                  transition: 'all 0.2s ease',
                  borderLeft: '1px solid rgba(255,255,255,0.2)',
                  flexShrink: 0
                }}
                onMouseEnter={(e) => {
                  if (!copiedUrl) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {copiedUrl ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Circle Toggle Button */}
        <button
          onMouseDown={(e) => {
            handleMouseDown(e);
          }}
          onTouchStart={(e) => {
            handleTouchStart(e);
          }}
          onClick={(e) => {
            e.stopPropagation();
            // Only toggle if user didn't drag
            if (!hasDraggedRef.current) {
              toggleFloatingButtons();
            }
          }}
          onTouchEnd={(e) => {
            e.stopPropagation();
            // Only toggle if user didn't drag (for touch devices)
            if (!hasDraggedRef.current && !isDragging) {
              toggleFloatingButtons();
            }
          }}
          style={{
            width: `${CIRCLE_BUTTON_SIZE}px`,
            height: `${CIRCLE_BUTTON_SIZE}px`,
            borderRadius: '50%',
            background: showFloatingButtons ? '#9333ea' : '#6b7280',
            color: 'white',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            transition: 'all 0.3s ease',
            fontSize: '24px',
            zIndex: 1001
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
            e.currentTarget.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
          }}
        >
          {showFloatingButtons ? '✕' : '☰'}
        </button>
      </div>

      {/* Email Share Modal */}
      {showEmailModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
            animation: 'fadeIn 0.2s ease-in'
          }}
          onClick={() => setShowEmailModal(false)}
        >
          <div
            style={{
              background: 'white',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '500px',
              width: '90%',
              boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
              animation: 'slideUp 0.3s ease-out'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#111827', fontFamily: "'Poppins', sans-serif" }}>
                Share via Email
              </h2>
              <button
                onClick={() => setShowEmailModal(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  color: '#6b7280',
                  padding: '0',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '4px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                ×
              </button>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: '#374151', fontSize: '14px', fontWeight: 500, fontFamily: "'Poppins', sans-serif" }}>
                Email Address
              </label>
              <input
                type="email"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                placeholder="Enter email address"
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  border: '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontFamily: "'Poppins', sans-serif",
                  outline: 'none',
                  transition: 'all 0.2s ease',
                  boxSizing: 'border-box'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#9333ea';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(147,51,234,0.1)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = '#d1d5db';
                  e.currentTarget.style.boxShadow = 'none';
                }}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && emailAddress.trim()) {
                    handleSendEmail();
                  }
                }}
              />
            </div>
            <button
              onClick={handleSendEmail}
              disabled={!emailAddress.trim() || isSendingEmail}
              style={{
                width: '100%',
                background: emailAddress.trim() && !isSendingEmail ? '#10b981' : '#9ca3af',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                padding: '12px 24px',
                fontSize: '14px',
                fontWeight: 500,
                fontFamily: "'Poppins', sans-serif",
                boxShadow: emailAddress.trim() && !isSendingEmail ? '0 4px 12px rgba(16,185,129,0.3)' : 'none',
                transition: 'all 0.2s ease',
                cursor: emailAddress.trim() && !isSendingEmail ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
              onMouseEnter={(e) => {
                if (emailAddress.trim() && !isSendingEmail) {
                  e.currentTarget.style.background = '#059669';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(16,185,129,0.4)';
                }
              }}
              onMouseLeave={(e) => {
                if (emailAddress.trim() && !isSendingEmail) {
                  e.currentTarget.style.background = '#10b981';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(16,185,129,0.3)';
                }
              }}
            >
              {isSendingEmail ? (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  Sending...
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                  </svg>
                  Send
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            background: toast.type === 'success' ? '#10b981' : '#ef4444',
            color: 'white',
            padding: '16px 20px',
            borderRadius: '12px',
            boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            minWidth: '300px',
            maxWidth: '500px',
            animation: 'slideInRight 0.3s ease-out',
            fontFamily: "'Poppins', sans-serif"
          }}
        >
          <div style={{ flexShrink: 0 }}>
            {toast.type === 'success' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            )}
          </div>
          <div style={{ flex: 1, fontSize: '14px', fontWeight: 500, lineHeight: '1.5' }}>
            {toast.message}
          </div>
          <button
            onClick={closeToast}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
              flexShrink: 0,
              opacity: 0.8
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.background = 'rgba(255,255,255,0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0.8';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}} />
    </>
  );
}

