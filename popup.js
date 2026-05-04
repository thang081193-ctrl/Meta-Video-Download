var DEFAULTS = { folder: 'MetaAdLibrary', activated: false };

function loadSettings() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(DEFAULTS, function(s) { resolve(s); });
  });
}

function saveSetting(key, value) {
  var patch = {}; patch[key] = value;
  chrome.storage.local.set(patch);
}

function sanitizeFolder(raw) {
  var s = (raw || '').trim().replace(/\\/g, '/').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '');
  s = s.replace(/^[A-Za-z]:\/?/, '');
  return s || DEFAULTS.folder;
}

function send(tabId, msg) {
  return new Promise(function(resolve) {
    chrome.tabs.sendMessage(tabId, msg, function(r) {
      resolve(chrome.runtime.lastError ? null : r);
    });
  });
}

function sendBg(msg) {
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage(msg, function(r) {
      resolve(chrome.runtime.lastError ? null : r);
    });
  });
}

document.addEventListener('DOMContentLoaded', async function() {
  var $ = function(id) { return document.getElementById(id); };
  var videoCountEl = $('videoCount');
  var adCopiesCountEl = $('adCopiesCount');
  var exportBadge = $('exportBadge');
  var statusEl = $('status');
  var folderEl = $('folder');
  var folderEcho = $('folderEcho');
  var openSettingsLink = $('openSettings');
  var activateBtn = $('activate');
  var autoScrollBtn = $('autoScroll');
  var downloadAllHDBtn = $('downloadAllHD');
  var downloadAllSDBtn = $('downloadAllSD');
  var exportBtn = $('exportAdCopies');
  var clearBtn = $('clearAdCopies');

  var settings = await loadSettings();
  folderEl.value = settings.folder;
  folderEcho.textContent = settings.folder;

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  var onAdLibrary = tab && tab.url && tab.url.indexOf('facebook.com/ads/library') !== -1;

  function setPageDisabled(disabled) {
    [activateBtn, autoScrollBtn, downloadAllHDBtn, downloadAllSDBtn].forEach(function(b) { b.disabled = disabled; });
  }

  async function refreshAdCopiesCount() {
    var r = await sendBg({ action: 'getAdCopiesCount' });
    var n = (r && r.count) || 0;
    adCopiesCountEl.textContent = n;
    exportBadge.textContent = n;
    exportBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
  }

  async function refreshVideoCount() {
    if (!onAdLibrary) { videoCountEl.textContent = '0'; return; }
    var r = await send(tab.id, { action: 'getVideoCount' });
    if (!r) { videoCountEl.textContent = '?'; return; }
    videoCountEl.textContent = r.count;
  }

  function reflectActivated() {
    activateBtn.textContent = settings.activated ? '✓ Buttons active' : '⚡ Activate buttons';
  }

  if (!onAdLibrary) {
    statusEl.textContent = '⚠️ Open Meta Ad Library first';
    setPageDisabled(true);
  } else {
    reflectActivated();
    if (settings.activated) send(tab.id, { action: 'activate' });
    statusEl.textContent = 'Ready';
  }

  refreshAdCopiesCount();
  refreshVideoCount();

  // ---------- handlers ----------

  folderEl.addEventListener('change', function() {
    var v = sanitizeFolder(folderEl.value);
    folderEl.value = v;
    folderEcho.textContent = v;
    saveSetting('folder', v);
  });

  openSettingsLink.addEventListener('click', function(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://settings/downloads' });
  });

  activateBtn.addEventListener('click', async function() {
    var next = !settings.activated;
    settings.activated = next;
    saveSetting('activated', next);
    reflectActivated();
    var r = await send(tab.id, { action: next ? 'activate' : 'deactivate' });
    statusEl.textContent = next
      ? (r ? '🚀 Buttons added to videos' : '⚠️ Reload the page')
      : '🧹 Buttons hidden';
    refreshVideoCount();
  });

  autoScrollBtn.addEventListener('click', async function() {
    autoScrollBtn.disabled = true;
    statusEl.textContent = '📜 Scrolling page...';
    var r = await send(tab.id, { action: 'autoScroll' });
    autoScrollBtn.disabled = false;
    if (r && r.count !== undefined) {
      videoCountEl.textContent = r.count;
      statusEl.textContent = '✅ Loaded ' + r.count + ' videos';
    } else {
      statusEl.textContent = '⚠️ Reload the page';
    }
  });

  downloadAllHDBtn.addEventListener('click', async function() {
    statusEl.textContent = '⏳ Downloading all HD...';
    var r = await send(tab.id, { action: 'downloadAll', preferHD: true });
    if (r && r.started) statusEl.textContent = '🚀 HD downloads started';
    setTimeout(refreshAdCopiesCount, 3000);
  });

  downloadAllSDBtn.addEventListener('click', async function() {
    statusEl.textContent = '⏳ Downloading all SD...';
    var r = await send(tab.id, { action: 'downloadAll', preferHD: false });
    if (r && r.started) statusEl.textContent = '🚀 SD downloads started';
    setTimeout(refreshAdCopiesCount, 3000);
  });

  exportBtn.addEventListener('click', async function() {
    exportBtn.disabled = true;
    statusEl.textContent = '📋 Exporting ad copies...';
    var r = await sendBg({ action: 'exportAdCopies' });
    exportBtn.disabled = false;
    statusEl.textContent = (r && r.success) ? '✅ Ad copies exported' : '⚠️ ' + ((r && r.error) || 'Export failed');
  });

  clearBtn.addEventListener('click', async function() {
    if (!confirm('Clear all saved ad copies?')) return;
    await sendBg({ action: 'clearAdCopies' });
    statusEl.textContent = '🗑 Ad copies cleared';
    refreshAdCopiesCount();
  });

  // Refresh counts whenever popup is opened/refocused
  setInterval(refreshAdCopiesCount, 2000);
});
