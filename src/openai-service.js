const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');
const { getCurrentTimestamp } = require('./utils/timezone');
const { sendWebhook } = require('./utils/webhook');
const { getCachedFile, invalidateCache } = require('./utils/file-cache');

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ''
});

/**
 * Check if OpenAI is configured
 */
function isConfigured() {
    return !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== '';
}

/**
 * Get meeting type context to enrich AI prompts
 */
function getMeetingTypeContext(meetingType) {
    if (!meetingType) return '';
    
    const meetingTypeMap = {
        'hr-interview': `MEETING CONTEXT: This is an HR Interview meeting. Focus on:
- Candidate qualifications, experience, and skills discussed
- Interview questions and candidate responses
- Assessment of candidate fit for the role
- Next steps in the hiring process (interviews, offers, rejections)
- Salary, benefits, or compensation discussions
- Candidate questions and concerns
- Timeline for hiring decisions
- Reference checks or background verification mentioned
- Team fit and cultural alignment discussions

`,
        'team-meeting': `MEETING CONTEXT: This is a Team Meeting. Focus on:
- Team updates and status reports
- Project progress and milestones
- Collaboration and coordination between team members
- Resource allocation and workload distribution
- Team goals and objectives
- Challenges and blockers the team is facing
- Team dynamics and communication
- Action items for team members
- Upcoming deadlines and priorities

`,
        'client-call': `MEETING CONTEXT: This is a Client Call. Focus on:
- Client requirements and expectations
- Project scope, deliverables, and timelines
- Client feedback and concerns
- Contract terms, pricing, and payment discussions
- Service level agreements (SLAs) and commitments
- Client satisfaction and relationship management
- Follow-up actions and next steps
- Escalation issues or complaints
- Upselling or additional service opportunities

`,
        'training-session': `MEETING CONTEXT: This is a Training Session. Focus on:
- Training topics and learning objectives covered
- Key concepts, procedures, or skills taught
- Questions from trainees and answers provided
- Practical exercises or demonstrations
- Assessment or evaluation criteria
- Resources and materials shared
- Follow-up training or practice needed
- Trainee progress and understanding
- Certification or completion requirements

`,
        'project-review': `MEETING CONTEXT: This is a Project Review meeting. Focus on:
- Project status, milestones, and deliverables
- Budget, timeline, and resource utilization
- Risks, issues, and mitigation strategies
- Stakeholder feedback and approval status
- Change requests and scope modifications
- Quality metrics and performance indicators
- Lessons learned and best practices
- Project dependencies and blockers
- Go-live dates and launch plans

`,
        'sales-call': `MEETING CONTEXT: This is a Sales Call. Focus on:
- Product or service features and benefits discussed
- Customer pain points and needs identified
- Pricing, quotes, and proposal details
- Objections raised and how they were addressed
- Decision-making process and timeline
- Competitive comparisons
- Next steps in the sales cycle
- Contract terms and negotiation points
- Customer commitment level and buying signals

`,
        'standup-meeting': `MEETING CONTEXT: This is a Standup Meeting (daily sync). Focus on:
- What each team member accomplished since last meeting
- What each team member plans to work on today
- Blockers or impediments preventing progress
- Quick status updates and progress indicators
- Dependencies between team members
- Sprint goals and alignment
- Quick decisions or clarifications needed
- Action items for the day

`,
        'brainstorming': `MEETING CONTEXT: This is a Brainstorming Session. Focus on:
- Ideas, concepts, and creative solutions proposed
- Problem statements and challenges being addressed
- Evaluation criteria for ideas
- Pros and cons of different approaches
- Voting or prioritization of ideas
- Action items to research or prototype ideas
- Next steps for idea development
- Resource needs for implementation
- Innovation opportunities identified

`,
        'presentation': `MEETING CONTEXT: This is a Presentation. Focus on:
- Main topics and key messages presented
- Data, statistics, and evidence shared
- Visual aids, slides, or demos shown
- Questions from audience and responses
- Key takeaways and conclusions
- Call-to-action or next steps presented
- Audience engagement and feedback
- Follow-up materials or resources promised
- Presentation effectiveness and impact

`,
        'other': ''
    };
    
    return meetingTypeMap[meetingType] || '';
}

/**
 * Map language code to full language name for prompts
 */
function getLanguageName(langCode) {
    const langMap = {
        'en': 'English',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'pt': 'Portuguese',
        'it': 'Italian',
        'ja': 'Japanese',
        'ko': 'Korean',
        'zh': 'Chinese',
        'hi': 'Hindi',
        'ar': 'Arabic',
        'ru': 'Russian',
        'nl': 'Dutch',
        'pl': 'Polish',
        'tr': 'Turkish',
        'vi': 'Vietnamese',
        'th': 'Thai',
        'id': 'Indonesian',
        'sv': 'Swedish',
        'da': 'Danish',
        'no': 'Norwegian',
        'fi': 'Finnish'
    };
    return langMap[langCode] || 'Spanish'; // Default to Spanish
}

/**
 * Format transcript for better readability
 */
function formatTranscript(captions) {
    if (!Array.isArray(captions) || captions.length === 0) {
        return 'No transcript available.';
    }

    // Sort by timestamp
    const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    
    let formatted = '';
    let lastSpeaker = '';
    
    for (const caption of sorted) {
        const speaker = caption.speaker || 'Unknown Speaker';
        const text = caption.text || '';
        const offsetSeconds = caption.offsetSeconds || 0;
        
        if (!text.trim()) continue;
        
        // Format time as MM:SS
        const minutes = Math.floor(offsetSeconds / 60);
        const seconds = Math.floor(offsetSeconds % 60);
        const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        
        // Only show speaker name if it changed
        if (speaker !== lastSpeaker) {
            if (formatted) formatted += '\n\n';
            formatted += `[${timeStr}] ${speaker}:\n`;
            lastSpeaker = speaker;
        }
        
        formatted += `${text}\n`;
    }
    
    return formatted;
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/**
 * Split transcript into chunks for processing with overlap to preserve context
 */
function chunkTranscript(transcript, maxTokens = 6000, overlapTokens = 500) {
    const lines = transcript.split('\n');
    const chunks = [];
    let currentChunk = '';
    let lastChunkEnd = '';
    
    for (const line of lines) {
        const testChunk = currentChunk + line + '\n';
        if (estimateTokens(testChunk) > maxTokens && currentChunk) {
            // Save current chunk with overlap from previous
            const chunkWithOverlap = lastChunkEnd ? lastChunkEnd + '\n\n--- CONTINUED ---\n\n' + currentChunk.trim() : currentChunk.trim();
            chunks.push(chunkWithOverlap);
            
            // Extract overlap from end of current chunk for next chunk
            const currentLines = currentChunk.split('\n');
            let overlapText = '';
            let overlapTokenCount = 0;
            
            // Get last lines that fit in overlapTokens
            for (let i = currentLines.length - 1; i >= 0 && overlapTokenCount < overlapTokens; i--) {
                const lineToAdd = currentLines[i] + '\n';
                const lineTokens = estimateTokens(lineToAdd);
                if (overlapTokenCount + lineTokens <= overlapTokens) {
                    overlapText = lineToAdd + overlapText;
                    overlapTokenCount += lineTokens;
                } else {
                    break;
                }
            }
            
            lastChunkEnd = overlapText.trim();
            currentChunk = line + '\n';
        } else {
            currentChunk = testChunk;
        }
    }
    
    if (currentChunk.trim()) {
        // Add final chunk with overlap
        const finalChunk = lastChunkEnd ? lastChunkEnd + '\n\n--- CONTINUED ---\n\n' + currentChunk.trim() : currentChunk.trim();
        chunks.push(finalChunk);
    }
    
    return chunks;
}

/**
 * Generate summary for a chunk
 */
async function summarizeChunk(chunk, chunkIndex, totalChunks, language = 'Spanish', customSummaryTemplate = null, meetingType = null) {
    // Build meeting type context for prompt enrichment
    const meetingTypeContext = meetingType ? getMeetingTypeContext(meetingType) : '';
    
    // Use custom template if provided, otherwise use enhanced default
    const systemPrompt = customSummaryTemplate && customSummaryTemplate.trim() 
        ? `${customSummaryTemplate}\n\n${meetingTypeContext}IMPORTANT: This is part ${chunkIndex + 1} of ${totalChunks}. Extract ALL details from this segment. Respond in ${language} language.`
        : `You are an expert meeting analyst with exceptional attention to detail. Analyze the following meeting transcript segment (part ${chunkIndex + 1} of ${totalChunks}) and extract EVERY important detail with 100% accuracy.

${meetingTypeContext}

CRITICAL REQUIREMENTS:
- Extract ALL discussion points, no matter how minor they seem
- Capture EVERY decision made, including who made it and when
- List ALL action items with exact owners, tasks, and deadlines (preserve exact dates/times mentioned)
- Note ALL concerns, risks, blockers, or uncertainties mentioned
- Preserve exact names, numbers, dates, and technical terms exactly as stated
- Include ALL commitments and promises made by participants
- Capture ALL questions asked and answers given
- Note ALL agreements and disagreements
- Preserve context and relationships between topics

Format your analysis clearly with:
1. Key Discussion Points (ALL points, not just top ones)
2. Decisions Made (EVERY decision with context)
3. Action Items (COMPLETE list with Who/What/When)
4. Concerns & Risks (ALL mentioned)
5. Important Quotes or Statements (exact wording when critical)
6. Questions & Answers (ALL Q&A pairs)
7. Agreements & Commitments (EVERY commitment)

Be thorough and comprehensive. Do not omit any information. Accuracy is more important than brevity.
IMPORTANT: Respond in ${language} language.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o', // Use gpt-4o for better accuracy
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Analyze this transcript segment in detail:\n\n${chunk}` }
        ],
        temperature: 0.3, // Lower temperature for more deterministic, exact outputs
        max_tokens: 3000 // Increased for comprehensive chunk summaries
    });

    return completion.choices[0].message.content;
}

/**
 * Generate final summary from chunk summaries
 */
async function generateFinalSummary(chunkSummaries, fullTranscript, language = 'Spanish', customSummaryTemplate = null, meetingType = null) {
    const combinedSummaries = chunkSummaries.join('\n\n--- CHUNK SEPARATOR ---\n\n');
    
    // Build meeting type context for prompt enrichment
    const meetingTypeContext = meetingType ? getMeetingTypeContext(meetingType) : '';
    
    // Use custom template if provided, otherwise use default template
    const defaultTemplate = getDefaultSummaryTemplate();
    const systemPrompt = customSummaryTemplate && customSummaryTemplate.trim() 
        ? `${customSummaryTemplate}\n\n${meetingTypeContext}CRITICAL: Ensure 100% accuracy. Include ALL details from all chunks. Do not omit any information. Respond in ${language} language.`
        : `You are an expert meeting analyst creating a comprehensive, 100% accurate executive summary. Your task is to synthesize ALL information from the chunk analyses below into a complete, exact, and detailed summary.

${meetingTypeContext}

${defaultTemplate}

IMPORTANT: Cross-reference information across chunks to ensure nothing is missed. This summary must be complete and exact. Double-check that you have included ALL information from all chunks. Respond in ${language} language.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o', // Use gpt-4o for better accuracy
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Synthesize ALL information from the chunk analyses below into a comprehensive, 100% accurate summary. Ensure nothing is omitted:\n\n${combinedSummaries}\n\n---\n\nAlso reference the full transcript context when needed:\n\n${fullTranscript.slice(0, 5000)}${fullTranscript.length > 5000 ? '\n\n[... transcript continues ...]' : ''}` }
        ],
        temperature: 0.3, // Lower temperature for more deterministic, exact outputs
        max_tokens: 4000 // Increased for comprehensive summaries
    });

    return completion.choices[0].message.content;
}

/**
 * Generate meeting summary using OpenAI
 */
async function generateSummary(captions, languageCode = 'es', customSummaryTemplate = null, meetingType = null) {
    if (!isConfigured()) {
        console.warn('⚠️  OpenAI API key not configured. Skipping AI summary generation.');
        return generateBasicSummary(captions);
    }

    const language = getLanguageName(languageCode);
    console.log(`🌐 Generating summary in ${language}...`);

    try {
        const transcript = formatTranscript(captions);
        
        if (transcript === 'No transcript available.') {
            return transcript;
        }

        const estimatedTokens = estimateTokens(transcript);
        console.log(`🤖 Generating AI summary with OpenAI... (estimated ${estimatedTokens} tokens)`);

        // Token limits by model
        const modelLimits = {
            'gpt-3.5-turbo': 4096,
            'gpt-3.5-turbo-16k': 16384,
            'gpt-4': 8192,
            'gpt-4-turbo': 128000,
            'gpt-4o': 128000,
            'gpt-4o-mini': 128000
        };

        // Use gpt-4o for better accuracy, fallback to gpt-4o-mini if not available
        const defaultModel = 'gpt-4o'; // Better accuracy for exact summaries
        const model = process.env.OPENAI_MODEL || defaultModel;
        const modelLimit = modelLimits[model] || modelLimits[defaultModel] || 4096;
        
        // Reserve tokens for system prompt and response
        const maxInputTokens = modelLimit - 3000;

        if (estimatedTokens > maxInputTokens) {
            console.log(`⚠️  Transcript too long (${estimatedTokens} tokens). Using chunked summarization strategy...`);
            
            // Split transcript into manageable chunks
            // Split transcript into manageable chunks with overlap for context preservation
            const chunks = chunkTranscript(transcript, 6000, 500);
            console.log(`📄 Split transcript into ${chunks.length} chunks`);
            
            // Summarize each chunk
            const chunkSummaries = [];
            for (let i = 0; i < chunks.length; i++) {
                console.log(`   Processing chunk ${i + 1}/${chunks.length}...`);
                const chunkSummary = await summarizeChunk(chunks[i], i, chunks.length, language, customSummaryTemplate, meetingType);
                chunkSummaries.push(chunkSummary);
            }
            
            // Generate final comprehensive summary
            console.log('📝 Generating final comprehensive summary...');
            const finalSummary = await generateFinalSummary(chunkSummaries, transcript, language, customSummaryTemplate, meetingType);
            console.log('✅ AI summary generated successfully (chunked approach)');
            
            return finalSummary;
        } else {
            // Transcript fits in one request
            // Build meeting type context for prompt enrichment
            const meetingTypeContext = meetingType ? getMeetingTypeContext(meetingType) : '';
            
            // Use custom template if provided, otherwise use default template
            const defaultTemplate = getDefaultSummaryTemplate();
            const systemPrompt = customSummaryTemplate && customSummaryTemplate.trim() 
                ? `${customSummaryTemplate}\n\n${meetingTypeContext}CRITICAL: Ensure 100% accuracy. Include ALL details. Do not omit any information. Respond in ${language} language.`
                : `${defaultTemplate}

${meetingTypeContext}

IMPORTANT: This summary must be complete and exact. Double-check that you have included ALL information from the transcript. Respond in ${language} language.`;

            const completion = await openai.chat.completions.create({
                model: model === 'gpt-4o-mini' ? 'gpt-4o' : model, // Use gpt-4o for better accuracy when possible
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Analyze this meeting transcript in detail and create a comprehensive, 100% accurate summary. Ensure nothing is omitted:\n\n${transcript}` }
                ],
                temperature: 0.3, // Lower temperature for more deterministic, exact outputs
                max_tokens: 4000 // Increased for comprehensive summaries
            });

            const summary = completion.choices[0].message.content;
            console.log('✅ AI summary generated successfully');
            
            return summary;
        }

    } catch (error) {
        console.error('❌ Error generating OpenAI summary:', error.message);
        try { await sendWebhook('error.occurred', { meeting_id: null, code: 'summary_generation_error', message: error && error.message ? error.message : String(error), details: { botId: null } }); } catch (e) {}
        
        // Fallback to basic summary
        console.log('📝 Falling back to basic summary...');
        return generateBasicSummary(captions);
    }
}

/**
 * Generate basic summary without AI (fallback)
 */
function generateBasicSummary(captions) {
    if (!Array.isArray(captions) || captions.length === 0) {
        return 'No transcript available for this meeting.';
    }

    // Build utterances (grouped by speaker)
    const utterances = buildUtterances(captions);
    
    if (utterances.length === 0) {
        return 'No meaningful content found in the transcript.';
    }

    // Extract participants
    const speakers = {};
    for (const utt of utterances) {
        speakers[utt.speaker] = (speakers[utt.speaker] || 0) + 1;
    }

    const participants = Object.keys(speakers);
    const topSpeakers = Object.entries(speakers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count} contributions)`);

    // Calculate meeting duration
    const lastCaption = captions[captions.length - 1];
    const durationSeconds = lastCaption?.offsetSeconds || 0;
    const durationMinutes = Math.floor(durationSeconds / 60);

    // Get first few topics
    const firstTopics = utterances.slice(0, 5).map(u => 
        `• ${u.speaker}: ${u.text.slice(0, 100)}${u.text.length > 100 ? '...' : ''}`
    );

    // Get last comment
    const lastComment = utterances[utterances.length - 1];

    // Build summary
    let summary = `# Meeting Summary\n\n`;
    summary += `## Overview\n`;
    summary += `Duration: ${durationMinutes} minutes\n`;
    summary += `Total utterances: ${utterances.length}\n`;
    summary += `Participants: ${participants.join(', ')}\n\n`;
    
    summary += `## Most Active Participants\n`;
    summary += topSpeakers.map(s => `• ${s}`).join('\n');
    summary += `\n\n`;
    
    summary += `## Discussion Highlights\n`;
    summary += firstTopics.join('\n');
    summary += `\n\n`;
    
    summary += `## Final Comments\n`;
    summary += `• ${lastComment.speaker}: ${lastComment.text.slice(0, 200)}${lastComment.text.length > 200 ? '...' : ''}`;
    summary += `\n\n`;
    summary += `---\n`;
    summary += `Note: This is a basic summary. For AI-powered summaries, configure OPENAI_API_KEY in your environment.`;

    return summary;
}

/**
 * Build utterances from captions (group by speaker)
 */
function buildUtterances(captions, meetingStartTime = null) {
    if (!Array.isArray(captions) || captions.length === 0) return [];

    const sorted = [...captions].sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    const utterances = [];
    let current = null;
    
    // Use meeting start time if provided, otherwise find the earliest timestampMs
    let meetingStartTimeMs = null;
    if (meetingStartTime) {
        try {
            meetingStartTimeMs = new Date(meetingStartTime).getTime();
        } catch (e) {
            console.warn('Failed to parse meeting start time:', meetingStartTime);
        }
    }
    
    // Fallback: find the earliest timestampMs
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
        
        if (!text) continue;

        // Use timestampMs - meetingStartTimeMs to get the actual speaker start time
        let startOffset = 0;
        if (cap.timestampMs && meetingStartTimeMs) {
            // Calculate seconds from meeting start using timestampMs
            startOffset = (cap.timestampMs - meetingStartTimeMs) / 1000;
        } else {
            // Fallback to offsetSeconds if no timestampMs
            startOffset = Number.isFinite(cap.offsetSeconds) ? cap.offsetSeconds : 0;
        }

        if (!current) {
            current = { speaker, startOffset: startOffset, text, lastText: text, lastOffset: startOffset };
            continue;
        }

        const sameSpeaker = speaker === current.speaker;
        const gapSeconds = startOffset - current.lastOffset;

        if (sameSpeaker && gapSeconds <= 5) {
            // Same speaker, short gap - merge
            if (text.length >= current.lastText.length && text.startsWith(current.lastText.slice(0, 10))) {
                current.text = text;
                current.lastText = text;
                current.lastOffset = startOffset;
            } else {
                current.text = `${current.text} ${text}`;
                current.lastText = current.text;
                current.lastOffset = startOffset;
            }
        } else {
            // Different speaker or long gap - new utterance
            utterances.push({
                speaker: current.speaker,
                startOffset: current.startOffset,
                text: current.text,
            });
            current = { speaker, startOffset: startOffset, text, lastText: text, lastOffset: startOffset };
        }
    }

    if (current) {
        utterances.push({
            speaker: current.speaker,
            startOffset: current.startOffset,
            text: current.text,
        });
    }

    return utterances;
}

/**
 * Save formatted transcript to file
 */
async function saveFormattedTranscript(botId, captions, runtimeRoot) {
    try {
        const botDir = path.join(runtimeRoot, botId);
        const transcriptsDir = path.join(botDir, 'transcripts');
        await fs.ensureDir(transcriptsDir);

        const formattedPath = path.join(transcriptsDir, 'formatted.txt');
        const formatted = formatTranscript(captions);
        
        await fs.writeFile(formattedPath, formatted, 'utf8');
        console.log(`✅ Formatted transcript saved: ${formattedPath}`);
        
        return formattedPath;
    } catch (error) {
        console.error('❌ Error saving formatted transcript:', error);
        throw error;
    }
}

/**
 * Generate keywords from transcript using OpenAI
 */
async function generateKeywords(captions, languageCode = 'es') {
    if (!isConfigured()) {
        console.warn('⚠️  OpenAI API key not configured. Skipping keyword generation.');
        return [];
    }

    const language = getLanguageName(languageCode);
    console.log(`🔑 Generating keywords in ${language}...`);

    try {
        const transcript = formatTranscript(captions);
        
        if (transcript === 'No transcript available.') {
            return [];
        }

        const systemPrompt = `You are an expert at extracting key topics and keywords from meeting transcripts. 
Analyze the following meeting transcript and extract 5-10 relevant keywords that best represent the main topics, themes, and important concepts discussed.

Guidelines:
- Extract keywords that are specific and meaningful (avoid generic words like "meeting", "discussion", "talk")
- Focus on topics, technologies, projects, decisions, or important concepts mentioned
- Keywords should be single words or short phrases (1-3 words max)
- Return ONLY a JSON array of keyword strings, nothing else
- IMPORTANT: Respond in ${language} language if the keywords are in that language, otherwise use English

Example format: ["project timeline", "budget approval", "team collaboration", "deadline", "risk assessment"]`;

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Extract keywords from this transcript:\n\n${transcript}` }
            ],
            temperature: 0.5,
            max_tokens: 200
        });

        const response = completion.choices[0].message.content.trim();
        let keywords = [];
        
        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(response);
            // Handle different possible response formats
            if (Array.isArray(parsed)) {
                keywords = parsed;
            } else if (parsed.keywords && Array.isArray(parsed.keywords)) {
                keywords = parsed.keywords;
            } else if (typeof parsed === 'object') {
                // Try to find any array in the response
                const values = Object.values(parsed);
                keywords = values.find(v => Array.isArray(v)) || [];
            }
        } catch (parseError) {
            // Fallback: try to extract keywords from text response
            // Look for JSON-like array or comma-separated list
            const jsonMatch = response.match(/\[(.*?)\]/);
            if (jsonMatch) {
                try {
                    keywords = JSON.parse(jsonMatch[0]);
                } catch (e) {
                    // Extract from comma-separated values
                    keywords = jsonMatch[1]
                        .split(',')
                        .map(k => k.trim().replace(/^["']|["']$/g, ''))
                        .filter(k => k.length > 0);
                }
            } else {
                // Extract from lines or comma-separated text
                const lines = response.split(/[,\n]/).filter(line => line.trim());
                keywords = lines
                    .map(line => line.replace(/^[-•*\d.)]\s*/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim())
                    .filter(k => k.length > 0 && k.length < 50)
                    .slice(0, 10);
            }
        }

        // Clean and validate keywords
        keywords = keywords
            .map(k => typeof k === 'string' ? k.trim() : String(k).trim())
            .filter(k => k.length > 0 && k.length < 50)
            .slice(0, 10); // Limit to 10 keywords

        console.log(`✅ Generated ${keywords.length} keywords:`, keywords);
        return keywords;

    } catch (error) {
        console.error('❌ Error generating keywords:', error);
        try { await sendWebhook('error.occurred', { meeting_id: null, code: 'keywords_generation_error', message: error && error.message ? error.message : String(error), details: {} }); } catch (e) {}
        return [];
    }
}

/**
 * Generate a short, descriptive meeting title from the transcript or summary using OpenAI
 */
async function generateMeetingTitle(captions, existingSummary = '', languageCode = 'es') {
    // Fallback simple title if OpenAI not configured
    if (!isConfigured()) {
        try {
            // Try to build a heuristic title from top speakers or first caption
            if (Array.isArray(captions) && captions.length > 0) {
                const first = captions.find(c => (c.text || '').trim());
                const speakers = Array.from(new Set(captions.map(c => (c.speaker || c.personName || 'Unknown').trim()).filter(Boolean))).slice(0,3);
                const titleParts = [];
                if (speakers.length) titleParts.push(speakers.join(', '));
                if (first && first.text) titleParts.push(first.text.trim().slice(0, 60));
                return titleParts.join(' - ').slice(0, 100) || 'Meeting';
            }
        } catch (e) {
            // ignore and fallback
        }
        return 'Meeting';
    }

    const language = getLanguageName(languageCode);
    try {
        const transcript = formatTranscript(captions);
        const prompt = `Generate a short, descriptive meeting title (6 words or fewer) for the following meeting. Return only the title text, nothing else. Respond in ${language}.

Context (either summary or transcript):\n${existingSummary ? existingSummary.slice(0, 4000) : transcript.slice(0, 4000)}`;

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `You are an assistant that crafts concise, informative meeting titles.` },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 32
        });

        let title = completion.choices[0].message.content.trim();
        // Clean title: strip surrounding quotes and newlines
        title = title.replace(/^\s+|\s+$/g, '').replace(/^['"]+|['"]+$/g, '');
        if (!title) return 'Meeting';
        return title.slice(0, 200);
    } catch (e) {
        console.warn('⚠️ Could not generate meeting title via OpenAI:', e.message);
        // Fallback heuristics
        try {
            if (Array.isArray(captions) && captions.length > 0) {
                const first = captions.find(c => (c.text || '').trim());
                return first && first.text ? first.text.trim().slice(0, 80) : 'Meeting';
            }
        } catch (ie) {
            // ignore
        }
        return 'Meeting';
    }
}

/**
 * Generate and save summary for a bot
 */
async function generateAndSaveSummary(botId, runtimeRoot, customSummaryTemplate = null, meetingType = null) {
    try {
        console.log(`📝 Generating summary for bot ${botId}...`);

        const botDir = path.join(runtimeRoot, botId);
        const transcriptPath = path.join(botDir, 'transcripts', 'captions.json');
        const summaryPath = path.join(botDir, 'summary.txt');
        const keywordsPath = path.join(botDir, 'keywords.json');
        const metadataPath = path.join(botDir, 'bot_metadata.json');
        // Resolve per-bot webhook override (if stored in runtime metadata) - use cached read
        let finalWebhook = process.env.WEBHOOK_URL || null;
        try {
            const metaForWebhook = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
            if (metaForWebhook) finalWebhook = metaForWebhook.webhookUrl || metaForWebhook.webhook_url || finalWebhook;
        } catch (e) {
            // ignore and fall back to env
        }

        // Check if transcript exists
        if (!await fs.pathExists(transcriptPath)) {
            console.log(`⚠️  No transcript found for bot ${botId}`);
            return null;
        }

        // Read captions
        const captions = await fs.readJson(transcriptPath);
        
        if (!Array.isArray(captions) || captions.length === 0) {
            console.log(`⚠️  No captions found for bot ${botId}`);
            const noContentMsg = 'No transcript content available for this meeting.';
            await fs.writeFile(summaryPath, noContentMsg, 'utf8');
            await fs.writeJson(keywordsPath, []); // Save empty keywords array
            return summaryPath;
        }

        // Read bot metadata to get language preference and meeting type - use cached read
        let languageCode = 'es'; // Default to Spanish
        let finalMeetingType = meetingType; // Use provided meeting type or try to get from metadata
        try {
            const metadata = await getCachedFile(metadataPath, fs.readJson, 60000).catch(() => null);
            if (metadata) {
                if (metadata.captionLanguage) {
                    languageCode = metadata.captionLanguage;
                    console.log(`🌐 Using language from metadata: ${languageCode}`);
                }
                if (!finalMeetingType && metadata.meetingType) {
                    finalMeetingType = metadata.meetingType;
                    console.log(`📋 Using meeting type from metadata: ${finalMeetingType}`);
                }
            }
        } catch (e) {
            console.warn(`⚠️  Could not read bot metadata, using defaults: ${e.message}`);
        }

        // Save formatted transcript
        await saveFormattedTranscript(botId, captions, runtimeRoot);

        // Generate summary (with or without OpenAI) - pass language code, custom template, and meeting type
        const summary = await generateSummary(captions, languageCode, customSummaryTemplate, finalMeetingType);

        // Save summary
        await fs.writeFile(summaryPath, summary, 'utf8');
        console.log(`✅ Summary saved: ${summaryPath}`);

        // Emit summary.completed webhook (best-effort). Include optional public URL if configured.
        try {
            const ts = getCurrentTimestamp();
            let publicSummaryUrl = null;
            if (process.env.PUBLIC_BASE_URL) {
                // Build a public URL if a base is provided. Expect PUBLIC_BASE_URL to map to runtimeRoot publicly.
                const base = String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
                publicSummaryUrl = `${base}/${encodeURIComponent(botId)}/summary.txt`;
            }
            // await to log potential errors; sendWebhook itself is best-effort
            await sendWebhook('summary.completed', {
                meeting_id: botId,
                summary: summary,
                public_summary_url: publicSummaryUrl,
                language: languageCode,
                saved_path: summaryPath,
                completed_at: ts.formatted,
                timezone: ts.timezone
            }, finalWebhook);
        } catch (e) {
            console.warn(`⚠️ Could not send summary.completed webhook for ${botId}: ${e && e.message ? e.message : e}`);
        }

        // Generate and save keywords
        const keywords = await generateKeywords(captions, languageCode);
        await fs.writeJson(keywordsPath, keywords, { spaces: 2 });
        console.log(`✅ Keywords saved: ${keywordsPath} (${keywords.length} keywords)`);

        // Update metrics to include OpenAI-generated keywords
        // Metrics might have been calculated before keywords were generated
        try {
            const metricsPath = path.join(botDir, 'MeetingMetrics.json');
            if (await fs.pathExists(metricsPath)) {
                const metrics = await fs.readJson(metricsPath);
                
                // Update keywords in metrics with OpenAI-generated keywords
                metrics.keywords = {
                    total: keywords.length,
                    byKeyword: {},
                    occurrences: []
                };
                
                // Count occurrences of each keyword in captions
                if (Array.isArray(captions) && captions.length > 0) {
                    keywords.forEach(keyword => {
                        if (keyword && typeof keyword === 'string' && keyword.trim().length > 0) {
                            const keywordTrimmed = keyword.trim();
                            const keywordLower = keywordTrimmed.toLowerCase();
                            const keywordRegex = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                            
                            let count = 0;
                            for (const caption of captions) {
                                const text = (caption.text || '').trim();
                                if (text && keywordRegex.test(text.toLowerCase())) {
                                    count++;
                                    const speaker = (caption.speaker || 'Unknown Speaker').trim();
                                    const timestamp = caption.timestampMs || (caption.offsetSeconds ? caption.offsetSeconds * 1000 : 0);
                                    const { formatTime } = require('./utils/timezone');
                                    metrics.keywords.occurrences.push({
                                        keyword: keywordTrimmed,
                                        speaker,
                                        timestamp,
                                        timestampFormatted: timestamp > 0 ? formatTime(new Date(timestamp)) : 'N/A',
                                        text: text
                                    });
                                }
                            }
                            
                            if (count > 0) {
                                metrics.keywords.byKeyword[keywordTrimmed] = count;
                            } else {
                                // Even if no occurrences found, include the keyword (count = 1)
                                metrics.keywords.byKeyword[keywordTrimmed] = 1;
                            }
                        }
                    });
                } else {
                    // If no captions, just set keywords without occurrences
                    keywords.forEach(keyword => {
                        if (keyword && typeof keyword === 'string' && keyword.trim().length > 0) {
                            metrics.keywords.byKeyword[keyword.trim()] = 1;
                        }
                    });
                }
                
                // Save updated metrics
                await fs.writeJson(metricsPath, metrics, { spaces: 2 });
                // Invalidate cache after update
                invalidateCache(metricsPath);
                console.log(`✅ Updated metrics with ${keywords.length} OpenAI-generated keywords`);
            }
        } catch (e) {
            console.warn(`⚠️  Could not update metrics with keywords: ${e.message}`);
        }

        // Generate a short meeting title and persist it into bot_metadata.json
        try {
            const generatedTitle = await generateMeetingTitle(captions, summary, languageCode);
            try {
                let metadata = {};
                if (await fs.pathExists(metadataPath)) {
                    try {
                        metadata = await fs.readJson(metadataPath);
                    } catch (e) {
                        console.warn(`⚠️ Could not parse existing metadata when saving title: ${e.message}`);
                        metadata = {};
                    }
                }

                // Only update if title is different to avoid unnecessary writes
                if (!metadata.title || metadata.title !== generatedTitle) {
                    metadata.title = generatedTitle;
                    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
                    // Invalidate cache after update
                    invalidateCache(metadataPath);
                    console.log(`✅ Updated bot metadata title: ${generatedTitle}`);
                } else {
                    console.log('ℹ️  Bot metadata title already up-to-date');
                }
            } catch (metaErr) {
                console.warn(`⚠️ Could not save generated title to metadata: ${metaErr.message}`);
            }
        } catch (titleErr) {
            console.warn(`⚠️ Could not generate meeting title: ${titleErr.message}`);
        }

        return summaryPath;

    } catch (error) {
        console.error(`❌ Error generating summary for bot ${botId}:`, error);
        try { await sendWebhook('error.occurred', { meeting_id: botId, code: 'summary_pipeline_error', message: error && error.message ? error.message : String(error), details: {} }, finalWebhook); } catch (e) {}
        throw error;
    }
}

/**
 * Get default summary template
 * This is the base template used when no custom template is provided.
 * Note: meetingTypeContext and language are added dynamically when the template is used.
 */
function getDefaultSummaryTemplate() {
    return `You are an expert meeting analyst creating a comprehensive, 100% accurate executive summary. Analyze the following meeting transcript with exceptional attention to detail.

CRITICAL REQUIREMENTS FOR 100% ACCURACY:
- Include EVERY decision, action item, and commitment mentioned
- Preserve exact names, numbers, dates, and technical terms
- Do NOT omit any information - completeness is essential
- Capture ALL discussion points, not just highlights
- Maintain exact context and relationships between topics
- Preserve all deadlines, dates, and time commitments exactly as stated
- Include ALL participants and their contributions
- Capture ALL questions, answers, and follow-ups

Deliver the output in this exact structure:

**Executive Summary** (50–100 words)
Comprehensive overview of the meeting purpose, participants, tone, key outcomes, and overall context. Include meeting type and main objectives.

**Key Discussion Points**
ALL major and minor discussion points, not just top ones. Use detailed bullets. Include:
- Facts, data, and statistics mentioned
- Ideas, proposals, and suggestions
- Objections, concerns, and counter-arguments
- Technical issues and solutions discussed
- Decisions being explored or debated
- Background context and explanations

**Decisions & Commitments**
COMPLETE list of ALL confirmed decisions with:
- Exact decision statement
- Who made or agreed to the decision
- When it was made (if mentioned)
- Context and reasoning behind the decision
- Any conditions or caveats

**Action Items (Who / What / When / Status)**
COMPREHENSIVE list of ALL action items in this format:
- Owner: [Exact name]
- Task: [Detailed description]
- Deadline: [Exact date/time or "No deadline provided"]
- Dependencies: [If any]
- Notes: [Additional context]

Include ALL tasks mentioned, even if not explicitly assigned. Rewrite vague tasks into clear, measurable actions while preserving original intent.

**Risks, Concerns & Follow-ups**
ALL identified items including:
- Blockers and obstacles mentioned
- Uncertainties and open questions
- Technical or resource concerns
- Follow-up questions that need answers
- Items requiring clarification
- Potential issues or warnings raised

**Important Quotes & Statements**
Exact quotes or statements that are critical to understanding context, decisions, or commitments. Include speaker name and context.

**Participants Summary**
List all participants and their key contributions/roles in the meeting.

**Next Steps & Follow-ups**
All follow-up actions, meetings, or communications planned.

Guidelines:
- Be 100% accurate - do not add information not in the transcript
- Be comprehensive - include ALL details, not just highlights
- Preserve exact wording for critical statements
- Maintain chronological flow where relevant
- If audio quality seemed low or transcription unclear, indicate "Potential transcription ambiguity" where needed
- If participants express emotions (frustration, urgency, enthusiasm), note this in the Executive Summary
- Maintain professional formatting with clear sections
- Use markdown formatting for readability

IMPORTANT: This summary must be complete and exact. Double-check that you have included ALL information from the transcript.`;
}

/**
 * Get model information
 */
function getModelInfo() {
    return {
        configured: isConfigured(),
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        apiKey: isConfigured() ? '***configured***' : 'not configured'
    };
}

module.exports = {
    generateSummary,
    generateKeywords,
    generateAndSaveSummary,
    formatTranscript,
    saveFormattedTranscript,
    isConfigured,
    getModelInfo,
    buildUtterances,
    getDefaultSummaryTemplate
};

