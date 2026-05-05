// Background service worker for Meta Ad Library Video Downloader

var DEFAULTS = { folder: 'MetaAdLibrary' };
var AD_COPIES_KEY = 'adCopies';
var AD_COPIES_CAP = 500;

function loadSettings() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(DEFAULTS, function(s) { resolve(s); });
  });
}

function loadAdCopies() {
  return new Promise(function(resolve) {
    var def = {}; def[AD_COPIES_KEY] = [];
    chrome.storage.local.get(def, function(s) { resolve(s[AD_COPIES_KEY] || []); });
  });
}

function saveAdCopies(list) {
  return new Promise(function(resolve) {
    var p = {}; p[AD_COPIES_KEY] = list;
    chrome.storage.local.set(p, resolve);
  });
}

function sanitizeFolder(raw) {
  var s = (raw || '').trim().replace(/\\/g, '/').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '');
  // Strip drive-letter / leading slashes (Chrome only allows paths under Downloads)
  s = s.replace(/^[A-Za-z]:\/?/, '');
  return s || DEFAULTS.folder;
}

// Single path segment — strip filesystem-unsafe chars but keep unicode (Tiếng Việt, 日本語...).
function sanitizeSegment(raw) {
  var s = (raw || '').trim().replace(/[\\\/:*?"<>|]/g, '').replace(/\.+$/, '').replace(/\s+/g, ' ');
  return s || 'Unknown';
}

function startDownload(opts) {
  return new Promise(function(resolve) {
    chrome.downloads.download(opts, function(downloadId) {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve({ success: true, downloadId: downloadId });
    });
  });
}

function textToDataUrl(text) {
  return 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
}

async function recordAdCopy(entry) {
  var list = await loadAdCopies();
  list.push(entry);
  if (list.length > AD_COPIES_CAP) list = list.slice(-AD_COPIES_CAP);
  await saveAdCopies(list);
}

function buildSingleAdText(e) {
  return [
    'Library ID: ' + (e.libId || 'unknown'),
    'Quality: ' + (e.quality || ''),
    'Language: ' + (e.language || 'Unknown'),
    'Saved: ' + (e.savedAt || ''),
    'Source: ' + (e.sourceUrl || ''),
    '',
    'PRIMARY TEXT:',
    e.primary || '(none)',
    '',
    'HEADLINE / CTA:',
    e.headline || '(none)',
    ''
  ].join('\n');
}

function buildExportText(list) {
  var stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  var head = [
    'Meta Ad Library — Ad Copies Export',
    'Generated: ' + stamp + ' UTC',
    'Total entries: ' + list.length,
    ''
  ];
  var body = list.map(function(e, i) {
    return [
      '────────────────────────────────────────',
      '[' + (i + 1) + '] Library ID: ' + (e.libId || 'unknown'),
      'Quality: ' + (e.quality || ''),
      'Language: ' + (e.language || 'Unknown'),
      'Saved: ' + (e.savedAt || ''),
      'Source: ' + (e.sourceUrl || ''),
      '',
      'PRIMARY TEXT:',
      e.primary || '(none)',
      '',
      'HEADLINE / CTA:',
      e.headline || '(none)',
      ''
    ].join('\n');
  });
  return head.concat(body).join('\n');
}

async function handleDownload(request) {
  try {
    var s = await loadSettings();
    var folder = sanitizeFolder(s.folder);
    var lang = sanitizeSegment(request.language);
    var basePath = folder + '/' + lang + '/' + request.filename;

    var videoResult = await startDownload({
      url: request.url,
      filename: basePath,
      saveAs: false,
      conflictAction: 'uniquify'
    });

    if (request.adCopy) {
      var entry = {
        libId: request.adCopy.libId,
        quality: request.adCopy.quality,
        primary: request.adCopy.primary,
        headline: request.adCopy.headline,
        language: lang,
        savedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        sourceUrl: request.adCopy.sourceUrl
      };
      await recordAdCopy(entry);

      // Save a per-video TXT alongside the video so it lands in the same language folder.
      var txtName = request.filename.replace(/\.[^.\/]+$/, '') + '.txt';
      var txtPath = folder + '/' + lang + '/' + txtName;
      await startDownload({
        url: textToDataUrl(buildSingleAdText(entry)),
        filename: txtPath,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    }

    return videoResult;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExport() {
  var list = await loadAdCopies();
  if (!list.length) return { success: false, error: 'No ad copies saved yet' };
  var text = buildExportText(list);
  var s = await loadSettings();
  var folder = sanitizeFolder(s.folder);
  var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
  var filename = folder + '/meta_ad_copies_' + ts + '.txt';
  return await startDownload({
    url: textToDataUrl(text),
    filename: filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'downloadVideo') {
    handleDownload(request).then(sendResponse);
    return true;
  }
  if (request.action === 'getAdCopiesCount') {
    loadAdCopies().then(function(list) { sendResponse({ count: list.length }); });
    return true;
  }
  if (request.action === 'exportAdCopies') {
    handleExport().then(sendResponse);
    return true;
  }
  if (request.action === 'clearAdCopies') {
    saveAdCopies([]).then(function() { sendResponse({ success: true }); });
    return true;
  }
});

chrome.downloads.onChanged.addListener(function(delta) {
  if (delta.state) {
    if (delta.state.current === 'complete') console.log('Download completed:', delta.id);
    else if (delta.state.current === 'interrupted') console.log('Download interrupted:', delta.id);
  }
});

console.log('Meta Ad Library Video Downloader - Background service loaded');
