import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import Script from 'next/script';
import Head from 'next/head';
import KeywordsWidget from '@/components/widgets/KeywordsWidget';
import SummaryWidget from '@/components/widgets/SummaryWidget';
import TalkTimeWidget from '@/components/widgets/TalkTimeWidget';
import TranscriptWidget from '@/components/widgets/TranscriptWidget';
import FloatingActionButtons from '@/components/widgets/FloatingActionButtons';
import VideoController from '@/components/widgets/VideoController';

interface BotData {
  id: string;
  title?: string;
  createdAt: string;
  duration?: string;
  videoUrl?: string;
  s3VideoUrl?: string;
  status?: string; // e.g. 'processing' | 'ready'
  keywords?: string[] | { [key: string]: number };
  metrics?: any;
}

interface ShareData {
  success: boolean;
  bot: BotData;
  apiTranscript: any[];
  summary: string;
  error?: string;
}

interface TranscriptItem {
  startOffset: number;
  endOffset?: number;
  speaker: string;
  text: string;
  speakingTime?: number;
}

declare global {
  interface Window {
    ProfessionalVideoPlayer: any;
    videoPlayer: any;
    lastSeekTime: number;
    resetAutoSync: () => void;
    checkSyncStatus: () => void;
  }
}

export default function Share() {
  const router = useRouter();
  const { token, id } = router.query;
  
  const [loadingState, setLoadingState] = useState(true);
  const [errorState, setErrorState] = useState(false);
  const [contentState, setContentState] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [botData, setBotData] = useState<BotData | null>(null);
  const [summary, setSummary] = useState('');
  const [transcript, setTranscript] = useState<any[]>([]);
  const [utterances, setUtterances] = useState<TranscriptItem[]>([]);
  const [activeTab, setActiveTab] = useState<'transcript' | 'talktime' | 'keywords'>('transcript');
  const [infoTab, setInfoTab] = useState<'keywords' | 'summary'>('keywords');
  const [mobileTab, setMobileTab] = useState<'notes' | 'transcripts'>('notes');
  const [isMobile, setIsMobile] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [showVideo, setShowVideo] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  
  const videoPlayerRef = useRef<any>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const bottomProgressRef = useRef<HTMLInputElement>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const leftColumnRef = useRef<HTMLDivElement>(null);
  const talktimeContainerRef = useRef<HTMLDivElement>(null);
  const videoHasStartedRef = useRef<boolean>(false);
  const [highlightedItem, setHighlightedItem] = useState<HTMLElement | null>(null);
  const [lastSeekTime, setLastSeekTime] = useState(0);
  const [isUserSeeking, setIsUserSeeking] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const isUserScrollingRef = useRef<boolean>(false); // Ref for immediate synchronous checks
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [showFloatingButtons, setShowFloatingButtons] = useState(false);
  const [fabPosition, setFabPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const fabRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);
  const openSavedPositionRef = useRef<{ x: number; y: number } | null>(null);
  const draggedSinceOpenRef = useRef(false);

  // Initialize FAB position on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setFabPosition({ x: window.innerWidth - 100, y: window.innerHeight - 200 });
    }
  }, []);

  // Handle click outside to hide buttons
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (fabRef.current && !fabRef.current.contains(event.target as Node)) {
        // Use toggle to ensure position is restored if needed
        if (showFloatingButtons) {
          // closing via outside click
          if (!draggedSinceOpenRef.current && openSavedPositionRef.current) {
            setFabPosition(openSavedPositionRef.current);
          }
          openSavedPositionRef.current = null;
          draggedSinceOpenRef.current = false;
          setShowFloatingButtons(false);
        }
      }
    };

    if (showFloatingButtons) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showFloatingButtons]);

  // Handle drag
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (fabRef.current) {
      const rect = fabRef.current.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      hasDraggedRef.current = false;
      setIsDragging(true);
    }
  };

  // No adjustment needed - allow buttons to extend beyond screen freely
  // Only circle button position is constrained

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const moveDistance = Math.sqrt(
          Math.pow(e.clientX - dragStartPos.current.x, 2) + 
          Math.pow(e.clientY - dragStartPos.current.y, 2)
        );
        if (moveDistance > 5) {
          hasDraggedRef.current = true;
          if (showFloatingButtons) {
            draggedSinceOpenRef.current = true;
          }
        }
        // Allow free movement but keep within screen bounds
        const circleButtonSize = 56;
        const padding = 20;
        let newX = e.clientX - dragOffset.x;
        let newY = e.clientY - dragOffset.y;
        
        // Constrain to screen bounds
        if (typeof window !== 'undefined') {
          newX = Math.max(padding, Math.min(window.innerWidth - circleButtonSize - padding, newX));
          newY = Math.max(padding, Math.min(window.innerHeight - circleButtonSize - padding, newY));
        }
        
        setFabPosition({ x: newX, y: newY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      // Reset after a short delay to allow onClick to check
      setTimeout(() => {
        hasDraggedRef.current = false;
      }, 100);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
}, [isDragging, dragOffset]);

  // Toggle function for page-local FAB to save/restore position
  const toggleFloatingButtonsPage = useCallback(() => {
    if (!showFloatingButtons) {
      openSavedPositionRef.current = { ...fabPosition };
      draggedSinceOpenRef.current = false;
      setShowFloatingButtons(true);
    } else {
      setShowFloatingButtons(false);
      if (!draggedSinceOpenRef.current && openSavedPositionRef.current) {
        setFabPosition(openSavedPositionRef.current);
      }
      openSavedPositionRef.current = null;
      draggedSinceOpenRef.current = false;
    }
  }, [showFloatingButtons, fabPosition]);

  // Only constrain circle button to stay on screen, buttons can extend beyond freely
  useEffect(() => {
    if (typeof window !== 'undefined' && !isDragging) {
      const circleButtonSize = 56;
      const padding = 20;
      
      let constrainedX = fabPosition.x;
      let constrainedY = fabPosition.y;
      
      // Only keep circle button within bounds - buttons can overflow freely
      constrainedX = Math.max(padding, Math.min(window.innerWidth - circleButtonSize - padding, constrainedX));
      constrainedY = Math.max(padding, Math.min(window.innerHeight - circleButtonSize - padding, constrainedY));
      
      if (constrainedX !== fabPosition.x || constrainedY !== fabPosition.y) {
        setFabPosition({ x: constrainedX, y: constrainedY });
      }
    }
  }, [fabPosition, isDragging]);

  // Detect mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768); // 768px breakpoint
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    // Wait for router to be ready before checking for token
    if (!router.isReady) return;
    
    const shareToken = (token || id) as string;
    if (shareToken) {
      loadMeeting(shareToken);
    } else {
      showError('No share token provided');
    }
  }, [router.isReady, token, id]);

  // If backend reports processing, poll the share endpoint periodically until ready
  useEffect(() => {
    let pollTimer: NodeJS.Timeout | null = null;
    if (botData && botData.status === 'processing' && router.isReady) {
      const shareToken = (token || id) as string;
      const poll = async () => {
        try {
          await loadMeeting(shareToken);
        } catch (e) {}
      };
      // Poll every 10 seconds
      pollTimer = setInterval(poll, 10000);
    }
    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [botData?.status, router.isReady, token, id]);

  // Track user manual scrolling in transcript container
  // Auto-scroll will be disabled when user manually scrolls, and only re-enabled when:
  // 1. User clicks on a transcript item (handleTranscriptClick)
  // 2. User seeks using video controller (onTimeChange)
  useEffect(() => {
    let lastScrollTop = 0;
    let programmaticScrollTimeout: NodeJS.Timeout | null = null;
    let isProgrammaticScroll = false;
    let scrollVelocity = 0;
    let lastScrollTime = 0;
    
    const handleScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      const currentScrollTop = target.scrollTop;
      const scrollDiff = currentScrollTop - lastScrollTop;
      const now = Date.now();
      const timeDiff = now - lastScrollTime;
      
      // Calculate scroll velocity (pixels per millisecond)
      if (timeDiff > 0) {
        scrollVelocity = Math.abs(scrollDiff) / timeDiff;
      }
      
      // Detect programmatic scroll: very fast, large jumps, or smooth behavior
      // Programmatic scrolls typically have high velocity (>5px/ms) or are very large (>200px)
      const isLikelyProgrammatic = Math.abs(scrollDiff) > 200 || scrollVelocity > 5;
      
      if (isLikelyProgrammatic && !isProgrammaticScroll) {
        // Mark as programmatic and set a flag
        isProgrammaticScroll = true;
        if (programmaticScrollTimeout) {
          clearTimeout(programmaticScrollTimeout);
        }
        // Reset programmatic flag after scroll completes
        programmaticScrollTimeout = setTimeout(() => {
          isProgrammaticScroll = false;
        }, 300);
        lastScrollTop = currentScrollTop;
        lastScrollTime = now;
        return;
      }
      
      // If it's not programmatic, it's user scrolling
      if (!isProgrammaticScroll && Math.abs(scrollDiff) > 0) {
        // Immediately disable auto-scroll using ref (synchronous)
        isUserScrollingRef.current = true;
        setIsUserScrolling(true);
        
        // Clear any existing timeout
        if (userScrollTimeoutRef.current) {
          clearTimeout(userScrollTimeoutRef.current);
          userScrollTimeoutRef.current = null;
        }
      }
      
      lastScrollTop = currentScrollTop;
      lastScrollTime = now;
    };

    // Detect user interaction events to immediately disable auto-scroll
    const handleUserInteraction = () => {
      isUserScrollingRef.current = true;
      setIsUserScrolling(true);
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
        userScrollTimeoutRef.current = null;
      }
    };

    // Find transcript scrollable container
    const transcriptContainer = document.querySelector('.transcript-scrollable');
    if (transcriptContainer) {
      lastScrollTop = transcriptContainer.scrollTop;
      lastScrollTime = Date.now();
      
      // Use capture phase to catch events earlier
      transcriptContainer.addEventListener('scroll', handleScroll, { passive: true, capture: true });
      transcriptContainer.addEventListener('touchstart', handleUserInteraction, { passive: true });
      transcriptContainer.addEventListener('touchmove', handleUserInteraction, { passive: true });
      transcriptContainer.addEventListener('wheel', handleUserInteraction, { passive: true });
      transcriptContainer.addEventListener('mousedown', handleUserInteraction);
      
      return () => {
        transcriptContainer.removeEventListener('scroll', handleScroll, { capture: true });
        transcriptContainer.removeEventListener('touchstart', handleUserInteraction);
        transcriptContainer.removeEventListener('touchmove', handleUserInteraction);
        transcriptContainer.removeEventListener('wheel', handleUserInteraction);
        transcriptContainer.removeEventListener('mousedown', handleUserInteraction);
        if (userScrollTimeoutRef.current) {
          clearTimeout(userScrollTimeoutRef.current);
        }
        if (programmaticScrollTimeout) {
          clearTimeout(programmaticScrollTimeout);
        }
      };
    }
  }, [botData]); // Re-run when botData changes (transcript loads)

  // Check if script is already loaded
  useEffect(() => {
    if (typeof window !== 'undefined' && window.ProfessionalVideoPlayer && !scriptLoaded) {
      setScriptLoaded(true);
    }
  }, []);

  // Initialize video player when both botData and script are ready
  // Initialize even when video is hidden to allow audio-only playback
  // Reinitialize when switching between mobile/desktop or tabs
  useEffect(() => {
    const checkAndInitialize = () => {
      if (typeof window !== 'undefined' && botData && window.ProfessionalVideoPlayer && videoContainerRef.current) {
        // If the backend indicates video is still processing, don't initialize the player yet
        if (botData.status === 'processing') {
          // leave a placeholder - UI will show processing spinner
          return;
        }
        // Check if player element exists in current container
        const currentContainer = videoContainerRef.current;
        const playerElement = currentContainer.querySelector('#professionalVideoPlayer');
        
        // If no player element exists in current container, initialize
        if (!playerElement) {
          // Destroy existing player if it exists (might be in different container)
          if (videoPlayerRef.current && typeof videoPlayerRef.current.destroy === 'function') {
            try {
              videoPlayerRef.current.destroy();
            } catch (e) {
              console.warn('Error destroying old video player:', e);
            }
            videoPlayerRef.current = null;
          }
          initializeVideoPlayer();
        }
      }
    };

    // Try to initialize immediately
    checkAndInitialize();

    // Also try after delays in case script is still loading or container changed
    const timer1 = setTimeout(checkAndInitialize, 300);
    const timer2 = setTimeout(checkAndInitialize, 600);
    
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [botData, scriptLoaded, isMobile, mobileTab]);

  // Don't clean up video player when hiding - keep it for audio playback
  // The video element will be hidden but audio will continue

  // Set initial duration from botData
  useEffect(() => {
    if (botData) {
      if (botData.metrics && botData.metrics.duration && botData.metrics.duration.totalSeconds) {
        setDuration(botData.metrics.duration.totalSeconds);
      } else if (botData.metrics && botData.metrics.duration) {
        // Try to parse duration string if it's not in totalSeconds format
        const durationStr = botData.metrics.duration;
        if (typeof durationStr === 'string') {
          const parts = durationStr.split(':');
          if (parts.length === 3) {
            const hours = parseInt(parts[0]) || 0;
            const minutes = parseInt(parts[1]) || 0;
            const seconds = parseInt(parts[2]) || 0;
            setDuration(hours * 3600 + minutes * 60 + seconds);
          } else if (parts.length === 2) {
            const minutes = parseInt(parts[0]) || 0;
            const seconds = parseInt(parts[1]) || 0;
            setDuration(minutes * 60 + seconds);
          }
        }
      } else if (botData.duration) {
        // Try to parse duration string from botData.duration (e.g., "16:46")
        const parts = botData.duration.split(':');
        if (parts.length === 2) {
          const minutes = parseInt(parts[0]) || 0;
          const seconds = parseInt(parts[1]) || 0;
          setDuration(minutes * 60 + seconds);
        }
      }
    }
  }, [botData]);


  const loadMeeting = async (shareToken: string) => {
    try {
      // Use relative URL - Next.js will proxy to backend
      const response = await fetch(`/api/share/${encodeURIComponent(shareToken)}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Meeting not found or link expired');
        } else if (response.status === 403) {
          throw new Error('Access denied');
        } else {
          throw new Error('Failed to load meeting');
        }
      }

      const data: ShareData = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load meeting');
      }

      console.log('Share page - Loaded data:', {
        bot: data.bot,
        hasApiTranscript: !!data.apiTranscript,
        apiTranscriptLength: data.apiTranscript?.length || 0,
        hasMetrics: !!data.bot.metrics,
        hasSummary: !!data.summary
      });

      setBotData(data.bot);
      setSummary(data.summary || 'No summary available');
      setTranscript(data.apiTranscript || []);
      
      // Build utterances
      const meetingStartTime = data.bot.metrics?.duration?.startTime || data.bot.createdAt;
      const builtUtterances = buildUtterances(data.apiTranscript || [], meetingStartTime);
      console.log('Share page - Built utterances:', {
        count: builtUtterances.length,
        sample: builtUtterances.slice(0, 3)
      });
      setUtterances(builtUtterances);
      
      setLoadingState(false);
      setContentState(true);
    } catch (error: any) {
      console.error('Error loading meeting:', error);
      showError(error.message);
    }
  };

  const buildUtterances = (captions: any[], meetingStartTime: string | null = null): TranscriptItem[] => {
    if (!Array.isArray(captions) || captions.length === 0) {
      return [];
    }

    const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    const utterances: TranscriptItem[] = [];
    let current: any = null;
    
    let meetingStartTimeMs: number | null = null;
    if (meetingStartTime) {
      try {
        meetingStartTimeMs = new Date(meetingStartTime).getTime();
      } catch (e) {
        console.warn('Failed to parse meeting start time:', meetingStartTime);
      }
    }
    
    if (!meetingStartTimeMs) {
      for (const cap of sorted) {
        if (cap.timestampMs) {
          if (!meetingStartTimeMs || cap.timestampMs < meetingStartTimeMs) {
            meetingStartTimeMs = cap.timestampMs;
          }
        }
      }
    }

    for (const cap of sorted) {
      const speaker = (cap.personName || cap.speaker || 'Unknown Speaker').trim();
      const text = String(cap.personTranscript || cap.text || '').trim();
      
      let startTimeSeconds = 0;
      if (cap.timestampMs && meetingStartTimeMs) {
        startTimeSeconds = (cap.timestampMs - meetingStartTimeMs) / 1000;
      } else {
        startTimeSeconds = Number.isFinite(cap.offsetSeconds) ? cap.offsetSeconds : 0;
      }

      if (!text) continue;

      if (!current) {
        current = { speaker, startOffset: startTimeSeconds, text, lastText: text, lastOffset: startTimeSeconds };
        continue;
      }

      const sameSpeaker = speaker === current.speaker;
      const gapSeconds = startTimeSeconds - current.lastOffset;

      if (sameSpeaker && gapSeconds <= 5) {
        if (text.length >= current.lastText.length && text.startsWith(current.lastText.slice(0, 10))) {
          current.text = text;
          current.lastText = text;
          current.lastOffset = startTimeSeconds;
        } else {
          current.text = `${current.text} ${text}`;
          current.lastText = current.text;
          current.lastOffset = startTimeSeconds;
        }
      } else {
        utterances.push({
          speaker: current.speaker,
          startOffset: current.startOffset,
          text: current.text,
        });
        current = { speaker, startOffset: startTimeSeconds, text, lastText: text, lastOffset: startTimeSeconds };
      }
    }

    if (current) {
      utterances.push({
        speaker: current.speaker,
        startOffset: current.startOffset,
        text: current.text,
      });
    }

    // Calculate speaking time for each utterance
    return utterances.map((utt, index) => {
      const nextUtt = utterances.find((u, i) => i > index && u.startOffset > utt.startOffset);
      const endTime = nextUtt ? nextUtt.startOffset : (utt.startOffset + 3);
      return {
        ...utt,
        speakingTime: Math.max(0, endTime - utt.startOffset),
        endOffset: endTime
      };
    });
  };

  const initializeVideoPlayer = () => {
    if (typeof window === 'undefined' || !botData || !videoContainerRef.current || !window.ProfessionalVideoPlayer) return;

    try {
      let videoUrl: string;
      if (botData.s3VideoUrl) {
        videoUrl = botData.s3VideoUrl;
      } else if (botData.videoUrl && botData.videoUrl.includes('s3.amazonaws.com')) {
        videoUrl = botData.videoUrl;
      } else if (botData.videoUrl) {
        videoUrl = botData.videoUrl;
      } else {
        // Use relative URL - Next.js will proxy to backend
        videoUrl = `/v1/recordings/${encodeURIComponent(botData.id)}`;
      }

      // Get initial duration from botData (already set in useEffect, but keep for video player initialization)
      let videoDuration = 0;
      if (botData.metrics && botData.metrics.duration && botData.metrics.duration.totalSeconds) {
        videoDuration = botData.metrics.duration.totalSeconds;
      } else if (botData.metrics && botData.metrics.duration) {
        // Try to parse duration string if it's not in totalSeconds format
        const durationStr = botData.metrics.duration;
        if (typeof durationStr === 'string') {
          const parts = durationStr.split(':');
          if (parts.length === 3) {
            const hours = parseInt(parts[0]) || 0;
            const minutes = parseInt(parts[1]) || 0;
            const seconds = parseInt(parts[2]) || 0;
            videoDuration = hours * 3600 + minutes * 60 + seconds;
          } else if (parts.length === 2) {
            const minutes = parseInt(parts[0]) || 0;
            const seconds = parseInt(parts[1]) || 0;
            videoDuration = minutes * 60 + seconds;
          }
        }
      } else if (botData.duration) {
        // Try to parse duration string from botData.duration (e.g., "16:46")
        const parts = botData.duration.split(':');
        if (parts.length === 2) {
          const minutes = parseInt(parts[0]) || 0;
          const seconds = parseInt(parts[1]) || 0;
          videoDuration = minutes * 60 + seconds;
        }
      }

      // Clear container and ensure it's ready
      if (!videoContainerRef.current) {
        console.warn('Video container ref is null');
        return;
      }
      
      videoContainerRef.current.innerHTML = '';
      const playerDiv = document.createElement('div');
      playerDiv.id = 'professionalVideoPlayer';
      videoContainerRef.current.appendChild(playerDiv);
      
      let lastHighlight = 0;
      const HIGHLIGHT_INTERVAL = 0.1;

      videoHasStartedRef.current = false;
      videoPlayerRef.current = new window.ProfessionalVideoPlayer('professionalVideoPlayer', videoUrl, {
        transcript: utterances,
        duration: videoDuration,
          onTimeUpdate: (currentTime: number) => {
            if (typeof window !== 'undefined') {
              if (isUserSeeking && Date.now() - (window.lastSeekTime || 0) < 2000) {
                return;
              }
              if (isUserSeeking && Date.now() - (window.lastSeekTime || 0) >= 2000) {
                setIsUserSeeking(false);
              }
            }
          if (Math.abs(currentTime - lastHighlight) > HIGHLIGHT_INTERVAL) {
            lastHighlight = currentTime;
            highlightCurrentTranscript(currentTime);
          }
          // Update bottom controller - only update if video has started playing or user has interacted
          if (videoPlayerRef.current && videoPlayerRef.current.video) {
            const video = videoPlayerRef.current.video;
            // Only update currentTime if video is playing or has been started
            // Don't update to 0 when video first loads
            if (videoHasStartedRef.current || !video.paused) {
              // Only update if currentTime > 0 OR video is playing (to allow seeking to 0)
              if (currentTime > 0 || !video.paused) {
                setCurrentTime(currentTime);
              }
            } else if (currentTime > 0) {
              // If video hasn't started but currentTime > 0, update it (user might have seeked)
              setCurrentTime(currentTime);
              videoHasStartedRef.current = true;
            }
            // Always update these
            // Only update duration if video is fully loaded and has valid duration
            // Don't reset duration to 0 - keep existing duration until video is ready
            if (video.duration && video.duration > 0 && isFinite(video.duration) && video.readyState >= 2) {
              setDuration(video.duration);
            }
            setIsPlaying(!video.paused);
            setPlaybackRate(video.playbackRate || 1);
          }
        }
      });
      
      // Sync with video element
      if (videoPlayerRef.current && videoPlayerRef.current.video) {
        const video = videoPlayerRef.current.video;
        video.addEventListener('play', () => setIsPlaying(true));
        video.addEventListener('pause', () => setIsPlaying(false));
        
        // Update duration only when video is fully loaded with valid duration
        // Don't update on loadedmetadata as duration might be 0 initially
        const updateDurationIfValid = () => {
          if (video.duration && video.duration > 0 && isFinite(video.duration)) {
            setDuration(video.duration);
          }
        };
        
        // Update duration when video data is fully loaded
        video.addEventListener('loadeddata', updateDurationIfValid);
        // Update duration when video can play through (fully loaded)
        video.addEventListener('canplaythrough', updateDurationIfValid);
        // Update duration when video is ready to play
        video.addEventListener('canplay', updateDurationIfValid);
        
        // Check if video is already loaded
        if (video.readyState >= 2 && video.duration > 0 && isFinite(video.duration)) {
          setDuration(video.duration);
        }
        
        // Track when video actually starts playing to prevent auto-seek to 0
        video.addEventListener('play', () => {
          videoHasStartedRef.current = true;
          // When video starts playing, update currentTime
          setCurrentTime(video.currentTime);
        });
        // Also track when user seeks (even if paused)
        video.addEventListener('seeking', () => {
          videoHasStartedRef.current = true;
          setCurrentTime(video.currentTime);
        });
      }

      if (typeof window !== 'undefined') {
        window.videoPlayer = videoPlayerRef.current;
      }
    } catch (error) {
      console.error('Error initializing video player:', error);
      if (videoContainerRef.current) {
        videoContainerRef.current.innerHTML = '<div class="empty-state"><p style="color: #dc2626;">Video player failed to load</p></div>';
      }
    }
  };

  const highlightCurrentTranscript = (currentTime: number) => {
    // Use document.querySelectorAll to find all transcript items (they're in TranscriptWidget)
    const items = document.querySelectorAll('.transcript-item');
    if (!items.length) return;

    const seekAge = Date.now() - (lastSeekTime || 0);
    if (isUserSeeking && seekAge < 2000) {
      return;
    }

    // After the grace period, automatically re-enable auto-highlighting
    if (isUserSeeking && seekAge >= 2000) {
      setIsUserSeeking(false);
    }

    let currentItem: Element | null = null;

    // Find the item that contains the current time (within start and end time)
    items.forEach((item) => {
      const startTime = parseFloat(item.getAttribute('data-start-time') || '0');
      const endTime = parseFloat(item.getAttribute('data-end-time') || String(startTime + 3));

      if (currentTime >= startTime && currentTime < endTime) {
        currentItem = item;
      }
    });

    // If no exact match found, find the closest previous item
    if (!currentItem) {
      let closestItem: Element | null = null;
      let closestTime = -1;

      items.forEach((item) => {
        const startTime = parseFloat(item.getAttribute('data-start-time') || '0');
        if (startTime <= currentTime && startTime > closestTime) {
          closestTime = startTime;
          closestItem = item;
        }
      });

      currentItem = closestItem;
    }

    // Update highlighting (always update the red color)
    if (currentItem && currentItem !== highlightedItem) {
      items.forEach(item => (item as HTMLElement).classList.remove('active'));
      (currentItem as HTMLElement).classList.add('active');
      setHighlightedItem(currentItem as HTMLElement);

      // Auto-scroll disabled - user can manually scroll without interference
      // if (!isUserSeeking && !isUserScrollingRef.current) {
      //   const transcriptContainer = document.querySelector('.transcript-scrollable');
      //   if (transcriptContainer) {
      //     const itemRect = (currentItem as HTMLElement).getBoundingClientRect();
      //     const containerRect = transcriptContainer.getBoundingClientRect();
      //     
      //     // Only scroll if item is significantly outside viewport (with some margin)
      //     const margin = 50; // pixels
      //     const isAboveViewport = itemRect.bottom < (containerRect.top + margin);
      //     const isBelowViewport = itemRect.top > (containerRect.bottom - margin);
      //     
      //     if (isAboveViewport || isBelowViewport) {
      //       // Use scrollIntoView with a flag to mark it as programmatic
      //       (currentItem as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      //     }
      //   }
      // }
    } else if (currentItem && !(currentItem as HTMLElement).classList.contains('active')) {
      // Ensure active class is applied even if it's the same item
      items.forEach(item => (item as HTMLElement).classList.remove('active'));
      (currentItem as HTMLElement).classList.add('active');
    }
  };

  const handleTranscriptClick = (startTime: number) => {
    if (typeof window === 'undefined' || !videoPlayerRef.current) return;

    setIsUserSeeking(true);
    setLastSeekTime(Date.now());
    if (typeof window !== 'undefined') {
      window.lastSeekTime = Date.now();
    }

    // Re-enable auto-scroll when user clicks on transcript (they want to follow along)
    isUserScrollingRef.current = false;
    setIsUserScrolling(false);

    // Find and highlight the clicked transcript item immediately
    const items = document.querySelectorAll('.transcript-item');
    items.forEach((item) => {
      const htmlItem = item as HTMLElement;
      const itemStartTime = parseFloat(htmlItem.getAttribute('data-start-time') || '0');
      if (Math.abs(itemStartTime - startTime) < 0.5) {
        items.forEach(i => (i as HTMLElement).classList.remove('active'));
        htmlItem.classList.add('active');
        setHighlightedItem(htmlItem);
        // Scroll to the clicked item
        htmlItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    const video = videoPlayerRef.current.video;
    if (!video) return;

    video.pause();
    // Guard against non-finite startTime values
    const safeStart = Number.isFinite(startTime) ? Math.max(0, startTime) : 0;
    try {
      const dur = video.duration || duration || 0;
      const clampedStart = dur > 0 ? Math.min(safeStart, dur) : safeStart;
      video.currentTime = clampedStart;
    } catch (err) {
      // ignore invalid assignment
    }

    video.addEventListener('seeked', () => {
      video.play().catch(console.error);
    }, { once: true });
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
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


  const handleShareEmail = async () => {
    if (!botData || typeof window === 'undefined') return;
    
    try {
      setEmailSending(true);
      const currentUrl = window.location.href;
      
      // Use relative URL - Next.js will proxy to backend
      const response = await fetch('/api/share-via-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          botId: botData.id,
          shareUrl: currentUrl,
          isPublicShare: true
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        alert('Email sent successfully!');
      } else {
        throw new Error(data.error || 'Failed to send email');
      }
    } catch (error: any) {
      if (error.message.includes('Authentication') || error.message.includes('login')) {
        alert('Please sign in to share via email. You can copy the link instead.');
      } else {
        alert('Failed to send email. Please try copying the link instead.');
      }
    } finally {
      setEmailSending(false);
    }
  };

  const getVideoUrl = () => {
    if (!botData) return '';
    if (botData.s3VideoUrl) return botData.s3VideoUrl;
    if (botData.videoUrl && botData.videoUrl.includes('s3.amazonaws.com')) return botData.videoUrl;
    if (botData.videoUrl) return botData.videoUrl;
    // Use relative URL - Next.js will proxy to backend
    return `/v1/recordings/${encodeURIComponent(botData.id)}`;
  };

  const showError = (message: string) => {
    setLoadingState(false);
    setErrorMessage(message);
    setErrorState(true);
  };

  const uniqueSpeakers = Array.from(new Set(utterances.map(u => u.speaker).filter(Boolean)));
  const filteredUtterances = utterances.filter(item => {
    if (!searchTerm) return true;
    return item.text.toLowerCase().includes(searchTerm.toLowerCase()) ||
           item.speaker.toLowerCase().includes(searchTerm.toLowerCase());
  });
  
  // Get meeting host from metrics
  const meetingHost = botData?.metrics?.participation?.meetingHost || 
                      botData?.metrics?.meetingHost || 
                      null;

  return (
    <>
      <Head>
        <title>Meeting Recording - CXFlow Meeting Bot</title>
        <style dangerouslySetInnerHTML={{ __html: `
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }
          .video-container {
            overflow: visible !important;
          }
          .video-container > #professionalVideoPlayer {
            width: 100% !important;
            display: block !important;
          }
          .video-container > #professionalVideoPlayer .pv-root {
            display: flex !important;
            flex-direction: column !important;
            width: 100% !important;
          }
          .video-container > #professionalVideoPlayer .pv-controls {
            display: flex !important;
            visibility: visible !important;
            opacity: 1 !important;
            flex-wrap: nowrap !important;
            overflow-x: auto !important;
            min-width: 0 !important;
          }
          
          /* Mobile video player sizing */
          @media (max-width: 768px) {
            .video-container-mobile {
              max-width: 100% !important;
              width: 100% !important;
              margin-bottom: -10% !important;
            }
            .video-container-mobile > #professionalVideoPlayer {
              max-width: 100% !important;
              width: 100% !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-root {
              max-width: 100% !important;
              width: 100% !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-video-wrapper {
              padding-bottom: 50% !important; /* Smaller aspect ratio for mobile (2:1 instead of 16:9) */
              max-height: 250px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-video {
              object-fit: contain !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-controls {
              padding: 6px 4px !important;
              gap: 4px !important;
              flex-wrap: nowrap !important;
              overflow-x: auto !important;
              font-size: 12px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-play-toggle {
              font-size: 14px !important;
              padding: 2px 4px !important;
              flex-shrink: 0 !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-time {
              font-size: 10px !important;
              white-space: nowrap !important;
              flex-shrink: 0 !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-progress {
              flex: 1 1 auto !important;
              min-width: 60px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-spacer {
              flex: 0 0 2px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-volume-wrapper {
              flex-shrink: 0 !important;
              gap: 2px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-btn {
              padding: 2px 4px !important;
              font-size: 12px !important;
              flex-shrink: 0 !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-mute-toggle {
              font-size: 12px !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-volume {
              width: 30px !important;
              flex-shrink: 0 !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-speed {
              font-size: 9px !important;
              padding: 2px 4px !important;
              min-width: 30px !important;
              height: 20px !important;
              flex-shrink: 0 !important;
            }
            .video-container-mobile > #professionalVideoPlayer .pv-pip,
            .video-container-mobile > #professionalVideoPlayer .pv-download,
            .video-container-mobile > #professionalVideoPlayer .pv-fullscreen {
              font-size: 12px !important;
              padding: 2px 4px !important;
              flex-shrink: 0 !important;
            }
          }
        `}} />
      </Head>
      
  <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <header style={{ background: '#111827', color: '#fff', padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', flexShrink: 0 }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img 
            src="https://www.cxflow.io/app/images/logo.png" 
            alt="CXFlow Logo" 
              style={{ width: '24px', height: '24px', verticalAlign: 'middle' }}
              suppressHydrationWarning
          />
            CXFlow Meeting Bot
        </h1>
          <div className="subtitle" style={{ fontSize: '13px', color: '#9ca3af', marginTop: '4px' }}>
            Shared Meeting Recording
        </div>
      </header>

        <main style={{ maxWidth: '1500px', margin: '0 auto', padding: '5px 20px 0', width: '100%', boxSizing: 'border-box', overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
          {loadingState && (
            <div className="loading" style={{ textAlign: 'center', padding: '60px 20px' }}>
              <div className="spinner" style={{ width: '50px', height: '50px', border: '4px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px' }}></div>
              <p>Loading meeting...</p>
            </div>
          )}

          {errorState && (
            <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
              <div className="empty-state-icon" style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
              <div className="empty-state-text" style={{ fontSize: '16px', color: '#6b7280' }}>{errorMessage}</div>
          </div>
          )}

          {contentState && botData && (
            <div id="contentState" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* Mobile Tabs */}
              {isMobile && (
                <div style={{ 
                  display: 'flex', 
                  borderBottom: '1px solid #e5e7eb', 
                  flexShrink: 0,
                  background: 'white',
                  position: 'sticky',
                  top: 0,
                  zIndex: 100
                }}>
                  <button
                    onClick={() => setMobileTab('notes')}
                    style={{
                      flex: 1,
                      padding: '12px 20px',
                      border: 'none',
                      background: 'transparent',
                      color: mobileTab === 'notes' ? '#2563eb' : '#6b7280',
                      fontWeight: mobileTab === 'notes' ? 600 : 400,
                      fontSize: '14px',
                      cursor: 'pointer',
                      borderBottom: mobileTab === 'notes' ? '2px solid #2563eb' : '2px solid transparent',
                      transition: 'all 0.2s ease',
                      marginBottom: '-1px'
                    }}
                  >
                    Notes
                  </button>
                  <button
                    onClick={() => setMobileTab('transcripts')}
                    style={{
                      flex: 1,
                      padding: '12px 20px',
                      border: 'none',
                      background: 'transparent',
                      color: mobileTab === 'transcripts' ? '#2563eb' : '#6b7280',
                      fontWeight: mobileTab === 'transcripts' ? 600 : 400,
                      fontSize: '14px',
                      cursor: 'pointer',
                      borderBottom: mobileTab === 'transcripts' ? '2px solid #2563eb' : '2px solid transparent',
                      transition: 'all 0.2s ease',
                      marginBottom: '-1px'
                    }}
                  >
                    Transcripts
                  </button>
                </div>
              )}

              {/* Desktop: Two Column Layout */}
              {!isMobile && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 0, height: '100%', overflow: 'hidden' }}>
                {/* Left Column - Video, Meeting Info, Keywords, Summary */}
                <div ref={leftColumnRef} style={{ borderRight: '1px solid rgb(191, 191, 191)', display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
                      {/* Video Player - Toggleable */}
                      <div 
                        className={`video-wrapper ${showVideo ? '' : 'hidden'}`}
                        style={{ 
                          flexShrink: 0,
                          padding: showVideo ? '5px 5px 0 5px' : '0'
                        }}
                      >
                    <div 
                      ref={videoContainerRef} 
                      className="video-container"
                      style={{
                        display: showVideo ? 'block' : 'none'
                      }}
                    ></div>
                    {botData.status === 'processing' && (
                      <div style={{ position: 'relative', marginTop: '-200px', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ textAlign: 'center' }}>
                          <div className="spinner" style={{ width: '40px', height: '40px', border: '4px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }}></div>
                          <div style={{ fontSize: '16px', color: '#374151', fontWeight: 600 }}>Processing video...</div>
                          <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '6px' }}>We are preparing a seek-friendly MP4. This may take a minute.</div>
                        </div>
                      </div>
                    )}
                    {/* Audio-only indicator when video is hidden */}
                    {!showVideo && videoPlayerRef.current && (
                      <div style={{
                        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                        borderRadius: '12px',
                        padding: '40px 20px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: '200px',
                        color: 'white',
                        textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '48px', marginBottom: '16px' }}>
                          {isPlaying ? '🔊' : '🔇'}
                        </div>
                        <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                          {isPlaying ? 'Audio Playing' : 'Audio Paused'}
                        </div>
                        <div style={{ fontSize: '14px', opacity: 0.9 }}>
                          {formatTime(currentTime)} / {formatTime(duration)}
                        </div>
                        {/* Audio waveform visualization */}
                        <div style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          gap: '4px', 
                          marginTop: '24px',
                          height: '40px'
                        }}>
                          {Array.from({ length: 20 }).map((_, i) => {
                            const isActive = isPlaying && Math.random() > 0.3;
                            return (
                              <div
                                key={i}
                                style={{
                                  width: '3px',
                                  height: isActive ? `${20 + Math.random() * 20}px` : '4px',
                                  background: isActive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                                  borderRadius: '2px',
                                  transition: 'height 0.1s ease',
                                  animationName: isPlaying ? 'pulse' : 'none',
                                  animationDuration: isPlaying ? '0.5s' : '0s',
                                  animationTimingFunction: isPlaying ? 'ease-in-out' : 'linear',
                                  animationIterationCount: isPlaying ? 'infinite' : '1',
                                  animationDelay: isPlaying ? `${i * 0.05}s` : '0s'
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Meeting Info */}
                  <div style={{ padding: '12px 20px', marginTop: '0', transition: 'margin-top 0.5s cubic-bezier(0.4, 0, 0.2, 1)', flexShrink: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                      <h1 style={{ fontSize: '20px', fontWeight: 600, color: '#111827', flex: 1 }}>
                        {((botData as any).metadata?.title || (botData as any).bot_metadata?.title || botData.title) || botData.id}
                      </h1>
                      <button
                        onClick={() => setShowVideo(!showVideo)}
                        className="btn-small"
                        style={{ 
                          background: 'white', 
                          color: '#374151', 
                          border: '1px solid #e5e7eb', 
                          display: 'inline-flex', 
                          alignItems: 'center', 
                          gap: '6px',
                          marginLeft: '12px',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                          transition: 'all 0.2s ease'
                        }}
                      >
                        {showVideo ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 7l-7 5 7 5V7z"/>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 7l-7 5 7 5V7z"/>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                            <line x1="1" y1="1" x2="23" y2="23" strokeWidth="2.5"/>
                          </svg>
                        )}
                        Video
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '10px' : '12px', flexWrap: 'wrap', fontSize: isMobile ? '10px' : '14px', color: '#6b7280'}}>
                       {meetingHost ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px' }}>
                          <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isMobile ? '10px' : '14px', fontWeight: 600, color: '#6b7280' }}>
                            {meetingHost.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontWeight: 500, color: '#111827' }}>{meetingHost}</span>
                        </div>
                        ):(
                          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px' }}>
                            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isMobile ? '10px' : '14px', fontWeight: 600, color: '#6b7280' }}>
                              M
                            </div>
                            <span style={{ color: '#9ca3af', fontSize: isMobile ? '10px' : '12px' }}>Meeting Host</span>
                          </div>
                        )
                      }
                      {meetingHost && <span>•</span>}
                      <span style={{ fontSize: isMobile ? '10px' : undefined }}>{formatDate(botData.createdAt)}</span>
                      <span>•</span>
                      <span style={{ fontSize: isMobile ? '10px' : undefined }}>{botData.duration || 'N/A'}</span>
                    </div>
                  </div>
                    
                  {/* Info Tabs */}
                  <div style={{ 
                    padding: '0 20px 20px 20px', 
                    display: 'flex', 
                    flexDirection: 'column', 
                    flex: 1, 
                    minHeight: 0, 
                    overflow: 'hidden' 
                  }}>
                    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        <div>
                          {/* <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>General Summary</div>
                          </div> */}
                          <SummaryWidget summary={summary} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column - Transcript */}
                <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <TranscriptWidget
                    utterances={utterances}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    searchTerm={searchTerm}
                    onSearchChange={setSearchTerm}
                    onTranscriptClick={handleTranscriptClick}
                    isUserSeeking={isUserSeeking}
                    talkTimeContent={<TalkTimeWidget metrics={botData.metrics} utterances={utterances} />}
                    keywordsContent={<KeywordsWidget keywords={botData.keywords} />}
                  />
                </div>
              </div>
              )}

              {/* Mobile: Show content based on selected tab */}
              {isMobile && (
                <>
                  {mobileTab === 'notes' ? (
                    <div ref={leftColumnRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
                      {/* Video Player - Toggleable */}
                      <div 
                        className={`video-wrapper ${showVideo ? '' : 'hidden'}`}
                        style={{ 
                          flexShrink: 0,
                          padding: showVideo ? '5px 0px 40px 0px' : '0',
                          overflow: 'visible',
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'flex-start'
                        }}
                      >
                        <div 
                          ref={videoContainerRef} 
                          className="video-container video-container-mobile"
                          style={{
                            display: showVideo ? 'block' : 'none',
                            maxWidth: '100%',
                            width: '100%',
                            margin: '0 auto'
                          }}
                        ></div>
                        {botData.status === 'processing' && (
                          <div style={{ marginTop: '8px', minHeight: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ textAlign: 'center' }}>
                              <div className="spinner" style={{ width: '36px', height: '36px', border: '4px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 10px' }}></div>
                              <div style={{ fontSize: '15px', color: '#374151', fontWeight: 600 }}>Processing video...</div>
                              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '6px' }}>Preparing optimized MP4 for fast seeking.</div>
                            </div>
                          </div>
                        )}
                        {/* Audio-only indicator when video is hidden */}
                        {!showVideo && videoPlayerRef.current && (
                          <div style={{
                            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                            borderRadius: '12px',
                            padding: '40px 20px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: '200px',
                            color: 'white',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '48px', marginBottom: '16px' }}>
                              {isPlaying ? '🔊' : '🔇'}
                            </div>
                            <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                              {isPlaying ? 'Audio Playing' : 'Audio Paused'}
                            </div>
                            <div style={{ fontSize: '14px', opacity: 0.9 }}>
                              {formatTime(currentTime)} / {formatTime(duration)}
                            </div>
                            {/* Audio waveform visualization */}
                            <div style={{ 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'center', 
                              gap: '4px', 
                              marginTop: '24px',
                              height: '40px'
                            }}>
                              {Array.from({ length: 20 }).map((_, i) => {
                                const isActive = isPlaying && Math.random() > 0.3;
                                return (
                                  <div
                                    key={i}
                                    style={{
                                      width: '3px',
                                      height: isActive ? `${20 + Math.random() * 20}px` : '4px',
                                      background: isActive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                                      borderRadius: '2px',
                                      transition: 'height 0.1s ease',
                                      animationName: isPlaying ? 'pulse' : 'none',
                                      animationDuration: isPlaying ? '0.5s' : '0s',
                                      animationTimingFunction: isPlaying ? 'ease-in-out' : 'linear',
                                      animationIterationCount: isPlaying ? 'infinite' : '1',
                                      animationDelay: isPlaying ? `${i * 0.05}s` : '0s'
                                    }}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* Meeting Info */}
                      <div style={{ padding: '8px 16px', marginTop: '0', transition: 'margin-top 0.5s cubic-bezier(0.4, 0, 0.2, 1)', flexShrink: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                          <h1 style={{ fontSize: '14px', fontWeight: 600, color: '#111827', flex: 1 }}>
                            {((botData as any).metadata?.title || (botData as any).bot_metadata?.title || botData.title) || botData.id}
                          </h1>
                          <button
                            onClick={() => setShowVideo(!showVideo)}
                            className="btn-small"
                            style={{ 
                              background: 'white', 
                              color: '#374151', 
                              border: '1px solid #e5e7eb', 
                              display: 'inline-flex', 
                              alignItems: 'center', 
                              gap: '6px',
                              marginLeft: '12px',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                              transition: 'all 0.2s ease'
                            }}
                          >
                            {showVideo ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 7l-7 5 7 5V7z"/>
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                              </svg>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 7l-7 5 7 5V7z"/>
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                                <line x1="1" y1="1" x2="23" y2="23" strokeWidth="2.5"/>
                              </svg>
                            )}
                            Video
                          </button>
                        </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '10px' : '12px', flexWrap: 'wrap', fontSize: isMobile ? '10px' : '14px', color: '#6b7280'}}>
                             {meetingHost ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px' }}>
                                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isMobile ? '10px' : '14px', fontWeight: 600, color: '#6b7280' }}>
                                  {meetingHost.charAt(0).toUpperCase()}
                                </div>
                                <span style={{ fontWeight: 500, color: '#111827' }}>{meetingHost}</span>
                              </div>
                              ):(
                                <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px' }}>
                                  <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isMobile ? '10px' : '14px', fontWeight: 600, color: '#6b7280' }}>
                                    M
                                  </div>
                                  <span style={{ color: '#9ca3af', fontSize: isMobile ? '10px' : '12px' }}>Meeting Host</span>
                                </div>
                              )
                            }
                            {meetingHost && <span>•</span>}
                          <span style={{ fontSize: isMobile ? '10px' : undefined }}>{formatDate(botData.createdAt)}</span>
                          <span>•</span>
                          <span style={{ fontSize: isMobile ? '10px' : undefined }}>{botData.duration || 'N/A'}</span>
                        </div>
                      </div>
                        
                      {/* Info Panel (Keywords + Summary together) */}
                      <div style={{ 
                        padding: '0 20px 20px 20px', 
                        display: 'flex', 
                        flexDirection: 'column', 
                        flex: 1, 
                        minHeight: 0, 
                        overflow: 'hidden' 
                      }}>
                        <div style={{flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div>
                              {/* <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827', marginBottom: '8px' }}>General Summary</div> */}
                              <SummaryWidget summary={summary} />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                      <TranscriptWidget
                        utterances={utterances}
                        activeTab={activeTab}
                        onTabChange={setActiveTab}
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                        onTranscriptClick={handleTranscriptClick}
                        isUserSeeking={isUserSeeking}
                        talkTimeContent={<TalkTimeWidget metrics={botData.metrics} utterances={utterances} />}
                        keywordsContent={<KeywordsWidget keywords={botData.keywords} />}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </main>

        {/* Video Controller (replaces footer) - Always visible at bottom */}
        {contentState && botData && (
          <VideoController
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            videoPlayerRef={videoPlayerRef}
            onTimeChange={(newTime) => {
              if (videoPlayerRef.current && videoPlayerRef.current.video) {
                setIsUserSeeking(true);
                setLastSeekTime(Date.now());
                if (typeof window !== 'undefined') {
                  window.lastSeekTime = Date.now();
                }
                // Re-enable auto-scroll when user seeks using video controller
                isUserScrollingRef.current = false;
                setIsUserScrolling(false);
                videoPlayerRef.current.video.currentTime = newTime;
                setCurrentTime(newTime);
                // Update the video player's progress bar to sync with the seek
                if (videoPlayerRef.current._updateProgressFromVideo) {
                  videoPlayerRef.current._updateProgressFromVideo();
                }
                if (videoPlayerRef.current._updateTimeDisplay) {
                  videoPlayerRef.current._updateTimeDisplay();
                }
              }
            }}
            onPlaybackRateChange={(newRate) => {
              if (videoPlayerRef.current && videoPlayerRef.current.video) {
                videoPlayerRef.current.video.playbackRate = newRate;
                setPlaybackRate(newRate);
              }
            }}
            onPlayPause={() => {
              if (videoPlayerRef.current && videoPlayerRef.current.video) {
                if (isPlaying) {
                  videoPlayerRef.current.video.pause();
                } else {
                  videoPlayerRef.current.video.play();
                }
              }
            }}
            onSeekBackward={() => {
              if (videoPlayerRef.current && videoPlayerRef.current.video) {
                videoPlayerRef.current.video.currentTime = Math.max(0, currentTime - 10);
              }
            }}
            onSeekForward={() => {
              if (videoPlayerRef.current && videoPlayerRef.current.video) {
                videoPlayerRef.current.video.currentTime = Math.min(duration, currentTime + 10);
              }
            }}
            onDownload={() => {
              if (videoPlayerRef.current) {
                videoPlayerRef.current.downloadVideo();
              }
            }}
          />
        )}
      </div>

      {/* Floating Action Buttons */}
      {contentState && botData && (
        <FloatingActionButtons
          botId={botData.id}
          getVideoUrl={getVideoUrl}
          onShareEmail={handleShareEmail}
          getShareUrl={() => typeof window !== 'undefined' ? window.location.href : ''}
        />
      )}

      <Script 
        src="/video-player.js" 
        strategy="afterInteractive" 
        onLoad={() => {
          setScriptLoaded(true);
          if (botData && videoContainerRef.current && showVideo && botData.status !== 'processing') {
            initializeVideoPlayer();
          }
        }} 
      />
    </>
  );
}
