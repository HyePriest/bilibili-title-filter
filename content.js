(() => {
  'use strict';

  if (location.pathname !== '/' && location.pathname !== '/index.html') {
    return;
  }

  const SYNC_KEYS = {
    enabled: 'btfEnabled',
    titleKeywords: 'btfTitleKeywords',
    upKeywords: 'btfUpKeywords',
    categoryKeywords: 'btfCategoryKeywords',
    tagKeywords: 'btfTagKeywords',
    specialTypes: 'btfSpecialTypes',
    specialTypesVersion: 'btfSpecialTypesVersion',
    qualityEnabled: 'btfQualityEnabled',
    qualityMode: 'btfQualityMode',
    legacyTitleKeywords: 'blockedKeywords'
  };
  const LOCAL_KEYS = {
    blockedUpNames: 'btfBlockedUpNames',
    blockedUps: 'btfBlockedUps',
    blockedOrder: 'btfBlockedOrder',
    history: 'btfBlockedHistory',
    qualityCache: 'btfQualityCache',
    seenVideos: 'btfSeenVideos',
    sharedMeta: 'btfSharedFileMeta'
  };
  const DEFAULTS = {
    titleKeywords: ['大型纪录片'],
    upKeywords: ['纪录片', '记录片'],
    categoryKeywords: [],
    tagKeywords: [],
    specialTypes: BTFSpecialTypes.DEFAULT_TYPES,
    qualityEnabled: true,
    qualityMode: 'standard'
  };
  const HISTORY_LIMIT = 100;
  const SPECIAL_TYPES_VERSION = BTFSpecialTypes.VERSION;
  const CACHE_LIMIT = 500;
  const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const ERROR_CACHE_AGE = 10 * 60 * 1000;
  const SEEN_LIMIT = 1000;
  const MAX_QUALITY_FETCHES = 4;
  const FILTER_SCOPE_SELECTOR = 'main';
  const NATIVE_DISLIKE_REQUEST_EVENT = 'btf-native-dislike-request';
  const NATIVE_DISLIKE_RESPONSE_EVENT = 'btf-native-dislike-response';
  const CARD_SELECTOR = [
    '.feed-card',
    '.bili-feed-card',
    '.bili-video-card',
    '.video-card',
    '.floor-single-card',
    '.floor-card',
    '.small-item',
    '.rank-item',
    '.popular-video-card',
    '.video-page-card-small'
  ].join(',');
  const MEDIA_LINK_SELECTOR = [
    'a[href*="/video/"]',
    'a[href*="/cheese/"]',
    'a[href*="cheese.bilibili.com"]',
    'a[href*="live.bilibili.com"]'
  ].join(',');
  const BADGE_CANDIDATE_SELECTOR = [
    '[class*="badge"]',
    '[class*="tag"]',
    '[class*="label"]',
    '[data-badge]',
    '[data-tag]',
    '[data-label]'
  ].join(',');
  const GENERIC_SPECIAL_BADGE_SELECTOR = [
    '.bili-video-card__image--badge',
    '[class*="image"][class*="badge"]',
    '[class*="cover"][class*="badge"]',
    '[class*="pic"][class*="badge"]'
  ].join(',');
  const TITLE_SELECTORS = [
    '.bili-video-card__info--tit',
    '.video-name',
    'a.title',
    'a[href*="/video/"][title]',
    '.title'
  ];
  const OWNER_SELECTORS = [
    '.bili-video-card__info--author',
    'a.bili-video-card__info--owner',
    'a.up-name',
    '.up-name',
    'a[href*="space.bilibili.com/"]'
  ];
  const TITLE_SELECTOR = TITLE_SELECTORS.join(',');
  const OWNER_SELECTOR = OWNER_SELECTORS.join(',');
  const MUTATION_RELEVANT_SELECTOR = [
    CARD_SELECTOR,
    MEDIA_LINK_SELECTOR,
    GENERIC_SPECIAL_BADGE_SELECTOR
  ].join(',');
  let settings = {
    enabled: true,
    titleKeywords: DEFAULTS.titleKeywords,
    upKeywords: DEFAULTS.upKeywords,
    categoryKeywords: DEFAULTS.categoryKeywords,
    tagKeywords: DEFAULTS.tagKeywords,
    specialTypes: DEFAULTS.specialTypes,
    qualityEnabled: DEFAULTS.qualityEnabled,
    qualityMode: DEFAULTS.qualityMode,
    blockedUpNames: [],
    blockedUps: []
  };
  let currentRecords = [];
  let history = [];
  let scheduled = false;
  let filterFrame = 0;
  let fullScanRequested = true;
  let historySaveTimer = 0;
  let cacheSaveTimer = 0;
  let seenSaveTimer = 0;
  let lastStateSignature = '';
  let qualityCache = {};
  let seenVideos = {};
  let activeQualityFetches = 0;
  let pageObserver = null;
  let feedLoader = null;
  let disposed = false;
  let blockedUpByUid = new Map();
  let blockedUpByName = new Map();
  let blockedNameByName = new Map();
  let specialTypeIndex = BTFSpecialTypes.compile(DEFAULTS.specialTypes);
  let keywordIndexes = {
    title: [],
    up: [],
    category: [],
    tag: []
  };
  const qualityQueue = [];
  const pendingQuality = new Set();
  const sessionRecorded = new Set();
  const sessionSeen = new Set();
  const temporarilyShown = new Set();
  const blockingInProgress = new Set();
  const submittedNoInterest = new Set();
  const pendingCards = new Map();
  const cardStates = new Map();

  function disposeInvalidatedContext() {
    if (disposed) {
      return;
    }
    disposed = true;
    scheduled = false;
    cancelAnimationFrame(filterFrame);
    feedLoader?.dispose();
    document.querySelectorAll('[data-btf-pending="true"]').forEach((element) => {
      element.removeAttribute('data-btf-pending');
    });
    cardStates.forEach((state, card) => clearCardVisualState(card, state));
    cardStates.clear();
    pendingCards.clear();
    clearTimeout(historySaveTimer);
    clearTimeout(cacheSaveTimer);
    clearTimeout(seenSaveTimer);
    pageObserver?.disconnect();
    qualityQueue.length = 0;
    pendingQuality.clear();
  }

  function hasValidExtensionContext() {
    if (disposed) {
      return false;
    }
    try {
      if (!chrome.runtime?.id) {
        disposeInvalidatedContext();
        return false;
      }
      return true;
    } catch {
      disposeInvalidatedContext();
      return false;
    }
  }

  function safeStorageSet(area, values) {
    if (!hasValidExtensionContext()) {
      return;
    }
    try {
      chrome.storage[area].set(values, () => {
        try {
          if (chrome.runtime.lastError) {
            void chrome.runtime.lastError.message;
          }
        } catch {
          disposeInvalidatedContext();
        }
      });
    } catch {
      disposeInvalidatedContext();
    }
  }

  function storageSet(area, values) {
    return new Promise((resolve, reject) => {
      if (!hasValidExtensionContext()) {
        reject(new Error('扩展上下文已失效，请重新加载扩展和页面'));
        return;
      }
      try {
        chrome.storage[area].set(values, () => {
          try {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve();
          } catch {
            disposeInvalidatedContext();
            reject(new Error('扩展上下文已失效，请重新加载扩展和页面'));
          }
        });
      } catch (error) {
        disposeInvalidatedContext();
        reject(error);
      }
    });
  }

  function storageGetStrict(area, defaults) {
    return new Promise((resolve, reject) => {
      if (!hasValidExtensionContext()) {
        reject(new Error('扩展上下文已失效，请重新加载扩展和页面'));
        return;
      }
      try {
        chrome.storage[area].get(defaults, (result) => {
          try {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(result || defaults);
          } catch {
            disposeInvalidatedContext();
            reject(new Error('扩展上下文已失效，请重新加载扩展和页面'));
          }
        });
      } catch (error) {
        disposeInvalidatedContext();
        reject(error);
      }
    });
  }

  function storageGet(area, defaults) {
    return new Promise((resolve) => {
      if (!hasValidExtensionContext()) {
        resolve(defaults);
        return;
      }
      try {
        chrome.storage[area].get(defaults, (result) => {
          try {
            if (chrome.runtime.lastError) {
              void chrome.runtime.lastError.message;
              resolve(defaults);
              return;
            }
            resolve(result || defaults);
          } catch {
            disposeInvalidatedContext();
            resolve(defaults);
          }
        });
      } catch {
        disposeInvalidatedContext();
        resolve(defaults);
      }
    });
  }

  function normalizeList(value, fallback = []) {
    const list = Array.isArray(value) ? value : fallback;
    return [...new Set(
      list
        .map((item) => String(item).trim())
        .filter(Boolean)
    )];
  }

  function normalized(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function compileKeywords(values) {
    return normalizeList(values)
      .map((original) => ({ original, normalized: normalized(original) }))
      .filter((item) => item.normalized);
  }

  function rebuildMatchingIndexes() {
    blockedUpByUid = new Map();
    blockedUpByName = new Map();
    blockedNameByName = new Map();

    settings.blockedUps.forEach((item) => {
      const uid = String(item?.uid || '').trim();
      const name = String(item?.name || '').trim();
      if (uid) {
        blockedUpByUid.set(uid, item);
      }
      if (name && !/^UID\s+\d+$/i.test(name)) {
        blockedUpByName.set(normalized(name), item);
      }
    });
    settings.blockedUpNames.forEach((name) => {
      blockedNameByName.set(normalized(name), name);
    });

    keywordIndexes = {
      title: compileKeywords(settings.titleKeywords),
      up: compileKeywords(settings.upKeywords),
      category: compileKeywords(settings.categoryKeywords),
      tag: compileKeywords(settings.tagKeywords)
    };
    specialTypeIndex = BTFSpecialTypes.compile(settings.specialTypes);
  }

  function normalizeUrl(value) {
    if (!value) {
      return '';
    }
    try {
      return new URL(value, location.href).href;
    } catch {
      return value.startsWith('//') ? `${location.protocol}${value}` : value;
    }
  }

  function hasMediaPreview(element) {
    return Boolean(
      element?.querySelector?.('img')
      && (element.matches?.(MEDIA_LINK_SELECTOR) || element.querySelector?.(MEDIA_LINK_SELECTOR))
    );
  }

  function isWithinFilterScope(element) {
    return Boolean(element?.closest?.(FILTER_SCOPE_SELECTOR));
  }

  function hasImagePreview(element) {
    return Boolean(element?.matches?.('img') || element?.querySelector?.('img'));
  }

  function isPlausibleCardCandidate(element) {
    if (
      !element
      || !isWithinFilterScope(element)
      || element.matches?.('html, body, main, header, nav, #i_cecream')
    ) {
      return false;
    }
    const knownDescendants = [...element.querySelectorAll(CARD_SELECTOR)];
    const independentCards = knownDescendants.filter((candidate, index) => (
      !knownDescendants.some((other, otherIndex) => (
        otherIndex !== index && other.contains(candidate)
      ))
    ));
    if (independentCards.length > 1) {
      return false;
    }
    if (element.querySelectorAll(MEDIA_LINK_SELECTOR).length > 2) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width > innerWidth * 0.8 && rect.height > innerHeight * 0.8) {
      return false;
    }
    return true;
  }

  function closestMediaCard(element, allowImageOnly = false) {
    const known = element.closest?.(CARD_SELECTOR);
    if (known) {
      return known.closest('.feed-card, .bili-feed-card, .floor-single-card, .floor-card') || known;
    }
    let node = element;
    for (let depth = 0; depth < 8 && node?.parentElement; depth += 1) {
      const hasPreview = allowImageOnly ? hasImagePreview(node) : hasMediaPreview(node);
      if (
        hasPreview
        && node.matches?.('article, li, [class*="card"]')
        && isPlausibleCardCandidate(node)
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function specialTypeFromElement(element) {
    const values = [
      element.textContent,
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.getAttribute('data-badge'),
      element.getAttribute('data-tag'),
      element.getAttribute('data-label'),
      element.querySelector?.('img[alt]')?.getAttribute('alt')
    ];
    return BTFSpecialTypes.matchTextValues(values, specialTypeIndex);
  }

  function queryWithin(root, selector) {
    const elements = [];
    if (root?.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
      elements.push(root);
    }
    root?.querySelectorAll?.(selector).forEach((element) => elements.push(element));
    return elements;
  }

  function normalizeCardElement(element) {
    if (!element) {
      return null;
    }
    const known = element.matches?.(CARD_SELECTOR) ? element : element.closest?.(CARD_SELECTOR);
    if (!known) {
      const mediaLink = element.matches?.(MEDIA_LINK_SELECTOR)
        ? element
        : element.querySelector?.(MEDIA_LINK_SELECTOR);
      const card = mediaLink ? closestMediaCard(mediaLink) : null;
      return isWithinFilterScope(card) ? card : null;
    }
    const card = known.closest('.feed-card')
      || known.closest('.bili-feed-card')
      || known.closest('.floor-single-card')
      || known.closest('.floor-card')
      || known.closest('.bili-video-card')
      || known;
    return isWithinFilterScope(card) ? card : null;
  }

  function collectCards(root = document) {
    const cards = new Map();
    const addCard = (card, specialType = '') => {
      if (!card || !isWithinFilterScope(card)) {
        return;
      }
      const previous = cards.get(card) || '';
      cards.set(card, previous || specialType);
    };

    queryWithin(root, CARD_SELECTOR).forEach((element) => {
      addCard(normalizeCardElement(element));
    });
    queryWithin(root, MEDIA_LINK_SELECTOR).forEach((link) => {
      const card = closestMediaCard(link);
      if (card && (card.querySelector('img') || link.querySelector('img'))) {
        addCard(card);
      }
    });
    queryWithin(root, GENERIC_SPECIAL_BADGE_SELECTOR).forEach((element) => {
      const specialType = specialTypeFromElement(element);
      if (!specialType) {
        return;
      }
      const card = closestMediaCard(element, true);
      if (card && hasImagePreview(card)) {
        addCard(card, specialType);
      }
    });
    return cards;
  }

  function readTitleInfo(card) {
    for (const selector of TITLE_SELECTORS) {
      const element = card.matches(selector) ? card : card.querySelector(selector);
      if (!element) {
        continue;
      }
      const title = (element.getAttribute('title') || element.textContent || '').trim();
      if (!title) {
        continue;
      }
      const link = element.closest('a') || card.querySelector('a[href*="/video/"]');
      return { title, url: normalizeUrl(link?.getAttribute('href') || '') };
    }
    return { title: '', url: '' };
  }

  function readOwnerInfo(card) {
    let ownerElement = null;
    for (const selector of OWNER_SELECTORS) {
      ownerElement = card.querySelector(selector);
      if (ownerElement) {
        break;
      }
    }

    const spaceLink = ownerElement?.closest('a[href*="space.bilibili.com/"]')
      || card.querySelector('a[href*="space.bilibili.com/"]');
    const href = normalizeUrl(spaceLink?.getAttribute('href') || '');
    const uidMatch = href.match(/space\.bilibili\.com\/(\d+)/);
    const upUid = uidMatch?.[1] || '';
    const upName = (
      ownerElement?.getAttribute('title')
      || ownerElement?.querySelector?.('[title]')?.getAttribute('title')
      || ownerElement?.textContent
      || ''
    ).trim();

    return { upName, upUid, ownerElement, ownerLink: spaceLink };
  }

  function getCookieValue(name) {
    const prefix = `${name}=`;
    const item = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    if (!item) {
      return '';
    }
    const value = item.slice(prefix.length);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function showActionToast(message, tone = 'info') {
    let toast = document.querySelector('[data-btf-action-toast="true"]');
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('data-btf-action-toast', 'true');
      toast.setAttribute('data-btf-ui', 'true');
      document.body.appendChild(toast);
    }
    toast.dataset.tone = tone;
    toast.textContent = message;
    toast.classList.add('btf-action-toast--visible');
    clearTimeout(Number(toast.dataset.hideTimer || 0));
    const timer = setTimeout(() => {
      toast.classList.remove('btf-action-toast--visible');
    }, tone === 'error' ? 5000 : 3000);
    toast.dataset.hideTimer = String(timer);
  }

  function getLiveRoomId(url) {
    return String(url || '').match(/live\.bilibili\.com\/(\d+)/i)?.[1] || '';
  }

  function readFeedbackTarget(card, titleInfo) {
    if (!card.matches?.('.enable-no-interest') && !card.querySelector('.enable-no-interest')) {
      return null;
    }
    const videoUrl = titleInfo?.url
      || normalizeUrl(card.querySelector('a[href*="/video/"]')?.getAttribute('href') || '');
    const bvid = getBvid(videoUrl);
    if (bvid) {
      return { goto: 'av', bvid, id: '' };
    }

    const liveUrl = normalizeUrl(
      card.querySelector('a[href*="live.bilibili.com/"]')?.getAttribute('href') || ''
    );
    const roomId = getLiveRoomId(liveUrl);
    return roomId ? { goto: 'live', bvid: '', id: roomId } : null;
  }

  async function requestNotInterested(target, card) {
    if (!target?.goto || !card?.isConnected) {
      throw new Error('没有读取到当前卡片，无法提交不感兴趣');
    }
    const targetKey = target.goto === 'av' ? `av:${target.bvid}` : `live:${target.id}`;
    if (submittedNoInterest.has(targetKey)) {
      return;
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        clearTimeout(timer);
        card.removeEventListener(NATIVE_DISLIKE_RESPONSE_EVENT, handleResponse);
        delete card.dataset.btfNativeDislikeRequestId;
        delete card.dataset.btfNativeDislikeResponseId;
        delete card.dataset.btfNativeDislikeStatus;
        delete card.dataset.btfNativeDislikeMessage;
      };
      const handleResponse = () => {
        if (card.dataset.btfNativeDislikeResponseId !== requestId) {
          return;
        }
        const status = card.dataset.btfNativeDislikeStatus;
        const message = card.dataset.btfNativeDislikeMessage;
        cleanup();
        if (status === 'ok') {
          resolve();
        } else {
          reject(new Error(message || 'B 站原生“不感兴趣”操作失败'));
        }
      };
      card.dataset.btfNativeDislikeRequestId = requestId;
      card.addEventListener(NATIVE_DISLIKE_RESPONSE_EVENT, handleResponse);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('B 站原生“不感兴趣”操作超时'));
      }, 2500);
      card.dispatchEvent(new Event(NATIVE_DISLIKE_REQUEST_EVENT, { bubbles: true }));
    });
    submittedNoInterest.add(targetKey);
  }

  async function requestOfficialBlock(upUid) {
    const csrf = getCookieValue('bili_jct');
    if (!csrf) {
      throw new Error('没有读取到登录凭据，请先登录 B 站并刷新首页');
    }

    const body = new URLSearchParams({
      fid: String(upUid),
      act: '5',
      re_src: '11',
      gaia_source: 'web_main',
      spmid: '333.1387.0.0',
      extend_content: JSON.stringify({ entity: 'user', entity_id: String(upUid) }),
      is_from_frontend_component: '1',
      csrf,
      csrf_token: csrf
    });
    const statistics = encodeURIComponent(JSON.stringify({ appId: 100, platform: 5 }));
    const response = await fetch(
      `https://api.bilibili.com/x/relation/modify?statistics=${statistics}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: body.toString()
      }
    );
    if (!response.ok) {
      throw new Error(`B站接口请求失败（HTTP ${response.status}）`);
    }
    const result = await response.json();
    if (Number(result?.code) !== 0) {
      throw new Error(result?.message || `B站接口返回错误 ${result?.code}`);
    }
  }

  async function saveOfficialBlockedUp(upUid, upName) {
    const localData = await storageGetStrict('local', {
      [LOCAL_KEYS.blockedUps]: [],
      [LOCAL_KEYS.blockedOrder]: [],
      [LOCAL_KEYS.sharedMeta]: { lastRevision: null, dirty: false }
    });
    const current = Array.isArray(localData[LOCAL_KEYS.blockedUps])
      ? localData[LOCAL_KEYS.blockedUps]
      : [];
    const existing = current.find((item) => String(item?.uid || '') === String(upUid));
    const entry = {
      uid: String(upUid),
      name: String(upName || existing?.name || `UID ${upUid}`).trim() || `UID ${upUid}`,
      source: 'official'
    };
    const next = [entry, ...current.filter((item) => String(item?.uid || '') !== String(upUid))];
    const orderKey = `uid:${upUid}`;
    const currentOrder = Array.isArray(localData[LOCAL_KEYS.blockedOrder])
      ? localData[LOCAL_KEYS.blockedOrder]
      : [];
    const nextOrder = [orderKey, ...currentOrder.filter((item) => item !== orderKey)];
    const sharedMeta = localData[LOCAL_KEYS.sharedMeta] && typeof localData[LOCAL_KEYS.sharedMeta] === 'object'
      ? localData[LOCAL_KEYS.sharedMeta]
      : { lastRevision: null, dirty: false };
    await storageSet('local', {
      [LOCAL_KEYS.blockedUps]: next,
      [LOCAL_KEYS.blockedOrder]: nextOrder,
      [LOCAL_KEYS.sharedMeta]: { ...sharedMeta, dirty: true }
    });
    settings.blockedUps = next;
    rebuildMatchingIndexes();
  }

  async function handleBlockUpClick(button) {
    const upUid = String(button.dataset.upUid || '');
    const upName = String(button.dataset.upName || `UID ${upUid}`);
    const feedbackTarget = {
      goto: String(button.dataset.feedbackGoto || ''),
      bvid: String(button.dataset.feedbackBvid || ''),
      id: String(button.dataset.feedbackId || '')
    };
    const card = normalizeCardElement(button);
    if (!/^\d+$/.test(upUid) || blockingInProgress.has(upUid)) {
      return;
    }
    if (!globalThis.confirm(
      `确定同时处理“${upName}”吗？\n\n`
      + '1. 对当前内容标记“内容不感兴趣”\n'
      + '2. 将该 UP 加入 B 站官方拉黑名单和插件屏蔽名单'
    )) {
      return;
    }

    blockingInProgress.add(upUid);
    button.disabled = true;
    button.textContent = '处理中…';
    let noInterestSucceeded = false;
    let officialBlockSucceeded = false;
    try {
      await requestNotInterested(feedbackTarget, card);
      noInterestSucceeded = true;
      await requestOfficialBlock(upUid);
      officialBlockSucceeded = true;
      await saveOfficialBlockedUp(upUid, upName);
      button.textContent = '已拉黑';
      showActionToast(`已提交不感兴趣，并拉黑屏蔽：${upName}`, 'success');
      requestFullFilter();
    } catch (error) {
      if (officialBlockSucceeded) {
        button.disabled = true;
        button.textContent = '已拉黑';
        showActionToast(`B站两项操作已完成，但插件名单保存失败：${error?.message || error}`, 'error');
      } else if (noInterestSucceeded) {
        button.disabled = false;
        button.textContent = '重试拉黑';
        showActionToast(`已提交不感兴趣，但拉黑失败：${error?.message || error}`, 'error');
      } else {
        button.disabled = false;
        button.textContent = '拉黑';
        showActionToast(`操作失败，未拉黑且插件名单未修改：${error?.message || error}`, 'error');
      }
    } finally {
      blockingInProgress.delete(upUid);
    }
  }

  function ensureBlockButton(card, ownerInfo, titleInfo) {
    const upUid = String(ownerInfo.upUid || '');
    const ownerElement = ownerInfo.ownerElement;
    const placementElement = ownerInfo.ownerLink || ownerElement;
    const feedbackTarget = readFeedbackTarget(card, titleInfo);
    let button = card.querySelector('.btf-block-up-button');
    if (
      !/^\d+$/.test(upUid)
      || !placementElement?.parentElement
      || !feedbackTarget
    ) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'btf-block-up-button';
      button.setAttribute('data-btf-ui', 'true');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleBlockUpClick(event.currentTarget);
      });
      placementElement.insertAdjacentElement('afterend', button);
    }

    const upName = ownerInfo.upName || `UID ${upUid}`;
    const officiallyBlocked = blockedUpByUid.get(upUid)?.source === 'official';
    button.dataset.upUid = upUid;
    button.dataset.upName = upName;
    button.dataset.feedbackGoto = feedbackTarget.goto;
    button.dataset.feedbackBvid = feedbackTarget.bvid;
    button.dataset.feedbackId = feedbackTarget.id;
    button.title = officiallyBlocked
      ? `${upName} 已在 B站拉黑名单中`
      : `标记内容不感兴趣，并拉黑屏蔽 ${upName}`;
    button.setAttribute('aria-label', button.title);
    button.disabled = officiallyBlocked || blockingInProgress.has(upUid);
    button.textContent = officiallyBlocked ? '已拉黑' : '拉黑';
    card.setAttribute('data-btf-card-ui', 'true');
  }

  function readCover(card) {
    const image = card.querySelector('img');
    return normalizeUrl(
      image?.currentSrc
      || image?.getAttribute('src')
      || image?.getAttribute('data-src')
      || ''
    );
  }

  function readSpecialType(card) {
    if (!settings.specialTypes.length) {
      return '';
    }

    const links = [...card.querySelectorAll('a[href]')]
      .map((link) => normalizeUrl(link.getAttribute('href') || ''))
      .filter(Boolean);
    const urlMatch = BTFSpecialTypes.matchUrls(links, specialTypeIndex);
    if (urlMatch) {
      return urlMatch;
    }

    const titleNodes = TITLE_SELECTORS.flatMap((selector) => [...card.querySelectorAll(selector)]);
    const ownerNodes = OWNER_SELECTORS.flatMap((selector) => [...card.querySelectorAll(selector)]);
    const excluded = [...titleNodes, ...ownerNodes];
    const candidates = card.querySelectorAll(BADGE_CANDIDATE_SELECTOR);
    for (const element of candidates) {
      if (excluded.some((node) => element === node || element.contains(node) || node.contains(element))) {
        continue;
      }
      const textMatch = specialTypeFromElement(element);
      if (textMatch) {
        return textMatch;
      }
    }
    return '';
  }

  function findLayoutSlot(card) {
    return card.closest('.feed-card')
      || card.closest('.floor-single-card')
      || card.closest('.bili-feed-card')
      || card.closest('.bili-video-card')
      || card.closest('.video-card')
      || card.closest('.floor-card')
      || card.closest('.small-item')
      || card.closest('.rank-item')
      || card.closest('.popular-video-card')
      || card.closest('.video-page-card-small')
      || (isPlausibleCardCandidate(card) ? card : null);
  }

  function matchKeyword(value, compiledKeywords) {
    const source = normalized(value);
    return compiledKeywords.find((item) => source.includes(item.normalized))?.original || '';
  }

  function getBvid(url) {
    return url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1]?.toUpperCase() || '';
  }

  function queueCacheSave() {
    if (!hasValidExtensionContext()) {
      return;
    }
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      if (!hasValidExtensionContext()) {
        return;
      }
      const entries = Object.entries(qualityCache)
        .sort((a, b) => Number(b[1]?.fetchedAt || 0) - Number(a[1]?.fetchedAt || 0))
        .slice(0, CACHE_LIMIT);
      qualityCache = Object.fromEntries(entries);
      safeStorageSet('local', { [LOCAL_KEYS.qualityCache]: qualityCache });
    }, 600);
  }

  function queueSeenSave() {
    if (!hasValidExtensionContext()) {
      return;
    }
    clearTimeout(seenSaveTimer);
    seenSaveTimer = setTimeout(() => {
      if (!hasValidExtensionContext()) {
        return;
      }
      const entries = Object.entries(seenVideos)
        .sort((a, b) => Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0))
        .slice(0, SEEN_LIMIT);
      seenVideos = Object.fromEntries(entries);
      safeStorageSet('local', { [LOCAL_KEYS.seenVideos]: seenVideos });
    }, 600);
  }

  function markSeen(bvid) {
    if (!bvid || sessionSeen.has(bvid)) {
      return Number(seenVideos[bvid]?.count || 0);
    }
    sessionSeen.add(bvid);
    const previous = seenVideos[bvid] || {};
    seenVideos[bvid] = {
      count: Number(previous.count || 0) + 1,
      lastSeen: Date.now()
    };
    queueSeenSave();
    return seenVideos[bvid].count;
  }

  function getCachedQuality(bvid) {
    const cached = qualityCache[bvid];
    if (!cached) {
      return null;
    }
    const maxAge = cached.error ? ERROR_CACHE_AGE : CACHE_MAX_AGE;
    if (Date.now() - Number(cached.fetchedAt || 0) > maxAge) {
      delete qualityCache[bvid];
      return null;
    }
    return cached;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(result.message || `API ${result.code}`);
    }
    return result.data;
  }

  async function fetchQuality(bvid) {
    const existing = qualityCache[bvid] || {};
    try {
      let detail = existing;
      if (!existing.duration || !existing.stat) {
        const data = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        detail = {
          fetchedAt: Date.now(),
          aid: Number(data?.aid || 0),
          duration: Number(data?.duration || 0),
          tname: String(data?.tname || ''),
          stat: {
            view: Number(data?.stat?.view || 0),
            coin: Number(data?.stat?.coin || 0),
            favorite: Number(data?.stat?.favorite || 0),
            like: Number(data?.stat?.like || 0),
            reply: Number(data?.stat?.reply || 0)
          },
          tags: Array.isArray(existing.tags) ? existing.tags : [],
          tagsFetched: Boolean(existing.tagsFetched)
        };
      }

      if (settings.enabled && settings.tagKeywords.length && !detail.tagsFetched) {
        try {
          const tags = await fetchJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`);
          detail.tags = Array.isArray(tags)
            ? tags.map((item) => String(item?.tag_name || '')).filter(Boolean)
            : [];
        } catch (error) {
          detail.tags = [];
          detail.tagError = String(error?.message || error);
        } finally {
          detail.tagsFetched = true;
        }
      }

      detail.fetchedAt = Date.now();
      qualityCache[bvid] = detail;
    } catch (error) {
      qualityCache[bvid] = {
        ...existing,
        fetchedAt: Date.now(),
        error: true,
        errorMessage: String(error?.message || error)
      };
    } finally {
      pendingQuality.delete(bvid);
      activeQualityFetches -= 1;
      if (!hasValidExtensionContext()) {
        return;
      }
      queueCacheSave();
      requestFullFilter();
      pumpQualityQueue();
    }
  }

  function pumpQualityQueue() {
    if (!hasValidExtensionContext() || !settings.enabled) {
      return;
    }
    while (activeQualityFetches < MAX_QUALITY_FETCHES && qualityQueue.length) {
      const bvid = qualityQueue.shift();
      activeQualityFetches += 1;
      fetchQuality(bvid);
    }
  }

  function queueQuality(bvid) {
    if (!hasValidExtensionContext() || !bvid || pendingQuality.has(bvid)) {
      return;
    }
    const cached = getCachedQuality(bvid);
    if (cached?.error) {
      return;
    }
    const needsTags = settings.tagKeywords.length && !cached?.tagsFetched;
    if (cached && !cached.error && !needsTags) {
      return;
    }
    pendingQuality.add(bvid);
    qualityQueue.push(bvid);
    pumpQualityQueue();
  }

  function buildReasons(title, upName, upUid, quality, context) {
    const reasons = [];
    if (context.specialType) {
      reasons.push({ type: 'specialType', label: `特殊类型：${context.specialType}` });
    }
    const normalizedUpName = normalized(upName);
    const blockedUid = blockedUpByUid.get(String(upUid));
    const blockedRecordName = normalizedUpName ? blockedUpByName.get(normalizedUpName) : null;
    const exactName = normalizedUpName ? blockedNameByName.get(normalizedUpName) : '';
    const blockedEntry = blockedUid || blockedRecordName;
    if (blockedEntry) {
      const label = blockedEntry.name || upName || `UID ${blockedEntry.uid}`;
      reasons.push({ type: blockedUid ? 'upUid' : 'upName', label: `屏蔽名单：${label}` });
    } else if (upName && exactName) {
      reasons.push({ type: 'upName', label: `屏蔽名单：${exactName}` });
    }

    const upKeyword = upName ? matchKeyword(upName, keywordIndexes.up) : '';
    if (upKeyword) {
      reasons.push({ type: 'upKeyword', label: `UP关键词：${upKeyword}` });
    }

    const titleKeyword = title ? matchKeyword(title, keywordIndexes.title) : '';
    if (titleKeyword) {
      reasons.push({ type: 'titleKeyword', label: `标题关键词：${titleKeyword}` });
    }

    if (quality && !quality.error) {
      const categoryKeyword = matchKeyword(quality.tname, keywordIndexes.category);
      if (categoryKeyword) {
        reasons.push({ type: 'categoryKeyword', label: `分区关键词：${categoryKeyword}` });
      }

      const matchedTag = (quality.tags || []).find((tag) => matchKeyword(tag, keywordIndexes.tag));
      if (matchedTag) {
        reasons.push({ type: 'tagKeyword', label: `标签关键词：${matchedTag}` });
      }
    }

    if (settings.qualityEnabled) {
      const result = BTFQuality.evaluate(quality || {}, context, settings.qualityMode);
      if (result.hidden) {
        reasons.push({ type: 'quality', label: `质量分${result.score}（阈值${result.threshold}）` });
        result.details
          .filter((item) => item.points < 0)
          .forEach((item) => reasons.push({ type: 'qualityDetail', label: item.label }));
      }
    }
    return reasons;
  }

  function getRecordKey(info) {
    const bvid = getBvid(info.url);
    return bvid || info.url || `${info.upUid || info.upName}::${info.title}`;
  }

  function buildRecord(card, reasons, knownInfo = null) {
    const info = knownInfo || { ...readTitleInfo(card), ...readOwnerInfo(card) };
    const id = getRecordKey(info);
    return {
      id,
      bvid: getBvid(info.url),
      title: info.title || '未读取到标题',
      url: info.url,
      cover: readCover(card),
      upName: info.upName || (info.upUid ? `UID ${info.upUid}` : '未读取到UP名称'),
      upUid: info.upUid,
      reasons,
      matchedAt: Date.now()
    };
  }

  function queueHistorySave() {
    if (!hasValidExtensionContext()) {
      return;
    }
    clearTimeout(historySaveTimer);
    historySaveTimer = setTimeout(() => {
      if (!hasValidExtensionContext()) {
        return;
      }
      safeStorageSet('local', { [LOCAL_KEYS.history]: history });
    }, 350);
  }

  function addToHistory(record) {
    if (sessionRecorded.has(record.id)) {
      return;
    }
    sessionRecorded.add(record.id);
    history = [record, ...history.filter((item) => item.id !== record.id)].slice(0, HISTORY_LIMIT);
    queueHistorySave();
  }

  function broadcastState() {
    if (!hasValidExtensionContext()) {
      return;
    }
    const signature = JSON.stringify(currentRecords.map((record) => ({
      id: record.id,
      title: record.title,
      upUid: record.upUid,
      reasons: record.reasons
    })));
    if (signature === lastStateSignature) {
      return;
    }
    lastStateSignature = signature;
    try {
      chrome.runtime.sendMessage({
        type: 'BTF_STATE_CHANGED',
        records: currentRecords,
        history
      }, () => {
        try {
          if (chrome.runtime.lastError) {
            void chrome.runtime.lastError.message;
          }
        } catch {
          disposeInvalidatedContext();
        }
      });
    } catch {
      disposeInvalidatedContext();
    }
  }

  function getCardState(card) {
    let state = cardStates.get(card);
    if (!state) {
      state = { record: null, slot: null };
      cardStates.set(card, state);
    }
    return state;
  }

  function clearCardVisualState(card, state) {
    if (state?.slot) {
      state.slot.removeAttribute('data-btf-hidden-slot');
      state.slot.removeAttribute('aria-hidden');
    }
    card.removeAttribute('data-btf-filtered');
    card.removeAttribute('data-btf-pending');
    if (state) {
      state.slot = null;
      state.record = null;
    }
  }

  function applyCardVisibility(card, state, shouldHide) {
    if (!shouldHide) {
      if (state.slot) {
        state.slot.removeAttribute('data-btf-hidden-slot');
        state.slot.removeAttribute('aria-hidden');
        state.slot = null;
      }
      card.removeAttribute('data-btf-filtered');
      return;
    }

    let slot = state.slot;
    if (
      !slot?.isConnected
      || (slot !== card && !slot.contains(card))
      || !isPlausibleCardCandidate(slot)
    ) {
      slot = findLayoutSlot(card);
    }
    if (!slot || !isPlausibleCardCandidate(slot)) {
      clearCardVisualState(card, state);
      return;
    }
    if (state.slot && state.slot !== slot) {
      state.slot.removeAttribute('data-btf-hidden-slot');
      state.slot.removeAttribute('aria-hidden');
    }
    state.slot = slot;
    if (slot.getAttribute('data-btf-hidden-slot') !== 'true') {
      slot.setAttribute('data-btf-hidden-slot', 'true');
      slot.setAttribute('aria-hidden', 'true');
    }
    if (card.getAttribute('data-btf-filtered') !== 'true') {
      card.setAttribute('data-btf-filtered', 'true');
    }
  }

  function buildSameUpIndexes(cards) {
    const indexes = new Map();
    if (!settings.qualityEnabled) {
      return indexes;
    }
    const counts = new Map();
    cards.forEach((card) => {
      if (!card.isConnected) {
        return;
      }
      const ownerInfo = readOwnerInfo(card);
      const upKey = ownerInfo.upUid || normalized(ownerInfo.upName);
      const index = upKey ? Number(counts.get(upKey) || 0) + 1 : 1;
      if (upKey) {
        counts.set(upKey, index);
      }
      indexes.set(card, index);
    });
    return indexes;
  }

  function processCard(card, specialTypeHint, sameUpIndex) {
    const state = getCardState(card);
    const titleInfo = readTitleInfo(card);
    const ownerInfo = readOwnerInfo(card);
    const specialType = specialTypeHint || readSpecialType(card);
    const ready = Boolean(titleInfo.title || titleInfo.url || ownerInfo.upUid || specialType);
    if (!ready) {
      // Bilibili reuses card nodes while fetching the next recommendations.
      // Release the previous result and keep its native loading skeleton visible.
      clearCardVisualState(card, state);
      return;
    }

    ensureBlockButton(card, ownerInfo, titleInfo);
    const bvid = getBvid(titleInfo.url);
    const seenCount = settings.qualityEnabled ? markSeen(bvid) : 0;
    const needsQualityData = settings.qualityEnabled
      || settings.categoryKeywords.length
      || settings.tagKeywords.length;
    if (needsQualityData) {
      queueQuality(bvid);
    }
    const quality = getCachedQuality(bvid);
    const reasons = buildReasons(
      titleInfo.title,
      ownerInfo.upName,
      ownerInfo.upUid,
      quality,
      { sameUpIndex, seenCount, specialType }
    );
    const record = reasons.length
      ? buildRecord(card, reasons, { ...titleInfo, ...ownerInfo })
      : null;
    state.record = record;
    if (record) {
      addToHistory(record);
    }
    applyCardVisibility(card, state, Boolean(record && !temporarilyShown.has(record.id)));
    card.removeAttribute('data-btf-pending');
  }

  function queueCardForFilter(card, specialTypeHint = '') {
    const normalizedCard = normalizeCardElement(card);
    if (!normalizedCard?.isConnected) {
      return false;
    }
    const previousHint = pendingCards.get(normalizedCard) || '';
    pendingCards.set(normalizedCard, previousHint || specialTypeHint);
    getCardState(normalizedCard);
    return true;
  }

  function queueCardsFromRoot(root) {
    let queued = false;
    collectCards(root).forEach((specialTypeHint, card) => {
      queued = queueCardForFilter(card, specialTypeHint) || queued;
    });
    return queued;
  }

  function captureScrollAnchors() {
    if (scrollY <= 0) {
      return [];
    }
    const seen = new Set();
    return [...document.querySelectorAll(CARD_SELECTOR)]
      .map((element) => normalizeCardElement(element))
      .filter((card) => {
        if (!card?.isConnected || seen.has(card)) {
          return false;
        }
        seen.add(card);
        const rect = card.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      })
      .slice(0, 12)
      .map((card) => ({ card, top: card.getBoundingClientRect().top }));
  }

  function restoreScrollAnchor(anchors) {
    const anchor = anchors.find(({ card }) => (
      card.isConnected && !card.closest('[data-btf-hidden-slot="true"]')
    ));
    if (!anchor) {
      return;
    }
    const delta = anchor.card.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1 && Math.abs(delta) < innerHeight * 2) {
      scrollBy(0, delta);
    }
  }

  function filterPage() {
    scheduled = false;
    filterFrame = 0;
    if (!hasValidExtensionContext() || !settings.enabled) {
      return;
    }

    const scrollAnchors = captureScrollAnchors();
    const wasFullScan = fullScanRequested;
    const cardsToProcess = wasFullScan ? collectCards() : new Map(pendingCards);
    fullScanRequested = false;
    pendingCards.clear();

    cardsToProcess.forEach((_hint, card) => {
      getCardState(card);
    });

    const currentFullScanCards = wasFullScan ? new Set(cardsToProcess.keys()) : null;
    cardStates.forEach((state, card) => {
      if (!card.isConnected || (currentFullScanCards && !currentFullScanCards.has(card))) {
        clearCardVisualState(card, state);
        cardStates.delete(card);
      }
    });

    const sameUpIndexes = buildSameUpIndexes([...cardStates.keys()]);
    cardsToProcess.forEach((specialTypeHint, card) => {
      if (card.isConnected) {
        try {
          processCard(card, specialTypeHint, sameUpIndexes.get(card) || 1);
        } catch {
          // One malformed card must not stop updates for the entire feed.
          clearCardVisualState(card, cardStates.get(card));
        }
      }
    });

    currentRecords = [...cardStates.entries()]
      .filter(([card, state]) => card.isConnected && state.record)
      .map(([_card, state]) => state.record);
    restoreScrollAnchor(scrollAnchors);
    broadcastState();
    feedLoader?.schedule();
  }

  function scheduleFilter() {
    if (!hasValidExtensionContext() || !settings.enabled || scheduled) {
      return;
    }
    scheduled = true;
    filterFrame = requestAnimationFrame(() => {
      try {
        filterPage();
      } catch {
        disposeInvalidatedContext();
      }
    });
  }

  function requestFullFilter() {
    fullScanRequested = true;
    scheduleFilter();
  }

  function isExtensionUiNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.('[data-btf-ui="true"]'));
  }

  function elementHasRelevantContent(element) {
    if (!element || isExtensionUiNode(element)) {
      return false;
    }
    return Boolean(
      element.matches?.(MUTATION_RELEVANT_SELECTOR)
      || element.querySelector?.(MUTATION_RELEVANT_SELECTOR)
    );
  }

  function mutationNeedsFilter(mutation) {
    const target = mutation.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target?.parentElement;
    if (!target || isExtensionUiNode(target)) {
      return false;
    }
    if (!isWithinFilterScope(target)) {
      // A newly mounted/replaced <main> is reported on its parent outside main.
      return mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes]
        .some((node) => node.nodeType === Node.ELEMENT_NODE && (
          node.matches(FILTER_SCOPE_SELECTOR) || node.querySelector(FILTER_SCOPE_SELECTOR)
        ));
    }
    const withinKnownCard = target.closest(CARD_SELECTOR);

    if (mutation.type === 'characterData') {
      return Boolean(withinKnownCard && (
        target.closest(TITLE_SELECTOR)
        || target.closest(OWNER_SELECTOR)
        || target.closest(GENERIC_SPECIAL_BADGE_SELECTOR)
      ));
    }

    if (mutation.type === 'attributes') {
      if (mutation.attributeName === 'class' || mutation.attributeName.startsWith('data-')) {
        // Class removal can turn a badge back into an ordinary element.
        return Boolean(withinKnownCard);
      }
      return Boolean(
        target.matches(MEDIA_LINK_SELECTOR)
        || (withinKnownCard && (
          target.matches(CARD_SELECTOR)
          || target.closest(TITLE_SELECTOR)
          || target.closest(OWNER_SELECTOR)
          || target.closest(GENERIC_SPECIAL_BADGE_SELECTOR)
        ))
      );
    }

    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
      .filter((node) => !isExtensionUiNode(node));
    if (!changedNodes.length) {
      return false;
    }
    if (withinKnownCard) {
      return true;
    }
    return changedNodes.some((node) => elementHasRelevantContent(
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    ));
  }

  function handlePageMutations(mutations) {
    let needsFilter = false;
    mutations.forEach((mutation) => {
      if (!mutationNeedsFilter(mutation)) {
        return;
      }
      needsFilter = true;
      const target = mutation.target?.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target?.parentElement;
      const targetCard = normalizeCardElement(target);
      if (targetCard) {
        queueCardForFilter(targetCard);
      }
      mutation.addedNodes.forEach((node) => {
        if (!isExtensionUiNode(node) && node.nodeType === Node.ELEMENT_NODE) {
          queueCardsFromRoot(node);
        }
      });
    });
    if (needsFilter) {
      scheduleFilter();
    }
  }

  async function loadSettings(loadHistory = true) {
    const syncData = await storageGet('sync', {
      [SYNC_KEYS.enabled]: true,
      [SYNC_KEYS.titleKeywords]: null,
      [SYNC_KEYS.upKeywords]: DEFAULTS.upKeywords,
      [SYNC_KEYS.categoryKeywords]: DEFAULTS.categoryKeywords,
      [SYNC_KEYS.tagKeywords]: DEFAULTS.tagKeywords,
      [SYNC_KEYS.specialTypes]: DEFAULTS.specialTypes,
      [SYNC_KEYS.specialTypesVersion]: 0,
      [SYNC_KEYS.qualityEnabled]: DEFAULTS.qualityEnabled,
      [SYNC_KEYS.qualityMode]: DEFAULTS.qualityMode,
      [SYNC_KEYS.legacyTitleKeywords]: DEFAULTS.titleKeywords
    });
    const localDefaults = {
      [LOCAL_KEYS.blockedUpNames]: [],
      [LOCAL_KEYS.blockedUps]: []
    };
    if (loadHistory) {
      Object.assign(localDefaults, {
        [LOCAL_KEYS.history]: [],
        [LOCAL_KEYS.qualityCache]: {},
        [LOCAL_KEYS.seenVideos]: {}
      });
    }
    const localData = await storageGet('local', localDefaults);

    const titleKeywords = syncData[SYNC_KEYS.titleKeywords]
      ?? syncData[SYNC_KEYS.legacyTitleKeywords]
      ?? DEFAULTS.titleKeywords;
    let specialTypes = normalizeList(syncData[SYNC_KEYS.specialTypes], DEFAULTS.specialTypes);
    if (Number(syncData[SYNC_KEYS.specialTypesVersion] || 0) < SPECIAL_TYPES_VERSION) {
      specialTypes = normalizeList([...specialTypes, ...DEFAULTS.specialTypes]);
      safeStorageSet('sync', {
        [SYNC_KEYS.specialTypes]: specialTypes,
        [SYNC_KEYS.specialTypesVersion]: SPECIAL_TYPES_VERSION
      });
    }
    settings = {
      enabled: syncData[SYNC_KEYS.enabled] !== false,
      titleKeywords: normalizeList(titleKeywords, DEFAULTS.titleKeywords),
      upKeywords: normalizeList(syncData[SYNC_KEYS.upKeywords], DEFAULTS.upKeywords),
      categoryKeywords: normalizeList(syncData[SYNC_KEYS.categoryKeywords]),
      tagKeywords: normalizeList(syncData[SYNC_KEYS.tagKeywords]),
      specialTypes,
      qualityEnabled: syncData[SYNC_KEYS.qualityEnabled] !== false,
      qualityMode: ['loose', 'standard', 'strict'].includes(syncData[SYNC_KEYS.qualityMode])
        ? syncData[SYNC_KEYS.qualityMode]
        : DEFAULTS.qualityMode,
      blockedUpNames: normalizeList(localData[LOCAL_KEYS.blockedUpNames]),
      blockedUps: Array.isArray(localData[LOCAL_KEYS.blockedUps]) ? localData[LOCAL_KEYS.blockedUps] : []
    };
    rebuildMatchingIndexes();
    if (loadHistory) {
      history = Array.isArray(localData[LOCAL_KEYS.history]) ? localData[LOCAL_KEYS.history] : [];
      qualityCache = localData[LOCAL_KEYS.qualityCache] && typeof localData[LOCAL_KEYS.qualityCache] === 'object'
        ? localData[LOCAL_KEYS.qualityCache]
        : {};
      seenVideos = localData[LOCAL_KEYS.seenVideos] && typeof localData[LOCAL_KEYS.seenVideos] === 'object'
        ? localData[LOCAL_KEYS.seenVideos]
        : {};
    }
  }

  function applyEnabledState() {
    pageObserver?.disconnect();
    if (!settings.enabled) {
      cancelAnimationFrame(filterFrame);
      filterFrame = 0;
      scheduled = false;
      feedLoader?.dispose();
      feedLoader = null;
      qualityQueue.splice(0).forEach((bvid) => pendingQuality.delete(bvid));
      cardStates.forEach((state, card) => clearCardVisualState(card, state));
      cardStates.clear();
      pendingCards.clear();
      document.querySelectorAll('.btf-block-up-button').forEach((button) => button.remove());
      document.querySelectorAll('[data-btf-card-ui]').forEach((card) => card.removeAttribute('data-btf-card-ui'));
      currentRecords = [];
      broadcastState();
      return;
    }
    feedLoader ||= BTFFeedLoader.create({ isActive: () => settings.enabled && hasValidExtensionContext() });
    pageObserver?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'title', 'class', 'data-badge', 'data-tag', 'data-label']
    });
    requestFullFilter();
  }

  async function reloadChangedSettings() {
    if (!hasValidExtensionContext()) {
      return;
    }
    await loadSettings(false);
    if (hasValidExtensionContext()) applyEnabledState();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!hasValidExtensionContext()) {
      return;
    }
    const relevantSync = areaName === 'sync' && [
      SYNC_KEYS.enabled,
      SYNC_KEYS.titleKeywords,
      SYNC_KEYS.upKeywords,
      SYNC_KEYS.categoryKeywords,
      SYNC_KEYS.tagKeywords,
      SYNC_KEYS.specialTypes,
      SYNC_KEYS.specialTypesVersion,
      SYNC_KEYS.qualityEnabled,
      SYNC_KEYS.qualityMode,
      SYNC_KEYS.legacyTitleKeywords
    ].some((key) => changes[key]);
    const relevantLocal = areaName === 'local' && [
      LOCAL_KEYS.blockedUpNames,
      LOCAL_KEYS.blockedUps
    ].some((key) => changes[key]);
    if (relevantSync || relevantLocal) {
      reloadChangedSettings();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!hasValidExtensionContext()) {
      return;
    }
    if (message?.type === 'BTF_GET_STATE') {
      sendResponse({ active: true, enabled: settings.enabled, records: currentRecords });
      return;
    }
    if (message?.type === 'BTF_SHOW_ONCE' && message.id) {
      temporarilyShown.add(message.id);
      requestFullFilter();
      sendResponse({ ok: true });
    }
  });

  function waitForDocumentRoot() {
    if (document.documentElement) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.documentElement) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document, { childList: true });
    });
  }

  async function init() {
    await waitForDocumentRoot();
    await loadSettings();
    if (!hasValidExtensionContext()) {
      return;
    }
    pageObserver = new MutationObserver(handlePageMutations);
    applyEnabledState();
  }

  init().catch(() => disposeInvalidatedContext());
})();
