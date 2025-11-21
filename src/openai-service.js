const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');

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
 * Split transcript into chunks for processing
 */
function chunkTranscript(transcript, maxTokens = 6000) {
    const lines = transcript.split('\n');
    const chunks = [];
    let currentChunk = '';
    
    for (const line of lines) {
        const testChunk = currentChunk + line + '\n';
        if (estimateTokens(testChunk) > maxTokens && currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = line + '\n';
        } else {
            currentChunk = testChunk;
        }
    }
    
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
}

/**
 * Generate summary for a chunk
 */
async function summarizeChunk(chunk, chunkIndex, totalChunks, language = 'Spanish') {
    const systemPrompt = `You are an expert meeting analyst. Analyze the following meeting transcript segment (part ${chunkIndex + 1} of ${totalChunks}) and extract:

1. Key discussion points
2. Decisions made
3. Action items with owners
4. Concerns or risks mentioned

Be concise and factual. Focus on actionable information.
IMPORTANT: Respond in ${language} language.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: chunk }
        ],
        temperature: 0.5,
        max_tokens: 1500
    });

    return completion.choices[0].message.content;
}

/**
 * Generate final summary from chunk summaries
 */
async function generateFinalSummary(chunkSummaries, fullTranscript, language = 'Spanish') {
    const combinedSummaries = chunkSummaries.join('\n\n---\n\n');
    
    const systemPrompt = `Analyze the following meeting transcript and produce a structured executive summary with the 5 core sections used by top conversation-intelligence platforms. Keep the summary clear, concise, and actionable.

Deliver the output in this exact structure:

**Executive Summary** (30–60 words)
High-level overview of the meeting purpose, tone, and outcomes. No details, just the essence.

**Key Discussion Points**
Top 5–8 points discussed. Use bullets. Capture facts, ideas, proposals, objections, technical issues, or decisions being explored.

**Decisions & Commitments**
List all confirmed decisions. Who committed to what. Include deadlines if mentioned.

**Action Items (Who / What / When)**
Output as a mini-table or bullet list. If no date was given, write "No deadline provided." Rewrite vague tasks into clear and measurable actions.

**Risks, Concerns & Follow-ups**
Identify blockers, uncertainties, or anything that needs clarification. Include follow-up questions the team should answer.

Guidelines:
- Be objective and avoid adding interpretation that was not mentioned.
- If audio quality seemed low or transcription unclear, indicate "Potential transcription ambiguity" where needed.
- If participants express emotions (frustration, urgency, enthusiasm), summarize tone briefly in the Executive Summary.
- Maintain professional formatting.
IMPORTANT: Respond in ${language} language.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Now analyze the transcript below:\n\n${combinedSummaries}` }
        ],
        temperature: 0.7,
        max_tokens: 2000
    });

    return completion.choices[0].message.content;
}

/**
 * Generate meeting summary using OpenAI
 */
async function generateSummary(captions, languageCode = 'es') {
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

        const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
        const modelLimit = modelLimits[model] || 4096;
        
        // Reserve tokens for system prompt and response
        const maxInputTokens = modelLimit - 3000;

        if (estimatedTokens > maxInputTokens) {
            console.log(`⚠️  Transcript too long (${estimatedTokens} tokens). Using chunked summarization strategy...`);
            
            // Split transcript into manageable chunks
            const chunks = chunkTranscript(transcript, 6000);
            console.log(`📄 Split transcript into ${chunks.length} chunks`);
            
            // Summarize each chunk
            const chunkSummaries = [];
            for (let i = 0; i < chunks.length; i++) {
                console.log(`   Processing chunk ${i + 1}/${chunks.length}...`);
                const chunkSummary = await summarizeChunk(chunks[i], i, chunks.length, language);
                chunkSummaries.push(chunkSummary);
            }
            
            // Generate final comprehensive summary
            console.log('📝 Generating final comprehensive summary...');
            const finalSummary = await generateFinalSummary(chunkSummaries, transcript, language);
            console.log('✅ AI summary generated successfully (chunked approach)');
            
            return finalSummary;
        } else {
            // Transcript fits in one request
            const systemPrompt = `Analyze the following meeting transcript and produce a structured executive summary with the 5 core sections used by top conversation-intelligence platforms. Keep the summary clear, concise, and actionable.

Deliver the output in this exact structure:

**Executive Summary** (30–60 words)
High-level overview of the meeting purpose, tone, and outcomes. No details, just the essence.

**Key Discussion Points**
Top 5–8 points discussed. Use bullets. Capture facts, ideas, proposals, objections, technical issues, or decisions being explored.

**Decisions & Commitments**
List all confirmed decisions. Who committed to what. Include deadlines if mentioned.

**Action Items (Who / What / When)**
Output as a mini-table or bullet list. If no date was given, write "No deadline provided." Rewrite vague tasks into clear and measurable actions.

**Risks, Concerns & Follow-ups**
Identify blockers, uncertainties, or anything that needs clarification. Include follow-up questions the team should answer.

Guidelines:
- Be objective and avoid adding interpretation that was not mentioned.
- If audio quality seemed low or transcription unclear, indicate "Potential transcription ambiguity" where needed.
- If participants express emotions (frustration, urgency, enthusiasm), summarize tone briefly in the Executive Summary.
- Maintain professional formatting.
IMPORTANT: Respond in ${language} language.`;

            const completion = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Now analyze the transcript below:\n\n${transcript}` }
                ],
                temperature: 0.7,
                max_tokens: 2000
            });

            const summary = completion.choices[0].message.content;
            console.log('✅ AI summary generated successfully');
            
            return summary;
        }

    } catch (error) {
        console.error('❌ Error generating OpenAI summary:', error.message);
        
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
        return [];
    }
}

/**
 * Generate and save summary for a bot
 */
async function generateAndSaveSummary(botId, runtimeRoot) {
    try {
        console.log(`📝 Generating summary for bot ${botId}...`);

        const botDir = path.join(runtimeRoot, botId);
        const transcriptPath = path.join(botDir, 'transcripts', 'captions.json');
        const summaryPath = path.join(botDir, 'summary.txt');
        const keywordsPath = path.join(botDir, 'keywords.json');
        const metadataPath = path.join(botDir, 'bot_metadata.json');

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

        // Read bot metadata to get language preference
        let languageCode = 'es'; // Default to Spanish
        try {
            if (await fs.pathExists(metadataPath)) {
                const metadata = await fs.readJson(metadataPath);
                if (metadata.captionLanguage) {
                    languageCode = metadata.captionLanguage;
                    console.log(`🌐 Using language from metadata: ${languageCode}`);
                }
            }
        } catch (e) {
            console.warn(`⚠️  Could not read bot metadata for language, using default: ${e.message}`);
        }

        // Save formatted transcript
        await saveFormattedTranscript(botId, captions, runtimeRoot);

        // Generate summary (with or without OpenAI) - pass language code
        const summary = await generateSummary(captions, languageCode);

        // Save summary
        await fs.writeFile(summaryPath, summary, 'utf8');
        console.log(`✅ Summary saved: ${summaryPath}`);

        // Generate and save keywords
        const keywords = await generateKeywords(captions, languageCode);
        await fs.writeJson(keywordsPath, keywords, { spaces: 2 });
        console.log(`✅ Keywords saved: ${keywordsPath} (${keywords.length} keywords)`);

        // Update metrics to include OpenAI-generated keywords
        // Metrics might have been calculated before keywords were generated
        try {
            const metricsPath = path.join(botDir, 'MeetingMetrics.json');
            if (fs.existsSync(metricsPath)) {
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
                console.log(`✅ Updated metrics with ${keywords.length} OpenAI-generated keywords`);
            }
        } catch (e) {
            console.warn(`⚠️  Could not update metrics with keywords: ${e.message}`);
        }

        return summaryPath;

    } catch (error) {
        console.error(`❌ Error generating summary for bot ${botId}:`, error);
        throw error;
    }
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
    buildUtterances
};

