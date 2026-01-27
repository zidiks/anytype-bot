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
      inner.innerHTML = `
        <span class="anytype-icon">⏹️</span>
        <span class="anytype-text">Stop & Save</span>
      `;
    } else {
      this.floatingButton.classList.remove('recording');
      inner.innerHTML = `
        <span class="anytype-icon">⏺️</span>
        <span class="anytype-text">Record</span>
      `;
    }
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
    this.lastCaptionTime = 0;
    this.lastCaptionText = '';
    this.intermediateSummaries = [];
    this.lastSummaryIndex = 0;
    
    this.updateButton();
    this.showNotification('Recording started! Make sure captions are ON (press C).');
    
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
      
      // Get all text divs inside caption container, excluding buttons
      const textElements = captionContainer.querySelectorAll('div');
      let currentCaptionText = '';
      
      textElements.forEach(el => {
        // Skip buttons
        if (el.closest('button') || el.querySelector('button') ||
            el.getAttribute('role') === 'button' || el.closest('[role="button"]')) {
          return;
        }
        
        // Skip elements with icons
        if (el.querySelector('i, svg')) return;
        
        const text = el.textContent?.trim();
        if (!text || text.length < 10) return;
        
        if (!this.isValidCaption(text)) return;
        
        // Collect the longest text (the actual caption, not speaker name)
        if (text.length > currentCaptionText.length) {
          currentCaptionText = text;
        }
      });
      
      if (!currentCaptionText) return;
      
      const now = Date.now();
      
      // Check if this is an UPDATE of the current caption or a NEW caption
      // Google Meet updates captions in place as speech is recognized
      
      if (this.pendingCaption) {
        // Check if current text is an extension of pending (same caption being updated)
        const isExtension = currentCaptionText.startsWith(this.pendingCaption.substring(0, 20)) ||
                           this.pendingCaption.startsWith(currentCaptionText.substring(0, 20)) ||
                           currentCaptionText.includes(this.pendingCaption.substring(0, 15));
        
        if (isExtension) {
          // Same caption being updated - keep the longer version
          if (currentCaptionText.length >= this.pendingCaption.length) {
            this.pendingCaption = currentCaptionText;
            this.lastCaptionTime = now;
          }
        } else {
          // New caption started - finalize the old one and start new
          this.finalizePendingCaption();
          this.pendingCaption = currentCaptionText;
          this.lastCaptionTime = now;
        }
      } else {
        // First caption
        this.pendingCaption = currentCaptionText;
        this.lastCaptionTime = now;
      }
      
      // If caption hasn't changed for 2 seconds, consider it final
      if (now - this.lastCaptionTime > 2000 && this.pendingCaption) {
        this.finalizePendingCaption();
      }
    };
    
    // Finalize pending caption - add to transcript
    this.finalizePendingCaption = () => {
      if (!this.pendingCaption || this.pendingCaption.length < 10) {
        this.pendingCaption = '';
        return;
      }
      
      // Check if we already have this text (or very similar)
      const isDuplicate = this.transcript.some(t => 
        t.text === this.pendingCaption ||
        t.text.includes(this.pendingCaption) ||
        this.pendingCaption.includes(t.text)
      );
      
      if (!isDuplicate) {
        console.log('✅ Final caption:', this.pendingCaption.substring(0, 60) + '...');
        this.addCaption(this.pendingCaption);
      }
      
      this.pendingCaption = '';
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
  addCaption(text) {
    // Clean up the text
    const cleanText = text
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!cleanText) return;
    
    // Avoid adding duplicate or very similar text
    const lastEntry = this.transcript[this.transcript.length - 1];
    if (lastEntry) {
      // Skip if text is contained in or contains last entry
      if (lastEntry.text.includes(cleanText) || cleanText.includes(lastEntry.text)) {
        return;
      }
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      text: cleanText
    };
    
    this.transcript.push(entry);
    console.log(`📝 Caption: ${cleanText.substring(0, 60)}${cleanText.length > 60 ? '...' : ''}`);
    
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
    
    // Finalize any pending caption
    if (this.pendingCaption) {
      this.finalizePendingCaption();
    }
    
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
    
    // Compile transcript
    const fullTranscript = this.transcript.map(t => t.text).join(' ');
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
