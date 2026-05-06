(function() {
  'use strict';

  var SCAN_INTERVAL = 2000;
  var PROCESSED_ATTR = 'data-malvd-processed';
  var IMG_PROCESSED_ATTR = 'data-malvd-img-processed';
  var MIN_IMG_DIM = 200;            // px — anything smaller is an icon/avatar
  var hdUrlMap = {};
  var active = false;
  var scanTimer = null;
  var bodyObserver = null;
  var batchStopRequested = false;
  var batchRunning = false;

  // i18n: supported text variants (English + Vietnamese)
  var I18N_SETTINGS_LABELS = ['Settings', 'Cài đặt'];
  var I18N_QUALITY_TEXTS = ['Quality', 'Chất lượng'];
  var I18N_LIBRARY_ID_PREFIXES = ['Library ID:', 'ID Thư viện:'];
  var I18N_SEE_DETAILS_TEXTS = ['See summary details', 'See ad details', 'Xem chi tiết tóm tắt', 'Xem chi tiết quảng cáo'];

  // ISO 639-1 → folder name (native spelling). Detected via chrome.i18n.detectLanguage.
  var LANG_NAMES = {
    en: 'English',
    de: 'Deutsch',
    vi: 'Tiếng Việt',
    fr: 'Français',
    es: 'Español',
    it: 'Italiano',
    pt: 'Português',
    ja: '日本語',
    ko: '한국어',
    zh: '中文',
    th: 'ไทย',
    id: 'Bahasa Indonesia'
  };
  var LANG_UNKNOWN = 'Unknown';

  // ==================== UTILITY ====================

  function getVideoQuality(videoEl) {
    try {
      var url = new URL(videoEl.src);
      var efg = url.searchParams.get('efg');
      if (!efg) return 'unknown';
      var decoded = atob(efg);
      if (decoded.indexOf('720') !== -1 || decoded.indexOf('1080') !== -1 || decoded.indexOf('dash_h264') !== -1) return 'HD';
      if (decoded.indexOf('360') !== -1 || decoded.indexOf('sve_sd') !== -1) return 'SD';
      return 'SD';
    } catch (e) {
      return 'unknown';
    }
  }

  function getVideoResolution(videoEl) {
    try {
      var url = new URL(videoEl.src);
      var efg = url.searchParams.get('efg');
      if (!efg) return '';
      var decoded = atob(efg);
      var match = decoded.match(/(\d{3,4})p/);
      if (match) return match[1] + 'p';
      if (decoded.indexOf('720') !== -1) return '720p';
      if (decoded.indexOf('1080') !== -1) return '1080p';
      if (decoded.indexOf('360') !== -1) return '360p';
      return '';
    } catch (e) {
      return '';
    }
  }

  function findCardContainer(videoEl) {
    var el = videoEl;
    for (var i = 0; i < 25; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      var hasLibraryId = I18N_LIBRARY_ID_PREFIXES.some(function(prefix) { return el.textContent.indexOf(prefix) !== -1; });
      if (el.offsetWidth > 340 && el.offsetWidth < 420 && hasLibraryId) {
        var style = window.getComputedStyle(el);
        if (style.boxShadow !== 'none' || style.borderRadius !== '0px') {
          return el;
        }
      }
    }
    return null;
  }

  function getLibraryId(cardEl) {
    if (!cardEl) return 'video';
    var match = cardEl.textContent.match(/(?:Library ID|ID Thư viện):\s*(\d+)/);
    return match ? match[1] : 'video';
  }

  function generateFilename(cardEl, quality) {
    var libId = getLibraryId(cardEl);
    var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    return 'meta_ad_' + libId + '_' + quality + '_' + ts + '.mp4';
  }

  function generateImageFilename(cardEl, ext) {
    var libId = getLibraryId(cardEl);
    var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    return 'meta_ad_' + libId + '_image_' + ts + '.' + (ext || 'jpg');
  }

  // ==================== IMAGE HELPERS ====================

  // Pick the highest-resolution variant from <img srcset="url 1x, url 2x, url 3x">.
  // Falls back to .src when srcset is empty.
  function getHighestResImageUrl(imgEl) {
    var ss = (imgEl.getAttribute('srcset') || '').trim();
    if (ss) {
      var best = null, bestDensity = -1;
      ss.split(',').forEach(function(part) {
        var bits = part.trim().split(/\s+/);
        if (!bits[0]) return;
        var d = 1;
        if (bits[1]) {
          if (bits[1].indexOf('w') !== -1) d = parseFloat(bits[1]);          // width descriptor
          else if (bits[1].indexOf('x') !== -1) d = parseFloat(bits[1]);     // density descriptor
        }
        if (!isNaN(d) && d > bestDensity) { bestDensity = d; best = bits[0]; }
      });
      if (best) return best;
    }
    return imgEl.currentSrc || imgEl.src;
  }

  function getImageExt(url) {
    var m = (url || '').split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  function isAdCreativeImage(imgEl) {
    if (!imgEl || !imgEl.src) return false;
    if (imgEl.hasAttribute(IMG_PROCESSED_ATTR)) return false;
    if (imgEl.offsetWidth < MIN_IMG_DIM || imgEl.offsetHeight < MIN_IMG_DIM) return false;
    // Skip our own UI
    var p = imgEl.parentElement;
    while (p) {
      if (p.classList && (p.classList.contains('malvd-dropdown-wrapper') || p.classList.contains('malvd-notification'))) return false;
      p = p.parentElement;
    }
    return true;
  }

  // ==================== AD COPY EXTRACTION ====================

  var BOILERPLATE_PATTERNS = [
    /^Active$/i, /^Inactive$/i, /^Đang hoạt động$/i, /^Không hoạt động$/i,
    /^Library ID:?/i, /^ID Thư viện:?/i,
    /^Started running on/i, /^Đã bắt đầu chạy/i,
    /^Platforms?$/i, /^Nền tảng$/i,
    /^See ad details$/i, /^See summary details$/i, /^Xem chi tiết/i,
    /^Sponsored$/i, /^Được tài trợ$/i,
    /^ID:\s*\d+$/i,
    /^Download HD$/i, /^Download SD$/i,
    /^[⬇▾🎬📹]+$/,
    /^\s*$/
  ];

  function isBoilerplate(t) {
    return BOILERPLATE_PATTERNS.some(function(p) { return p.test(t); });
  }

  // Split card text into "before video" (primary) and "after video" (headline + cta block).
  function extractAdText(cardEl, videoEl) {
    if (!cardEl) return { primary: '', headline: '' };
    var walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT);
    var before = [], after = [], seen = {};
    while (walker.nextNode()) {
      var n = walker.currentNode;
      // Skip text inside our own injected UI
      var p = n.parentElement;
      while (p && p !== cardEl) {
        if (p.classList && (p.classList.contains('malvd-dropdown-wrapper') || p.classList.contains('malvd-notification'))) { p = null; break; }
        p = p.parentElement;
      }
      if (!p) continue;

      var txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length < 2) continue;
      if (isBoilerplate(txt)) continue;
      if (seen[txt]) continue;
      seen[txt] = true;

      var pos = videoEl.compareDocumentPosition(n);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) after.push(txt);
      else before.push(txt);
    }
    return {
      primary: before.join('\n'),
      headline: after.join('\n')
    };
  }

  function buildAdCopy(cardEl, videoEl, quality) {
    var t = extractAdText(cardEl, videoEl);
    return {
      libId: getLibraryId(cardEl),
      quality: quality,
      primary: t.primary,
      headline: t.headline,
      sourceUrl: location.href
    };
  }

  // Detect primary text language → native folder name. Falls back to "Unknown"
  // when text is too short, detection is unreliable, or top match is unmapped.
  function detectLanguage(text) {
    return new Promise(function(resolve) {
      var clean = (text || '').replace(/\s+/g, ' ').trim();
      if (clean.length < 8 || !chrome.i18n || !chrome.i18n.detectLanguage) {
        resolve(LANG_UNKNOWN); return;
      }
      try {
        chrome.i18n.detectLanguage(clean, function(result) {
          if (!result || !result.languages || !result.languages.length) {
            resolve(LANG_UNKNOWN); return;
          }
          var top = result.languages[0];
          if (!top || top.percentage < 30) { resolve(LANG_UNKNOWN); return; }
          var base = (top.language || '').split('-')[0].toLowerCase();
          resolve(LANG_NAMES[base] || LANG_UNKNOWN);
        });
      } catch (e) {
        resolve(LANG_UNKNOWN);
      }
    });
  }

  // ==================== HD SWITCH ====================

  function getHDUrl(videoEl) {
    return new Promise(function(resolve) {
      var cardEl = findCardContainer(videoEl);
      var libId = getLibraryId(cardEl);

      if (hdUrlMap[libId]) { resolve(hdUrlMap[libId]); return; }
      if (getVideoQuality(videoEl) === 'HD') {
        hdUrlMap[libId] = videoEl.src;
        resolve(videoEl.src);
        return;
      }

      var wasPaused = videoEl.paused;
      var wasCurrentTime = videoEl.currentTime;
      var wasMuted = videoEl.muted;

      videoEl.muted = true;
      var playPromise = videoEl.play();

      function afterPlay() {
        var settingsSelector = I18N_SETTINGS_LABELS.map(function(label) {
          return 'div[aria-label="' + label + '"][role="button"]';
        }).join(', ');
        var settingsBtn = null;
        var el = videoEl.parentElement;
        for (var i = 0; i < 10; i++) {
          if (!el) break;
          settingsBtn = el.querySelector(settingsSelector);
          if (settingsBtn) break;
          el = el.parentElement;
        }

        if (!settingsBtn) {
          videoEl.muted = wasMuted;
          if (wasPaused) { videoEl.pause(); videoEl.currentTime = wasCurrentTime; }
          resolve(videoEl.src);
          return;
        }

        var resolved = false;
        var srcObserver = new MutationObserver(function() {
          if (getVideoQuality(videoEl) === 'HD' && !resolved) {
            resolved = true;
            srcObserver.disconnect();
            hdUrlMap[libId] = videoEl.src;
            videoEl.muted = wasMuted;
            if (wasPaused) { videoEl.pause(); videoEl.currentTime = wasCurrentTime; }
            resolve(videoEl.src);
          }
        });
        srcObserver.observe(videoEl, { attributes: true, attributeFilter: ['src'] });

        settingsBtn.click();

        setTimeout(function() {
          var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          var qualityNode = null;
          while (walker.nextNode()) {
            if (I18N_QUALITY_TEXTS.indexOf(walker.currentNode.textContent.trim()) !== -1) {
              qualityNode = walker.currentNode;
              break;
            }
          }

          if (!qualityNode) {
            srcObserver.disconnect();
            videoEl.muted = wasMuted;
            if (wasPaused) { videoEl.pause(); videoEl.currentTime = wasCurrentTime; }
            resolve(videoEl.src);
            return;
          }

          var qualityTarget = qualityNode.parentElement.closest('div[tabindex]') || qualityNode.parentElement;
          qualityTarget.click();

          setTimeout(function() {
            var walker2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var hdTextNode = null;
            while (walker2.nextNode()) {
              if (walker2.currentNode.textContent.trim().toLowerCase() === 'hd') {
                hdTextNode = walker2.currentNode;
                break;
              }
            }

            if (!hdTextNode) {
              srcObserver.disconnect();
              videoEl.muted = wasMuted;
              if (wasPaused) { videoEl.pause(); videoEl.currentTime = wasCurrentTime; }
              resolve(videoEl.src);
              return;
            }

            var hdTarget = hdTextNode.parentElement.closest('div[tabindex]') || hdTextNode.parentElement;
            hdTarget.click();

            setTimeout(function() {
              if (!resolved) {
                resolved = true;
                srcObserver.disconnect();
                if (getVideoQuality(videoEl) === 'HD') hdUrlMap[libId] = videoEl.src;
                videoEl.muted = wasMuted;
                if (wasPaused) { videoEl.pause(); videoEl.currentTime = wasCurrentTime; }
                resolve(videoEl.src);
              }
            }, 5000);
          }, 600);
        }, 600);
      }

      if (playPromise && playPromise.then) {
        playPromise.then(function() { setTimeout(afterPlay, 500); }).catch(function() { resolve(videoEl.src); });
      } else {
        setTimeout(afterPlay, 500);
      }
    });
  }

  // ==================== DOWNLOAD ====================

  function doDownload(payload, silent) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage(Object.assign({ action: 'downloadVideo' }, payload), function(response) {
        if (response && response.success) {
          if (!silent) showNotification('✅ Saved: ' + payload.filename, 'success');
        } else {
          // No new-tab fallback — silent in batch, error toast in single mode.
          var err = (response && response.error) || 'Download failed';
          console.warn('[MALVD] Download failed for', payload.filename, err);
          if (!silent) showNotification('⚠️ ' + err, 'error');
        }
        resolve(response);
      });
    });
  }

  async function downloadVideoHD(videoEl, silent) {
    var cardEl = findCardContainer(videoEl);
    if (!silent) showNotification('⏳ Switching to HD...', 'info');
    var hdUrl = await getHDUrl(videoEl);
    var quality = getVideoQuality(videoEl);
    var filename = generateFilename(cardEl, quality);
    var adCopy = buildAdCopy(cardEl, videoEl, quality);
    var language = await detectLanguage(adCopy.primary);
    return doDownload({
      url: hdUrl,
      filename: filename,
      libId: getLibraryId(cardEl),
      language: language,
      adCopy: adCopy
    }, silent);
  }

  async function downloadVideoSD(videoEl, silent) {
    var cardEl = findCardContainer(videoEl);
    var quality = getVideoQuality(videoEl);
    var res = getVideoResolution(videoEl);
    var filename = generateFilename(cardEl, quality + (res ? '_' + res : ''));
    var adCopy = buildAdCopy(cardEl, videoEl, quality);
    var language = await detectLanguage(adCopy.primary);
    return doDownload({
      url: videoEl.src,
      filename: filename,
      libId: getLibraryId(cardEl),
      language: language,
      adCopy: adCopy
    }, silent);
  }

  async function downloadImage(imgEl, silent) {
    var cardEl = findCardContainer(imgEl);
    var url = getHighestResImageUrl(imgEl);
    var ext = getImageExt(url);
    var filename = generateImageFilename(cardEl, ext);
    var adCopy = buildAdCopy(cardEl, imgEl, 'IMG');
    var language = await detectLanguage(adCopy.primary);
    return doDownload({
      url: url,
      filename: filename,
      libId: getLibraryId(cardEl),
      language: language,
      adCopy: adCopy
    }, silent);
  }

  // ==================== NOTIFICATION ====================

  function showNotification(message, type) {
    type = type || 'info';
    var existing = document.querySelector('.malvd-notification');
    if (existing) existing.remove();

    var notification = document.createElement('div');
    notification.className = 'malvd-notification';
    notification.textContent = message;

    var colors = { success: '#00c853', warning: '#ff9800', error: '#f44336', info: '#6a3fbf' };

    notification.style.cssText = [
      'position:fixed', 'top:20px', 'right:20px', 'z-index:999999',
      'padding:12px 24px', 'background:' + (colors[type] || colors.info),
      'color:white', 'border-radius:8px', 'font-size:14px', 'font-weight:600',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)', 'animation:malvd-slideIn 0.3s ease',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif'
    ].join(';');

    document.body.appendChild(notification);
    setTimeout(function() { notification.remove(); }, 3000);
  }

  // ==================== DROPDOWN BUTTON ====================

  function createDropdownButton(videoEl) {
    var wrapper = document.createElement('div');
    wrapper.className = 'malvd-dropdown-wrapper';

    var mainBtn = document.createElement('button');
    mainBtn.className = 'malvd-main-btn';
    mainBtn.innerHTML = '⬇ Download HD';
    mainBtn.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      downloadVideoHD(videoEl);
    });

    var arrowBtn = document.createElement('button');
    arrowBtn.className = 'malvd-arrow-btn';
    arrowBtn.innerHTML = '▾';
    arrowBtn.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      var menu = wrapper.querySelector('.malvd-dropdown-menu');
      if (menu.style.display === 'block') {
        menu.style.display = 'none';
      } else {
        document.querySelectorAll('.malvd-dropdown-menu').forEach(function(m) { m.style.display = 'none'; });
        menu.style.display = 'block';
      }
    });

    var menu = document.createElement('div');
    menu.className = 'malvd-dropdown-menu';
    menu.style.display = 'none';

    var hdItem = document.createElement('div');
    hdItem.className = 'malvd-menu-item';
    hdItem.innerHTML = '🎬 Download HD (720p)';
    hdItem.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      menu.style.display = 'none';
      downloadVideoHD(videoEl);
    });

    var sdItem = document.createElement('div');
    sdItem.className = 'malvd-menu-item';
    sdItem.innerHTML = '📹 Download SD (360p)';
    sdItem.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      menu.style.display = 'none';
      downloadVideoSD(videoEl);
    });

    menu.appendChild(hdItem);
    menu.appendChild(sdItem);

    wrapper.appendChild(mainBtn);
    wrapper.appendChild(arrowBtn);
    wrapper.appendChild(menu);

    return wrapper;
  }

  // ==================== IMAGE BUTTON ====================

  function createImageButton(imgEl) {
    var wrapper = document.createElement('div');
    wrapper.className = 'malvd-dropdown-wrapper';

    var mainBtn = document.createElement('button');
    mainBtn.className = 'malvd-main-btn';
    mainBtn.style.borderRadius = '6px';
    mainBtn.innerHTML = '🖼 Download image';
    mainBtn.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      downloadImage(imgEl);
    });

    wrapper.appendChild(mainBtn);
    return wrapper;
  }

  function scanImagesInCard(cardEl, videoEl) {
    // Return ad-creative images inside this card. Skip ones colocated with the
    // video (avatars, thumbnails) — those belong to the video flow.
    var imgs = cardEl.querySelectorAll('img');
    var creatives = [];
    for (var i = 0; i < imgs.length; i++) {
      if (isAdCreativeImage(imgs[i])) creatives.push(imgs[i]);
    }
    return creatives;
  }

  // ==================== SCANNER ====================

  function scanAndAddButtons() {
    if (!active) return;
    var videos = document.querySelectorAll('video');

    videos.forEach(function(videoEl) {
      if (!videoEl.src || videoEl.hasAttribute(PROCESSED_ATTR)) return;

      var cardEl = findCardContainer(videoEl);
      if (!cardEl) return;

      videoEl.setAttribute(PROCESSED_ATTR, 'true');

      var dropdown = createDropdownButton(videoEl);

      var headerArea = null;
      var inner = cardEl.children[0] || cardEl;
      for (var i = 0; i < inner.children.length; i++) {
        var child = inner.children[i];
        var text = child.textContent || '';
        var isDetailsRow = I18N_SEE_DETAILS_TEXTS.some(function(t) { return text.indexOf(t) !== -1; });
        if (isDetailsRow) { headerArea = child; break; }
      }

      if (headerArea) {
        headerArea.style.display = 'flex';
        headerArea.style.alignItems = 'center';
        headerArea.style.gap = '8px';
        headerArea.style.justifyContent = 'space-between';
        headerArea.appendChild(dropdown);
      } else {
        var firstChild = inner.firstChild;
        if (firstChild) inner.insertBefore(dropdown, firstChild.nextSibling);
        else inner.appendChild(dropdown);
      }
    });

    // Image-only ad cards: walk all large images and tag the ones that live in
    // a card without a video attached (video cards already handled above).
    var imgs = document.querySelectorAll('img');
    imgs.forEach(function(imgEl) {
      if (!isAdCreativeImage(imgEl)) return;
      var cardEl = findCardContainer(imgEl);
      if (!cardEl) return;
      if (cardEl.querySelector('video[src]')) return; // skip video cards

      imgEl.setAttribute(IMG_PROCESSED_ATTR, 'true');

      var btn = createImageButton(imgEl);
      var inner = cardEl.children[0] || cardEl;
      var headerArea = null;
      for (var j = 0; j < inner.children.length; j++) {
        var child = inner.children[j];
        var text = child.textContent || '';
        var isDetailsRow = I18N_SEE_DETAILS_TEXTS.some(function(t) { return text.indexOf(t) !== -1; });
        if (isDetailsRow) { headerArea = child; break; }
      }
      if (headerArea) {
        headerArea.style.display = 'flex';
        headerArea.style.alignItems = 'center';
        headerArea.style.gap = '8px';
        headerArea.style.justifyContent = 'space-between';
        // Avoid double-injecting if a button is already in this row.
        if (!headerArea.querySelector('.malvd-dropdown-wrapper')) {
          headerArea.appendChild(btn);
        }
      } else {
        var firstChild = inner.firstChild;
        if (firstChild) inner.insertBefore(btn, firstChild.nextSibling);
        else inner.appendChild(btn);
      }
    });
  }

  function removeAllButtons() {
    document.querySelectorAll('.malvd-dropdown-wrapper').forEach(function(w) { w.remove(); });
    document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach(function(v) { v.removeAttribute(PROCESSED_ATTR); });
    document.querySelectorAll('[' + IMG_PROCESSED_ATTR + ']').forEach(function(v) { v.removeAttribute(IMG_PROCESSED_ATTR); });
  }

  // ==================== ACTIVATION ====================

  function activate() {
    if (active) { scanAndAddButtons(); return; }
    active = true;
    scanAndAddButtons();
    if (!scanTimer) scanTimer = setInterval(scanAndAddButtons, SCAN_INTERVAL);
    if (!bodyObserver) {
      bodyObserver = new MutationObserver(function() { setTimeout(scanAndAddButtons, 500); });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function deactivate() {
    active = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    removeAllButtons();
  }

  // ==================== AUTO-SCROLL ====================

  function countVideos() { return document.querySelectorAll('video').length; }

  function findScrollRoot() {
    // Ad Library uses an inner scrollable column on most layouts; fall back to window.
    var candidates = document.querySelectorAll('[role="main"], [data-pagelet*="Ads"], div');
    var best = null, bestScroll = 0;
    for (var i = 0; i < candidates.length && i < 800; i++) {
      var el = candidates[i];
      var diff = el.scrollHeight - el.clientHeight;
      if (diff > bestScroll && el.clientHeight > 300) {
        var style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          best = el; bestScroll = diff;
        }
      }
    }
    return best;
  }

  function scrollToBottom() {
    var root = findScrollRoot();
    if (root) root.scrollTop = root.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  var scrolling = false;
  async function autoScroll() {
    if (scrolling) return countVideos();
    scrolling = true;
    showNotification('📜 Auto-loading all videos...', 'info');
    var maxAttempts = 80;
    var stableLimit = 4;
    var stableTicks = 0;
    var lastCount = countVideos();
    for (var i = 0; i < maxAttempts; i++) {
      scrollToBottom();
      await new Promise(function(r) { setTimeout(r, 1500); });
      var c = countVideos();
      if (c === lastCount) {
        stableTicks++;
        if (stableTicks >= stableLimit) break;
      } else {
        stableTicks = 0;
        lastCount = c;
      }
    }
    scrolling = false;
    showNotification('✅ Loaded ' + lastCount + ' videos', 'success');
    if (active) scanAndAddButtons();
    return lastCount;
  }

  // ==================== DOWNLOAD ALL ====================

  // Single sticky progress toast that updates in place during batch downloads.
  var batchToast = null;
  function showBatchProgress(message, type) {
    type = type || 'info';
    var colors = { success: '#00c853', warning: '#ff9800', error: '#f44336', info: '#6a3fbf' };
    if (!batchToast || !batchToast.isConnected) {
      batchToast = document.createElement('div');
      batchToast.className = 'malvd-notification malvd-batch-toast';
      batchToast.style.cssText = [
        'position:fixed', 'top:20px', 'right:20px', 'z-index:999999',
        'padding:12px 24px', 'color:white', 'border-radius:8px',
        'font-size:14px', 'font-weight:600',
        'box-shadow:0 4px 12px rgba(0,0,0,0.3)', 'animation:malvd-slideIn 0.3s ease',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
        'min-width:220px', 'text-align:center'
      ].join(';');
      document.body.appendChild(batchToast);
    }
    batchToast.style.background = colors[type] || colors.info;
    batchToast.textContent = message;
  }
  function hideBatchProgress(delay) {
    var t = batchToast;
    if (!t) return;
    setTimeout(function() { if (t && t.isConnected) t.remove(); if (batchToast === t) batchToast = null; }, delay || 2500);
  }

  // Collect image-ad creatives currently rendered. One per image-only card so
  // we don't grab carousels' duplicates or video-card thumbnails.
  function collectAdImages() {
    var seen = {};
    var out = [];
    var imgs = document.querySelectorAll('img');
    imgs.forEach(function(imgEl) {
      if (imgEl.offsetWidth < MIN_IMG_DIM || imgEl.offsetHeight < MIN_IMG_DIM) return;
      var cardEl = findCardContainer(imgEl);
      if (!cardEl) return;
      if (cardEl.querySelector('video[src]')) return;
      var libId = getLibraryId(cardEl);
      if (seen[libId]) return;
      seen[libId] = true;
      out.push(imgEl);
    });
    return out;
  }

  window.malvdStopBatch = function() {
    if (!batchRunning) return false;
    batchStopRequested = true;
    showBatchProgress('🛑 Stopping after current item...', 'warning');
    return true;
  };

  window.malvdDownloadAll = async function(preferHD) {
    if (batchRunning) { showNotification('⚠️ A batch is already running', 'warning'); return; }
    var videos = document.querySelectorAll('video[src]');
    var images = collectAdImages();
    var totalV = videos.length, totalI = images.length;
    var total = totalV + totalI;
    if (!total) { showNotification('⚠️ No videos or images found', 'warning'); return; }

    batchRunning = true;
    batchStopRequested = false;
    var label = preferHD ? 'HD' : 'SD';
    showBatchProgress('📦 Preparing ' + totalV + ' videos + ' + totalI + ' images...', 'info');

    var ok = 0, fail = 0, idx = 0, stopped = false;
    try {
      for (var i = 0; i < totalV; i++) {
        if (batchStopRequested) { stopped = true; break; }
        idx++;
        showBatchProgress('📦 ' + idx + '/' + total + ' video (' + label + ')...', 'info');
        try {
          var r = preferHD
            ? await downloadVideoHD(videos[i], true)
            : await downloadVideoSD(videos[i], true);
          if (r && r.success) ok++; else fail++;
        } catch (e) { fail++; }
        if (batchStopRequested) { stopped = true; break; }
        await new Promise(function(r) { setTimeout(r, 1200); });
      }

      if (!stopped) {
        for (var k = 0; k < totalI; k++) {
          if (batchStopRequested) { stopped = true; break; }
          idx++;
          showBatchProgress('📦 ' + idx + '/' + total + ' image...', 'info');
          try {
            var r2 = await downloadImage(images[k], true);
            if (r2 && r2.success) ok++; else fail++;
          } catch (e2) { fail++; }
          if (batchStopRequested) { stopped = true; break; }
          await new Promise(function(r) { setTimeout(r, 600); });
        }
      }
    } finally {
      batchRunning = false;
      batchStopRequested = false;
    }

    var prefix = stopped ? '🛑 Stopped' : '✅ Done';
    var summary = prefix + ': ' + ok + '/' + total + (fail ? ' (' + fail + ' failed)' : '');
    showBatchProgress(summary, stopped ? 'warning' : (fail ? 'warning' : 'success'));
    hideBatchProgress(4000);
  };

  // ==================== INIT ====================

  var style = document.createElement('style');
  style.textContent = '@keyframes malvd-slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }';
  document.head.appendChild(style);

  document.addEventListener('click', function() {
    document.querySelectorAll('.malvd-dropdown-menu').forEach(function(m) { m.style.display = 'none'; });
  });

  // Restore previous activation state on page (re)load
  try {
    chrome.storage.local.get({ activated: false }, function(s) {
      if (s.activated) activate();
    });
  } catch (e) {}

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'getVideoCount') {
      sendResponse({
        count: document.querySelectorAll('video[src]').length,
        imageCount: collectAdImages().length,
        active: active
      });
    } else if (request.action === 'activate') {
      activate();
      sendResponse({ active: true });
    } else if (request.action === 'deactivate') {
      deactivate();
      sendResponse({ active: false });
    } else if (request.action === 'downloadAll') {
      window.malvdDownloadAll(request.preferHD !== false);
      sendResponse({ started: true, running: batchRunning });
    } else if (request.action === 'stopBatch') {
      var ok = window.malvdStopBatch();
      sendResponse({ stopped: ok, running: batchRunning });
    } else if (request.action === 'getBatchState') {
      sendResponse({ running: batchRunning });
    } else if (request.action === 'rescan') {
      scanAndAddButtons();
      sendResponse({ done: true });
    } else if (request.action === 'autoScroll') {
      autoScroll().then(function(count) { sendResponse({ count: count }); });
      return true;
    }
    return true;
  });

  console.log('🎬 Meta Ad Library Video Downloader v1.1 loaded (popup-controlled)');
})();
