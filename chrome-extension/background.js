/**
 * Anytype Meet Recorder - Background Script
 * Handles API calls to bot server for processing
 */

/**
 * Get settings from storage
 */
async function getSettings() {
  return await chrome.storage.sync.get([
    'serverUrl',
    'token',
    'isConnected',
    'anytypeApiUrl',
    'anytypeBearerToken',
    'anytypeSpaceId',
    'deepseekApiKey',
    'deepseekApiUrl'
  ]);
}

/**
 * Send event to Telegram bot
 */
async function logEvent(event, message) {
  const settings = await getSettings();
  
  if (!settings.serverUrl || !settings.token) {
    console.log('Not connected to bot, skipping event log');
    return;
  }
  
  try {
    await fetch(`${settings.serverUrl}/api/extension/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: settings.token,
        event,
        message
      })
    });
  } catch (error) {
    console.error('Failed to log event:', error);
  }
}

/**
 * Generate summary using DeepSeek API (fallback if server unavailable)
 */
async function generateSummary(transcript, meetingTitle, settings) {
  const response = await fetch(`${settings.deepseekApiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes meeting transcripts. Create a concise summary highlighting key points, decisions, and action items. Write in the same language as the transcript.'
        },
        {
          role: 'user',
          content: `Please summarize this meeting transcript from "${meetingTitle}":\n\n${transcript}`
        }
      ],
      max_tokens: 1000,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Save note to Anytype directly (fallback)
 */
async function saveToAnytypeDirect(title, body, settings) {
  const url = `${settings.anytypeApiUrl}/v1/spaces/${settings.anytypeSpaceId}/objects`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.anytypeBearerToken}`,
      'Anytype-Version': '2025-05-20'
    },
    body: JSON.stringify({
      name: title,
      body: body,
      icon: { format: 'emoji', emoji: '🎥' }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anytype API error: ${response.status} - ${text}`);
  }

  return await response.json();
}

/**
 * Save transcript via bot server
 */
async function saveViaServer(data, settings) {
  const response = await fetch(`${settings.serverUrl}/api/extension/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: settings.token,
      ...data
    })
  });
  
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || `Server error: ${response.status}`);
  }
  
  return await response.json();
}

/**
 * Format note body with summary and transcript
 */
function formatNoteBody(summary, transcript, duration) {
  return `## Summary

${summary}

---

## Full Transcript

> ${transcript}

---
*Duration: ${duration} minutes*
`;
}

/**
 * Handle messages from content script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveTranscript') {
    handleSaveTranscript(message.data)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'generateIntermediateSummary') {
    handleIntermediateSummary(message.data)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'logEvent') {
    logEvent(message.event, message.message);
    sendResponse({ success: true });
    return false;
  }
  
  if (message.action === 'getSettings') {
    getSettings()
      .then(settings => sendResponse(settings))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (message.action === 'checkConnection') {
    getSettings()
      .then(settings => {
        // Connected if we have API keys (even if server token expired)
        const hasApiKeys = !!(settings.anytypeBearerToken && settings.deepseekApiKey);
        sendResponse({ connected: hasApiKeys });
      })
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  
  if (message.action === 'keepAlive') {
    // Keep-alive ping from content script to prevent service worker from sleeping
    sendResponse({ alive: true, timestamp: Date.now() });
    return false;
  }
});

/**
 * Generate intermediate summary for a chunk of text
 */
async function handleIntermediateSummary(data) {
  const { chunkNumber, text, meetingTitle } = data;
  
  console.log(`Generating intermediate summary #${chunkNumber} (${text.length} chars)`);
  
  const settings = await getSettings();
  
  // Try via server first
  if (settings.serverUrl && settings.token) {
    try {
      const response = await fetch(`${settings.serverUrl}/api/extension/summarize-chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: settings.token,
          chunkNumber,
          text,
          meetingTitle
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        return { success: true, summary: result.summary };
      }
    } catch (error) {
      console.warn('Server summarize failed, trying direct:', error.message);
    }
  }
  
  // Fallback: Direct DeepSeek API call
  if (settings.deepseekApiKey) {
    const summary = await generateChunkSummary(text, chunkNumber, meetingTitle, settings);
    return { success: true, summary };
  }
  
  return { success: false, error: 'No API configured' };
}

/**
 * Generate summary for a chunk using DeepSeek directly
 */
async function generateChunkSummary(text, chunkNumber, meetingTitle, settings) {
  const response = await fetch(`${settings.deepseekApiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a meeting summarizer. Create a brief summary of this meeting segment. Focus on key points, decisions, and action items. Be concise (2-4 sentences). Write in the same language as the transcript.'
        },
        {
          role: 'user',
          content: `Summarize segment #${chunkNumber} of meeting "${meetingTitle}":\n\n${text}`
        }
      ],
      max_tokens: 300,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Process and save transcript
 */
async function handleSaveTranscript(data) {
  const { meetingTitle, transcript, duration, startTime, intermediateSummaries } = data;
  
  console.log('Processing transcript:', {
    title: meetingTitle,
    length: transcript.length,
    duration,
    intermediateSummariesCount: intermediateSummaries?.length || 0
  });
  
  const settings = await getSettings();
  
  // Validate connection
  if (!settings.isConnected) {
    throw new Error('Not connected to bot. Please open extension and set up connection.');
  }
  
  // Try saving via server first (preferred - notifies Telegram)
  if (settings.serverUrl && settings.token) {
    try {
      console.log('Saving via server...');
      const result = await saveViaServer({
        meetingTitle,
        transcript,
        duration,
        startTime,
        intermediateSummaries
      }, settings);
      
      console.log('Saved via server:', result);
      return result;
    } catch (error) {
      console.warn('Server save failed, trying direct:', error.message);
      // Fall through to direct save
    }
  }
  
  // Fallback: Direct API calls
  if (!settings.anytypeBearerToken || !settings.deepseekApiKey) {
    throw new Error('Configuration incomplete. Please reconnect via Telegram bot.');
  }
  
  let finalSummary;
  
  // If we have intermediate summaries, combine them
  if (intermediateSummaries && intermediateSummaries.length > 0) {
    console.log(`Combining ${intermediateSummaries.length} intermediate summaries...`);
    finalSummary = await combineIntermediateSummaries(intermediateSummaries, meetingTitle, settings);
  } else {
    // For short meetings, generate summary directly
    console.log('Generating summary directly...');
    finalSummary = await generateSummary(transcript, meetingTitle, settings);
  }
  
  console.log('Final summary generated:', finalSummary.length, 'chars');
  
  // Format title with date
  const date = new Date(startTime);
  const formattedDate = date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  const noteTitle = `🎥 ${meetingTitle} - ${formattedDate}`;
  const noteBody = formatNoteBodyWithChunks(finalSummary, intermediateSummaries, transcript, duration);
  
  // Save to Anytype
  console.log('Saving to Anytype directly...');
  const result = await saveToAnytypeDirect(noteTitle, noteBody, settings);
  console.log('Saved:', result);
  
  // Try to notify via server
  logEvent('saved', `${meetingTitle} (${duration} min)`);
  
  return {
    success: true,
    summary: finalSummary,
    objectId: result.object?.id
  };
}

/**
 * Combine intermediate summaries into final summary
 */
async function combineIntermediateSummaries(intermediateSummaries, meetingTitle, settings) {
  const summariesText = intermediateSummaries
    .map(s => `[Part ${s.chunkNumber}]: ${s.summary}`)
    .join('\n\n');
  
  const response = await fetch(`${settings.deepseekApiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a meeting summarizer. You will receive summaries of different parts of a long meeting. Create a cohesive final summary that covers all key points, decisions, and action items from all parts. Write in the same language as the input.'
        },
        {
          role: 'user',
          content: `Create a final summary for meeting "${meetingTitle}" from these part summaries:\n\n${summariesText}`
        }
      ],
      max_tokens: 1500,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Format note body with intermediate summaries section
 */
function formatNoteBodyWithChunks(finalSummary, intermediateSummaries, transcript, duration) {
  let body = `## Summary\n\n${finalSummary}\n\n---\n\n`;
  
  // Add intermediate summaries if available
  if (intermediateSummaries && intermediateSummaries.length > 1) {
    body += `## Meeting Timeline\n\n`;
    for (const chunk of intermediateSummaries) {
      body += `### Part ${chunk.chunkNumber}\n${chunk.summary}\n\n`;
    }
    body += `---\n\n`;
  }
  
  body += `## Full Transcript\n\n> ${transcript}\n\n---\n*Duration: ${duration} minutes*\n`;
  
  return body;
}

// Log when extension loads
console.log('Anytype Meet Recorder background script loaded');

/**
 * Listen for tabs that contain the connect page
 * Auto-connect when user opens the connect URL from Telegram
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  
  // Check if this is a connect page
  const connectMatch = tab.url.match(/\/connect\/([A-Za-z0-9_-]+)/);
  if (!connectMatch) return;
  
  const token = connectMatch[1];
  const serverUrl = new URL(tab.url).origin;
  
  console.log('Connect page detected, token:', token.substring(0, 10) + '...');
  
  try {
    // Fetch the config from the server
    const configUrl = `${serverUrl}/api/extension/config/${token}`;
    const response = await fetch(configUrl);
    
    if (!response.ok) {
      console.error('Failed to fetch config:', response.status);
      // Notify the page
      chrome.scripting.executeScript({
        target: { tabId },
        func: (error) => {
          window.postMessage({ type: 'ANYTYPE_EXTENSION_ERROR', error }, '*');
        },
        args: ['Invalid or expired token']
      });
      return;
    }
    
    const config = await response.json();
    
    // Save the config
    await chrome.storage.sync.set({
      serverUrl: serverUrl,
      token: token,
      isConnected: true,
      anytypeApiUrl: config.anytypeApiUrl,
      anytypeBearerToken: config.anytypeBearerToken,
      anytypeSpaceId: config.anytypeSpaceId,
      deepseekApiKey: config.deepseekApiKey,
      deepseekApiUrl: config.deepseekApiUrl
    });
    
    console.log('Extension connected successfully!');
    
    // Notify the page that we're connected
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.postMessage({ type: 'ANYTYPE_EXTENSION_CONNECTED' }, '*');
      }
    });
    
    // Log the connection event
    logEvent('extension_connected', 'Extension connected via auto-connect');
    
  } catch (error) {
    console.error('Auto-connect error:', error);
  }
});
