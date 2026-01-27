/**
 * Anytype Meet Recorder - Popup Script
 */

// Check connection status on load
document.addEventListener('DOMContentLoaded', async () => {
  const saved = await chrome.storage.sync.get([
    'configUrl', 'isConnected', 'serverUrl', 'token',
    'anytypeApiUrl', 'anytypeBearerToken', 'deepseekApiKey'
  ]);
  
  // Show connected if we have API keys (even without valid server token)
  const hasApiKeys = saved.anytypeBearerToken && saved.deepseekApiKey;
  
  if (saved.isConnected && hasApiKeys) {
    showConnectedSection(saved);
    // Verify server connection (won't clear storage on failure)
    if (saved.configUrl) {
      verifyConnection(saved.configUrl);
    }
  } else {
    showSetupSection();
  }
});

function showSetupSection() {
  document.getElementById('setup-section').classList.add('active');
  document.getElementById('connected-section').classList.remove('active');
}

function showConnectedSection(saved) {
  document.getElementById('setup-section').classList.remove('active');
  document.getElementById('connected-section').classList.add('active');
  
  // Show config info
  const infoEl = document.getElementById('config-info');
  const parts = [];
  
  if (saved.serverUrl) {
    try {
      parts.push(`🌐 Сервер: ${new URL(saved.serverUrl).host}`);
    } catch (e) {
      parts.push(`🌐 Сервер: ${saved.serverUrl}`);
    }
  }
  if (saved.token) {
    parts.push(`🔐 Токен: ${saved.token.substring(0, 8)}...`);
  }
  if (saved.anytypeBearerToken) {
    parts.push(`✅ Anytype API: настроен`);
  }
  if (saved.deepseekApiKey) {
    parts.push(`✅ DeepSeek API: настроен`);
  }
  
  infoEl.innerHTML = parts.join('<br>') || 'Загрузка...';
}

// Load config from URL
document.getElementById('loadConfigBtn').addEventListener('click', async () => {
  const configUrl = document.getElementById('configUrl').value.trim();
  
  if (!configUrl) {
    showStatus('setup-status', 'Please enter the config URL', 'error');
    return;
  }
  
  if (!configUrl.includes('/api/extension/config/')) {
    showStatus('setup-status', 'Invalid URL format. Get it from /extension command in Telegram', 'error');
    return;
  }
  
  showStatus('setup-status', 'Loading config...', 'info');
  
  try {
    const response = await fetch(configUrl);
    
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid or expired token. Get a new one from Telegram.');
      }
      throw new Error(`Server error: ${response.status}`);
    }
    
    const config = await response.json();
    
    if (!config.anytypeBearerToken || !config.deepseekApiKey) {
      throw new Error('Config is incomplete. Check bot configuration.');
    }
    
    // Extract server URL and token
    const url = new URL(configUrl);
    const serverUrl = `${url.protocol}//${url.host}`;
    const token = configUrl.split('/config/')[1];
    
    // Save config
    await chrome.storage.sync.set({
      configUrl,
      serverUrl,
      token,
      isConnected: true,
      ...config
    });
    
    showStatus('setup-status', 'Connected successfully!', 'success');
    
    setTimeout(() => {
      showConnectedSection({ serverUrl, token });
    }, 1000);
    
  } catch (error) {
    console.error('Load config error:', error);
    showStatus('setup-status', error.message, 'error');
  }
});

// Disconnect
document.getElementById('disconnectBtn').addEventListener('click', async () => {
  await chrome.storage.sync.clear();
  showSetupSection();
  showStatus('setup-status', 'Disconnected', 'info');
});

// Verify connection (but don't clear API keys on failure)
async function verifyConnection(configUrl) {
  try {
    const response = await fetch(configUrl);
    if (!response.ok) {
      // Token expired - but keep API keys for direct mode
      console.log('Server token expired, but keeping API keys for direct mode');
      // Just update the status, don't clear storage
      const infoEl = document.getElementById('config-info');
      const saved = await chrome.storage.sync.get(['serverUrl', 'anytypeApiUrl']);
      if (saved.anytypeApiUrl) {
        infoEl.innerHTML = `
          ⚠️ Сервер: токен истёк<br>
          ✅ API ключи: сохранены<br>
          <small>Расширение будет работать напрямую</small>
        `;
      }
    }
  } catch (error) {
    console.error('Connection verify error:', error);
    // Network error - still keep the stored config
  }
}

function showStatus(elementId, message, type) {
  const status = document.getElementById(elementId);
  status.textContent = message;
  status.className = 'status ' + type;
  
  if (type !== 'info') {
    setTimeout(() => {
      status.className = 'status';
    }, 5000);
  }
}

// Listen for storage changes (auto-connect from connect page)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.isConnected) {
    if (changes.isConnected.newValue === true) {
      // Reload the popup state
      chrome.storage.sync.get(['serverUrl', 'token']).then(saved => {
        showConnectedSection(saved);
        showStatus('connected-status', 'Auto-connected!', 'success');
      });
    }
  }
});
