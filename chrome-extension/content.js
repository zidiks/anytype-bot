/**
 * Anytype Meet Recorder - Content Script
 * Captures captions from Google Meet
 */

class MeetRecorder {
  constructor() {
    this.isRecording = false;
    this.transcript = [];
    this.lastCaptionText = ''; // Track last caption to detect updates vs new
    this.lastCaptionTime = 0;  // When last caption was captured
    this.pendingCaption = '';  // Caption being built up
    this.pendingSpeaker = '';  // Current speaker name
    this.meetingTitle = '';
    this.startTime = null;
    this.captionObserver = null;
    this.captionInterval = null;
    this.floatingButton = null;
    this.isConnected = false;
    
    // Intermediate summaries for long meetings
    this.intermediateSummaries = [];
    this.lastSummaryIndex = 0;  // Last transcript index that was summarized
    this.summaryInterval = null;
    this.SUMMARY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    this.MIN_CHARS_FOR_SUMMARY = 500; // Minimum chars before generating summary
    
    // Keep-alive to prevent tab throttling
    this.keepAliveInterval = null;
    this.keepAliveAudio = null;
    this.visibilityHandler = null;
    this.webLockAbort = null;
    this.webLockRelease = null;
    
    // Caption status monitoring
    this.captionsEnabled = false;
    this.captionStatusInterval = null;
    
    // Patterns to filter out (UI elements, not real captions)
    this.filterPatterns = [
      // Device names
      /^(OBS|Virtual Camera|Микрофон|Headset|Audio Device|NVIDIA|LG )/i,
      /USB PnP/i,
      /Gaming Headset/i,
      /ULTRAGEAR/i,
      /S\/PDIF/i,
      /High Definition/i,
      /^\w+\s*\(\w+\)$/,  // Pattern like "Something (Something)"
      
      // UI buttons and labels  
      /^settings/i,
      /^(Настрой|Открыть настройки|Перейти|Закрыть|Отмена|Готово|Сохранить)/i,
      /настройки субтитров/i,
      /Перейти вниз/i,
      /Перейти наверх/i,
      /(Включить|Выключить|Отключить)/i,
      /^(По умолчанию|Default)/i,
      
      // Size/format options
      /^(Мелкий|Маленький|Средний|Крупный|Огромный|Гигантский)/i,
      /^(БЕТА-ВЕРСИЯ|arrow_|format_size|more_vert)/i,
      
      // Colors
      /^(circle|Белый|Черный|Синий|Зеленый|Красный|Желтый|Оранжевый)/i,
      
      // Audio devices
      /^(Динамики|Наушники|Digital Audio)/i,
      
      // Languages list
      /^(Азербайджан|Албан|Амхар|Англий|Араб|Армян|Африка)/i,
      /ВЕРСИЯ/i,
      
      // Meeting UI
      /Присоединиться/i,
      /meeting_room/i,
      /могут все желающие/i,
      /Покинуть/i,
      /Участники/i,
      /Чат/i,
      /Демонстрация/i,
      /Поделиться экраном/i,
      /Записать/i,
      /Отправить/i,
    ];
    
    this.init();
  }

  async init() {
    console.log('🎤 Anytype Meet Recorder loaded');
    
    // Check if connected to bot
    const response = await chrome.runtime.sendMessage({ action: 'checkConnection' });
    this.isConnected = response?.connected || false;
    
    this.createFloatingButton();
    this.detectMeeting();
    this.startCaptionStatusMonitor();
  }
  
  /**
   * Check if captions are currently visible/enabled
   */
  checkCaptionsEnabled() {
    // Look for caption container
    const captionContainer = document.querySelector(
      '[aria-label="Субтитры"], [aria-label="Captions"], [aria-label*="caption" i], [aria-label*="subtitle" i]'
    );
    
    // Also check for the captions button state
    const captionButton = document.querySelector(
      '[aria-label*="субтитр" i], [aria-label*="caption" i], [data-tooltip*="субтитр" i], [data-tooltip*="caption" i]'
    );
    
    // Captions are enabled if container exists and has content
    const hasContainer = !!captionContainer;
    const hasContent = captionContainer?.textContent?.trim().length > 5;
    
    // Or if the button indicates captions are on
    const buttonPressed = captionButton?.getAttribute('aria-pressed') === 'true';
    
    return hasContainer && hasContent;
  }
  
  /**
   * Start monitoring caption status
   */
  startCaptionStatusMonitor() {
    // Initial check
    this.updateCaptionStatus();
    
    // Check every 2 seconds
    this.captionStatusInterval = setInterval(() => {
      this.updateCaptionStatus();
    }, 2000);
  }
  
  /**
   * Update caption status indicator
   */
  updateCaptionStatus() {
    const wasEnabled = this.captionsEnabled;
    this.captionsEnabled = this.checkCaptionsEnabled();
    
    // Update button indicator
    this.updateCaptionIndicator();
    
    // Log status change
    if (wasEnabled !== this.captionsEnabled) {
      console.log(`📺 Captions ${this.captionsEnabled ? 'ENABLED' : 'DISABLED'}`);
      
      // Warn if recording without captions
      if (this.isRecording && !this.captionsEnabled) {
        this.showNotification('⚠️ Captions turned OFF! Press C to enable.', 'warning');
      }
    }
  }
  
  /**
   * Update caption indicator on button
   */
  updateCaptionIndicator() {
    if (!this.floatingButton || !this.isConnected) return;
    
    let indicator = this.floatingButton.querySelector('.anytype-caption-status');
    
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'anytype-caption-status';
      this.floatingButton.appendChild(indicator);
    }
    
    if (this.captionsEnabled) {
      indicator.className = 'anytype-caption-status caption-on';
      indicator.innerHTML = '🔤 CC';
      indicator.title = 'Субтитры включены';
    } else {
      indicator.className = 'anytype-caption-status caption-off';
      indicator.innerHTML = '🔇 CC';
      indicator.title = 'Субтитры выключены! Нажмите C';
    }
  }

  /**
   * Check if text looks like a real caption (not UI element)
   */
  isValidCaption(text) {
    if (!text || text.length < 2) return false;
    if (text.length > 500) return false; // Too long for a single caption
    
    // Filter out known UI patterns
    for (const pattern of this.filterPatterns) {
      if (pattern.test(text)) {
        return false;
      }
    }
    
    // Filter out lists of options (contain too many newlines)
    if ((text.match(/\n/g) || []).length > 5) return false;
    
    // Allow single words if they're longer (could be names or important words)
    // Caption text can be just a few words
    
    return true;
  }

  /**
   * Create floating record button
   */
  createFloatingButton() {
    this.floatingButton = document.createElement('div');
    this.floatingButton.id = 'anytype-recorder-btn';
    
    if (!this.isConnected) {
      this.floatingButton.innerHTML = `
        <div class="anytype-btn-inner anytype-disconnected">
          <span class="anytype-icon">⚠️</span>
          <span class="anytype-text">Setup Required</span>
        </div>
      `;
      this.floatingButton.addEventListener('click', () => {
        this.showNotification('Open extension popup and connect to Telegram bot first!', 'warning');
      });
    } else {
      this.floatingButton.innerHTML = `
        <div class="anytype-btn-inner">
          <span class="anytype-icon">⏺️</span>
          <span class="anytype-text">Record</span>
        </div>
      `;
      this.floatingButton.addEventListener('click', () => this.toggleRecording());
    }
    
    document.body.appendChild(this.floatingButton);
  }

  /**
   * Update button state
   */
  updateButton() {
    if (!this.isConnected) return;
    
    const inner = this.floatingButton.querySelector('.anytype-btn-inner');
    if (this.isRecording) {
      this.floatingButton.classList.add('recording');
      // Show warning if captions are off during recording
      const captionWarning = !this.captionsEnabled ? ' ⚠️' : '';
      inner.innerHTML = `
        <span class="anytype-icon">⏹️</span>
        <span class="anytype-text">Stop & Save${captionWarning}</span>
      `;
    } else {
      this.floatingButton.classList.remove('recording');
      inner.innerHTML = `
        <span class="anytype-icon">⏺️</span>
        <span class="anytype-text">Record</span>
      `;
    }
    
    // Also update caption indicator
    this.updateCaptionIndicator();
  }

  /**
   * Detect if we're in a meeting
   */
  detectMeeting() {
    const checkTitle = () => {
      const titleEl = document.querySelector('[data-meeting-title]');
      if (titleEl) {
        this.meetingTitle = titleEl.textContent;
        return;
      }
      
      const headerEl = document.querySelector('[data-meeting-code]');
      if (headerEl) {
        this.meetingTitle = `Meeting ${headerEl.getAttribute('data-meeting-code')}`;
        return;
      }
      
      const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
      if (match) {
        this.meetingTitle = `Meeting ${match[1]}`;
      }
    };

    checkTitle();
    setInterval(checkTitle, 5000);
  }

  /**
   * Toggle recording on/off
   */
  async toggleRecording() {
    if (this.isRecording) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  /**
   * Start keep-alive mechanisms to prevent tab throttling
   */
  startKeepAlive() {
    console.log('🔋 Starting keep-alive mechanisms...');
    
    // 1. Periodic message to background script
    this.keepAliveInterval = setInterval(() => {
      chrome.runtime.sendMessage({ action: 'keepAlive' }).catch(() => {});
      // Touch DOM to prevent throttling
      void document.hidden;
    }, 15000); // Every 15 seconds
    
    // 2. Silent audio to prevent tab suspension
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      gainNode.gain.value = 0.001; // Nearly silent
      oscillator.frequency.value = 1; // Very low frequency
      oscillator.start();
      
      this.keepAliveAudio = { context: audioContext, oscillator };
      console.log('🔊 Silent audio keep-alive started');
    } catch (e) {
      console.warn('Could not start audio keep-alive:', e);
    }
    
    // 3. Web Lock API - prevents tab from being discarded
    if (navigator.locks) {
      this.webLockAbort = new AbortController();
      navigator.locks.request(
        'meet-recorder-active',
        { signal: this.webLockAbort.signal },
        () => new Promise((resolve) => {
          // This promise never resolves while recording, keeping the lock
          this.webLockRelease = resolve;
        })
      ).catch(() => {}); // Ignore abort errors
      console.log('🔒 Web Lock acquired');
    }
    
    // 4. Handle visibility change - try to resume when tab becomes visible again
    this.visibilityHandler = () => {
      if (!document.hidden && this.isRecording) {
        console.log('👁️ Tab visible again, ensuring capture is active...');
        // Re-check caption observer
        if (!this.captionObserver) {
          this.observeCaptions();
        }
        // Resume audio context if suspended
        if (this.keepAliveAudio?.context?.state === 'suspended') {
          this.keepAliveAudio.context.resume();
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }
  
  /**
   * Stop keep-alive mechanisms
   */
  stopKeepAlive() {
    console.log('🔋 Stopping keep-alive mechanisms...');
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    if (this.keepAliveAudio) {
      try {
        this.keepAliveAudio.oscillator.stop();
        this.keepAliveAudio.context.close();
      } catch (e) {}
      this.keepAliveAudio = null;
    }
    
    // Release Web Lock
    if (this.webLockRelease) {
      this.webLockRelease();
      this.webLockRelease = null;
      console.log('🔓 Web Lock released');
    }
    if (this.webLockAbort) {
      this.webLockAbort.abort();
      this.webLockAbort = null;
    }
    
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * Start recording
   */
  async startRecording() {
    console.log('🎤 Starting recording...');
    
    // Enable captions if not already enabled
    this.enableCaptions();
    
    this.isRecording = true;
    this.startTime = new Date();
    this.transcript = [];
    this.pendingCaption = '';
    this.pendingSpeaker = '';
    this.pendingCaptions = new Map(); // Track each speaker separately
    this.lastCaptionTime = 0;
    this.lastCaptionText = '';
    this.intermediateSummaries = [];
    this.lastSummaryIndex = 0;
    
    this.updateButton();
    
    // Check caption status and show appropriate message
    if (this.captionsEnabled) {
      this.showNotification('✅ Recording started! Captions detected.', 'success');
    } else {
      this.showNotification('⚠️ Recording started but CAPTIONS ARE OFF!\nPress C to enable captions.', 'warning');
    }
    
    // Start keep-alive to prevent tab throttling
    this.startKeepAlive();
    
    // Notify Telegram
    chrome.runtime.sendMessage({
      action: 'logEvent',
      event: 'recording_started',
      message: this.meetingTitle || 'Google Meet'
    });
    
    // Start observing captions
    this.observeCaptions();
    
    // Start intermediate summary timer for long meetings
    this.startIntermediateSummaryTimer();
  }

  /**
   * Start timer for periodic intermediate summaries
   */
  startIntermediateSummaryTimer() {
    // Generate intermediate summary every 10 minutes
    this.summaryInterval = setInterval(async () => {
      if (!this.isRecording) return;
      
      await this.generateIntermediateSummary();
    }, this.SUMMARY_INTERVAL_MS);
  }

  /**
   * Generate intermediate summary of new content since last summary
   */
  async generateIntermediateSummary() {
    // Get new transcript entries since last summary
    const newEntries = this.transcript.slice(this.lastSummaryIndex);
    if (newEntries.length === 0) return;
    
    const newText = newEntries.map(t => t.text).join(' ');
    if (newText.length < this.MIN_CHARS_FOR_SUMMARY) {
      console.log(`📊 Not enough new content for summary (${newText.length} chars)`);
      return;
    }
    
    const chunkNum = this.intermediateSummaries.length + 1;
    const startTime = newEntries[0].timestamp;
    const endTime = newEntries[newEntries.length - 1].timestamp;
    
    console.log(`📊 Generating intermediate summary #${chunkNum} (${newText.length} chars)...`);
    this.showNotification(`📊 Generating summary chunk #${chunkNum}...`);
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'generateIntermediateSummary',
        data: {
          chunkNumber: chunkNum,
          text: newText,
          startTime,
          endTime,
          meetingTitle: this.meetingTitle
        }
      });
      
      if (response.success && response.summary) {
        this.intermediateSummaries.push({
          chunkNumber: chunkNum,
          summary: response.summary,
          startTime,
          endTime,
          charCount: newText.length
        });
        
        this.lastSummaryIndex = this.transcript.length;
        console.log(`✅ Intermediate summary #${chunkNum} saved`);
        
        // Notify user
        chrome.runtime.sendMessage({
          action: 'logEvent',
          event: 'intermediate_summary',
          message: `Chunk #${chunkNum}: ${response.summary.substring(0, 100)}...`
        });
      }
    } catch (error) {
      console.error('Failed to generate intermediate summary:', error);
    }
  }

  /**
   * Enable Google Meet captions
   */
  enableCaptions() {
    // Try clicking CC button
    const ccButtons = document.querySelectorAll(
      '[aria-label*="caption" i], [aria-label*="subtitle" i], ' +
      '[data-tooltip*="caption" i], [aria-label*="субтитр" i]'
    );
    
    for (const btn of ccButtons) {
      const isOff = btn.getAttribute('aria-pressed') === 'false';
      if (isOff) {
        btn.click();
        console.log('Enabled captions');
        break;
      }
    }
  }

  /**
   * Find the caption container element by aria-label
   * This is stable across Google Meet updates
   */
  findCaptionContainer() {
    // Use aria-label which is stable and semantic
    return document.querySelector(
      '[aria-label="Субтитры"], [aria-label="Captions"], [aria-label*="caption" i], [aria-label*="subtitle" i]'
    );
  }

  /**
   * Extract caption text from a caption block
   * Structure: main div > [speaker div with img] + [caption text div]
   */
  extractCaptionFromBlock(block) {
    // Find the div that contains the actual caption text
    // It's the sibling of the div containing the speaker avatar (img)
    const children = Array.from(block.children);
    
    let speakerName = '';
    let captionTexts = [];
    
    for (const child of children) {
      // Speaker block has an img (avatar)
      if (child.querySelector('img')) {
        // Extract speaker name from span inside
        const nameSpan = child.querySelector('span');
        if (nameSpan) {
          speakerName = nameSpan.textContent?.trim() || '';
        }
        continue;
      }
      
      // Skip buttons
      if (child.closest('button') || child.querySelector('button') ||
          child.getAttribute('role') === 'button') {
        continue;
      }
      
      // Skip elements with icons
      if (child.querySelector('i, svg, [class*="icon"]')) continue;
      
      // This should be the caption text div - get ALL its text content
      const text = child.textContent?.trim();
      if (text && text.length > 3) {
        captionTexts.push(text);
      }
    }
    
    // Combine all caption texts from this block
    const captionText = captionTexts.join(' ').replace(/\s+/g, ' ').trim();
    
    return { speakerName, captionText };
  }

  /**
   * Observe captions in the DOM
   */
  observeCaptions() {
    // Focus on the caption container area at the bottom of the screen
    const captionContainer = this.findCaptionContainer();
    
    const extractCaptions = () => {
      if (!this.isRecording) return;
      
      // Find caption container by aria-label (stable across updates)
      const captionContainer = document.querySelector(
        '[aria-label="Субтитры"], [aria-label="Captions"], [aria-label*="caption" i], [aria-label*="subtitle" i]'
      );
      
      if (!captionContainer) {
        // Captions not visible - if we have pending caption, save it
        if (this.pendingCaption && this.pendingCaption.length > 10) {
          this.finalizePendingCaption();
        }
        return;
      }
      
      // Collect ALL caption blocks with speaker attribution
      // Google Meet shows multiple speakers' captions simultaneously
      let captionEntries = []; // Array of {speaker, text}
      
      // Find all caption blocks (direct children of container)
      const captionBlocks = captionContainer.querySelectorAll(':scope > div');
      
      for (const block of captionBlocks) {
        // Skip settings/UI blocks (buttons, navigation)
        if (block.querySelector('button')) continue;
        if (block.classList.contains('IMKgW')) continue; // Skip button container
        
        const { speakerName, captionText } = this.extractCaptionFromBlock(block);
        
        if (captionText && captionText.length > 5 && this.isValidCaption(captionText)) {
          captionEntries.push({
            speaker: speakerName || 'Unknown',
            text: captionText
          });
        }
      }
      
      // Fallback: try to get text from all leaf divs
      if (captionEntries.length === 0) {
        const textDivs = captionContainer.querySelectorAll('div');
        for (const el of textDivs) {
          // Skip if contains img (speaker block) or buttons
          if (el.querySelector('img, button, svg, i')) continue;
          if (el.closest('button')) continue;
          
          // Only get leaf nodes (no child divs with text)
          const childDivText = el.querySelector('div')?.textContent?.trim() || '';
          if (childDivText.length > 10) continue;
          
          const text = el.textContent?.trim();
          if (text && text.length > 5 && this.isValidCaption(text)) {
            // Avoid duplicates
            if (!captionEntries.some(e => e.text.includes(text) || text.includes(e.text))) {
              captionEntries.push({ speaker: 'Unknown', text });
            }
          }
        }
      }
      
      if (captionEntries.length === 0) return;
      
      const now = Date.now();
      
      // Initialize pending captions map if needed (tracks each speaker separately)
      if (!this.pendingCaptions) {
        this.pendingCaptions = new Map();
      }
      
      // Helper to normalize text for comparison
      const normalize = (t) => t.toLowerCase().replace(/[.,?!:;'"]/g, '').replace(/\s+/g, ' ').trim();
      
      // Create unique keys for each caption block (speaker + first words)
      // This allows same speaker to have multiple separate utterances
      const getBlockKey = (speaker, text) => {
        const words = normalize(text).split(' ').slice(0, 3).join(' ');
        return `${speaker}::${words}`;
      };
      
      // Get current block keys
      const currentBlockKeys = new Set();
      for (const entry of captionEntries) {
        if (entry.text && entry.text.length >= 5) {
          currentBlockKeys.add(getBlockKey(entry.speaker || 'Unknown', entry.text));
        }
      }
      
      // Finalize blocks that are NO LONGER visible (scrolled away)
      for (const [blockKey, pending] of this.pendingCaptions.entries()) {
        if (!currentBlockKeys.has(blockKey) && pending.text && pending.text.length >= 10) {
          console.log(`👋 Block gone, finalizing [${pending.speaker}]: ${pending.text.length} chars`);
          this.saveCaptionToTranscript(pending.text, pending.speaker);
          this.pendingCaptions.delete(blockKey);
        }
      }
      
      // Process each caption block
      for (const entry of captionEntries) {
        const { speaker, text } = entry;
        if (!text || text.length < 5) continue;
        
        const speakerKey = speaker || 'Unknown';
        const blockKey = getBlockKey(speakerKey, text);
        
        console.log(`🎯 [${speakerKey}] ${text.length} chars: "${text.substring(0, 60)}..."`);
        
        // Find if we have a pending caption that this is updating
        let foundMatch = false;
        for (const [existingKey, pending] of this.pendingCaptions.entries()) {
          if (pending.speaker !== speakerKey) continue;
          
          const pendingNorm = normalize(pending.text);
          const currentNorm = normalize(text);
          
          // Check if this is an update of existing pending
          const pendingWords = pendingNorm.split(' ').slice(0, 4).join(' ');
          const currentWords = currentNorm.split(' ').slice(0, 4).join(' ');
          
          const isUpdate = pendingWords === currentWords ||
                          currentNorm.startsWith(pendingWords) ||
                          pendingNorm.startsWith(currentWords);
          
          if (isUpdate) {
            foundMatch = true;
            // Update if longer
            if (text.length >= pending.text.length) {
              console.log(`📈 [${speakerKey}] Updated: ${pending.text.length} → ${text.length} chars`);
              this.pendingCaptions.delete(existingKey);
              this.pendingCaptions.set(blockKey, { text, speaker: speakerKey, time: now });
            } else {
              pending.time = now; // Just refresh time
            }
            break;
          }
        }
        
        if (!foundMatch) {
          // New block - add it
          console.log(`🆕 [${speakerKey}] New block: "${text.substring(0, 40)}..."`);
          this.pendingCaptions.set(blockKey, { text, speaker: speakerKey, time: now });
        }
      }
      
      // Finalize blocks that haven't been updated for 6 seconds
      for (const [blockKey, pending] of this.pendingCaptions.entries()) {
        if (pending.text && pending.text.length >= 10 && now - pending.time > 6000) {
          console.log(`⏰ [${pending.speaker}] Timeout, finalizing (${pending.text.length} chars)`);
          this.saveCaptionToTranscript(pending.text, pending.speaker);
          this.pendingCaptions.delete(blockKey);
        }
      }
    };
    
    // Save caption to transcript with duplicate detection
    this.saveCaptionToTranscript = (text, speaker) => {
      if (!text || text.length < 10) return;
      
      const normalize = (t) => t.toLowerCase().replace(/[.,?!:;'"]/g, '').replace(/\s+/g, ' ').trim();
      const textNorm = normalize(text);
      const textWords = textNorm.split(' ').slice(0, 4).join(' ');
      
      // Only check for EXACT or VERY SIMILAR duplicates (same utterance being updated)
      // Don't merge different utterances from same speaker!
      for (let i = this.transcript.length - 1; i >= Math.max(0, this.transcript.length - 10); i--) {
        const existing = this.transcript[i];
        const existingNorm = normalize(existing.text);
        const existingWords = existingNorm.split(' ').slice(0, 4).join(' ');
        
        // Only match if SAME speaker AND same first words
        if (existing.speaker === speaker && textWords === existingWords) {
          if (text.length > existing.text.length) {
            console.log(`🔄 [${speaker}] Updating same utterance: ${existing.text.length} → ${text.length} chars`);
            existing.text = text;
            existing.timestamp = new Date().toISOString();
            this.updateBadge();
            return;
          } else {
            console.log(`⏭️ [${speaker}] Skipping duplicate`);
            return;
          }
        }
        
        // Also skip if text is nearly identical (within a few chars)
        if (existing.speaker === speaker && 
            (textNorm === existingNorm || 
             (Math.abs(text.length - existing.text.length) < 10 && 
              textNorm.includes(existingNorm.substring(0, 30))))) {
          console.log(`⏭️ [${speaker}] Skipping near-duplicate`);
          return;
        }
      }
      
      // Add new entry (this is a distinct utterance)
      console.log(`✅ [${speaker}] Adding utterance #${this.transcript.length + 1}: "${text.substring(0, 50)}..."`);
      this.transcript.push({
        timestamp: new Date().toISOString(),
        text: text,
        speaker: speaker
      });
      this.updateBadge();
    };
    
    // Legacy finalize (for compatibility)
    this.finalizePendingCaption = () => {
      console.log(`📦 Finalizing: "${this.pendingCaption?.substring(0, 60)}..." (${this.pendingCaption?.length || 0} chars)`);
      
      if (!this.pendingCaption || this.pendingCaption.length < 10) {
        console.log('⏭️ Too short, skipping');
        this.pendingCaption = '';
        this.pendingSpeaker = '';
        return;
      }
      
      const speaker = this.pendingSpeaker || '';
      let shouldAdd = true;
      let action = 'add';
      
      // Normalize text for comparison (remove punctuation, lowercase)
      const normalize = (text) => text.toLowerCase().replace(/[.,?!:;'"]/g, '').replace(/\s+/g, ' ').trim();
      const pendingNorm = normalize(this.pendingCaption);
      
      // Find if there's an existing entry that this is an update of
      // Check more entries (last 10) to catch all related fragments
      for (let i = this.transcript.length - 1; i >= Math.max(0, this.transcript.length - 10); i--) {
        const existing = this.transcript[i];
        const existingNorm = normalize(existing.text);
        
        // Extract first N words for comparison
        const pendingWords = pendingNorm.split(' ').slice(0, 5).join(' ');
        const existingWords = existingNorm.split(' ').slice(0, 5).join(' ');
        
        // Exact duplicate - skip
        if (existingNorm === pendingNorm) {
          shouldAdd = false;
          action = 'skip-exact';
          break;
        }
        
        // Same start (first 5 words match) - this is likely an update
        const sameStart = pendingWords === existingWords || 
                         pendingNorm.startsWith(existingWords) ||
                         existingNorm.startsWith(pendingWords);
        
        if (sameStart) {
          if (this.pendingCaption.length > existing.text.length) {
            // New is longer - replace
            console.log(`🔄 Replacing transcript[${i}]: ${existing.text.length} → ${this.pendingCaption.length} chars`);
            existing.text = this.pendingCaption;
            existing.speaker = speaker || existing.speaker;
            existing.timestamp = new Date().toISOString();
            shouldAdd = false;
            action = 'replaced';
          } else {
            // Old is longer or same - skip
            shouldAdd = false;
            action = 'skip-shorter';
          }
          break;
        }
        
        // Check if new text CONTAINS old text (it's a continuation)
        if (pendingNorm.includes(existingNorm) && this.pendingCaption.length > existing.text.length + 20) {
          console.log(`🔄 New contains old, replacing transcript[${i}]`);
          existing.text = this.pendingCaption;
          existing.speaker = speaker || existing.speaker;
          existing.timestamp = new Date().toISOString();
          shouldAdd = false;
          action = 'replaced-contains';
          break;
        }
      }
      
      console.log(`📋 Action: ${action} | Transcript: ${this.transcript.length} entries`);
      
      if (shouldAdd) {
        console.log(`✅ ADDING to transcript [${speaker}]: "${this.pendingCaption.substring(0, 80)}..."`);
        this.addCaption(this.pendingCaption, speaker);
      }
      
      this.pendingCaption = '';
      this.pendingSpeaker = '';
    };

    // Check periodically
    this.captionInterval = setInterval(extractCaptions, 1000);

    // Also observe DOM changes in caption area
    const observeTarget = captionContainer || document.body;
    
    this.captionObserver = new MutationObserver((mutations) => {
      if (!this.isRecording) return;
      
      let hasNewContent = false;
      mutations.forEach(mutation => {
        if (mutation.addedNodes.length > 0 || mutation.type === 'characterData') {
          hasNewContent = true;
        }
      });
      
      if (hasNewContent) {
        extractCaptions();
      }
    });

    this.captionObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
      characterData: true
    });
    
    // Initial extraction
    extractCaptions();
  }

  /**
   * Add caption to transcript
   */
  addCaption(text, speaker = '') {
    // Clean up the text
    const cleanText = text
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!cleanText) return;
    
    // Only skip exact duplicates (other checks done in finalizePendingCaption)
    const lastEntry = this.transcript[this.transcript.length - 1];
    if (lastEntry && lastEntry.text === cleanText) {
      return;
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      text: cleanText,
      speaker: speaker || 'Unknown'
    };
    
    this.transcript.push(entry);
    const speakerPrefix = speaker ? `[${speaker}] ` : '';
    console.log(`📝 ${speakerPrefix}${cleanText.substring(0, 60)}${cleanText.length > 60 ? '...' : ''}`);
    
    this.updateBadge();
  }

  /**
   * Update recording badge
   */
  updateBadge() {
    let badge = this.floatingButton.querySelector('.anytype-badge');
    if (badge) {
      badge.textContent = this.transcript.length;
    } else {
      badge = document.createElement('span');
      badge.className = 'anytype-badge';
      badge.textContent = this.transcript.length;
      this.floatingButton.appendChild(badge);
    }
  }

  /**
   * Stop recording and save
   */
  async stopRecording() {
    console.log('⏹️ Stopping recording...');
    
    this.isRecording = false;
    
    // Finalize ALL pending caption blocks
    if (this.pendingCaptions) {
      for (const [blockKey, pending] of this.pendingCaptions.entries()) {
        if (pending.text && pending.text.length >= 10) {
          console.log(`📦 Final save [${pending.speaker}]: ${pending.text.length} chars`);
          this.saveCaptionToTranscript(pending.text, pending.speaker);
        }
      }
      this.pendingCaptions.clear();
    }
    // Legacy fallback
    if (this.pendingCaption) {
      this.finalizePendingCaption();
    }
    
    // Stop keep-alive
    this.stopKeepAlive();
    
    // Stop all intervals
    if (this.captionInterval) {
      clearInterval(this.captionInterval);
      this.captionInterval = null;
    }
    if (this.summaryInterval) {
      clearInterval(this.summaryInterval);
      this.summaryInterval = null;
    }
    if (this.captionObserver) {
      this.captionObserver.disconnect();
      this.captionObserver = null;
    }
    
    this.updateButton();
    
    // Notify Telegram
    chrome.runtime.sendMessage({
      action: 'logEvent',
      event: 'recording_stopped',
      message: this.meetingTitle
    });
    
    // Generate final intermediate summary for remaining content
    if (this.transcript.length > this.lastSummaryIndex) {
      await this.generateIntermediateSummary();
    }
    
    // Compile transcript with speaker names
    let lastSpeaker = '';
    const formattedParts = [];
    
    for (const t of this.transcript) {
      if (t.speaker && t.speaker !== 'Unknown' && t.speaker !== lastSpeaker) {
        formattedParts.push(`\n[${t.speaker}]: ${t.text}`);
        lastSpeaker = t.speaker;
      } else {
        formattedParts.push(t.text);
      }
    }
    
    const fullTranscript = formattedParts.join(' ').trim();
    const duration = Math.round((new Date() - this.startTime) / 60000);
    
    console.log(`📊 Transcript: ${fullTranscript.length} chars, ${duration} minutes, ${this.transcript.length} entries`);
    console.log(`📊 Intermediate summaries: ${this.intermediateSummaries.length}`);
    
    if (fullTranscript.length < 20) {
      this.showNotification(
        'No captions captured. Make sure:\n1. Captions are ON (press C)\n2. Someone is speaking', 
        'warning'
      );
      return;
    }
    
    this.showNotification('Processing transcript...');
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'saveTranscript',
        data: {
          meetingTitle: this.meetingTitle || 'Google Meet Recording',
          transcript: fullTranscript,
          duration: duration,
          startTime: this.startTime.toISOString(),
          intermediateSummaries: this.intermediateSummaries // Include pre-generated summaries
        }
      });
      
      if (response.success) {
        const summaryPreview = response.summary?.substring(0, 100) || '';
        this.showNotification(`✅ Saved to Anytype!\n${summaryPreview}...`, 'success');
      } else {
        this.showNotification('❌ Error: ' + response.error, 'error');
      }
    } catch (error) {
      console.error('Save error:', error);
      this.showNotification('❌ Error saving: ' + error.message, 'error');
    }
    
    // Clear badge
    const badge = this.floatingButton.querySelector('.anytype-badge');
    if (badge) badge.remove();
  }

  /**
   * Show notification
   */
  showNotification(message, type = 'info') {
    const existing = document.querySelector('.anytype-notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = `anytype-notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 100);
    
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }
}

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new MeetRecorder());
} else {
  new MeetRecorder();
}
