(() => {
  'use strict';

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
  const SPECIAL_TYPES_VERSION = BTFSpecialTypes.VERSION;
  const SHARED_SYNC_KEYS = new Set([
    SYNC_KEYS.titleKeywords,
    SYNC_KEYS.upKeywords,
    SYNC_KEYS.categoryKeywords,
    SYNC_KEYS.tagKeywords,
    SYNC_KEYS.specialTypes
  ]);
  const state = {
    enabled: true,
    titleKeywords: [],
    upKeywords: [],
    categoryKeywords: [],
    tagKeywords: [],
    specialTypes: [],
    qualityEnabled: true,
    qualityMode: 'standard',
    blockedUpNames: [],
    blockedUps: [],
    blockedOrder: [],
    currentRecords: [],
    history: [],
    recordMode: 'current',
    activeTabId: null
  };

  let statusTimer = 0;
  let titleEditor;
  let upEditor;
  let categoryEditor;
  let tagEditor;
  let specialTypeEditor;
  let sharedDirectoryHandle = null;
  let sharedReady = false;
  let sharedWriteTimer = 0;
  let sharedWriteChain = Promise.resolve();

  const pageStatus = document.querySelector('#page-status');
  const saveStatus = document.querySelector('#save-status');
  const recordList = document.querySelector('#record-list');
  const upList = document.querySelector('#up-list');
  const upSearch = document.querySelector('#up-search');
  const blockInput = document.querySelector('#block-input');
  const importButton = document.querySelector('#import-blacklist');
  const importStatus = document.querySelector('#import-status');
  const sharedIndicator = document.querySelector('#shared-state-indicator');
  const sharedDetail = document.querySelector('#shared-state-detail');
  const openSharedSettingsButton = document.querySelector('#open-shared-settings');
  const refreshSharedStateButton = document.querySelector('#refresh-shared-state');

  function storageGet(area, defaults) {
    return new Promise((resolve) => chrome.storage[area].get(defaults, resolve));
  }

  function storageSet(area, values) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(values, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function normalizeList(value, fallback = []) {
    const list = Array.isArray(value) ? value : fallback;
    return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  }

  function normalizeBlockedUps(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const merged = new Map();
    value.forEach((item) => {
      const uid = String(item?.uid || '').trim();
      if (!/^\d{2,}$/.test(uid) || merged.has(uid)) {
        return;
      }
      merged.set(uid, {
        uid,
        name: String(item?.name || `UID ${uid}`).trim() || `UID ${uid}`,
        source: item?.source === 'official' ? 'official' : 'manual'
      });
    });
    return [...merged.values()];
  }

  function normalizeBlockedOrder(value) {
    return normalizeList(value).filter((key) => /^(?:uid|name):.+/.test(key));
  }

  function blockedOrderKey(entry) {
    const uid = String(entry?.uid || '').trim();
    if (uid) {
      return `uid:${uid}`;
    }
    const name = String(entry?.name || '').trim().toLocaleLowerCase();
    return name ? `name:${name}` : '';
  }

  function touchBlockedOrder(entries) {
    const touched = (Array.isArray(entries) ? entries : [entries])
      .map(blockedOrderKey)
      .filter(Boolean);
    const touchedSet = new Set(touched);
    state.blockedOrder = normalizeBlockedOrder([
      ...touched,
      ...state.blockedOrder.filter((key) => !touchedSet.has(key))
    ]);
  }

  function removeFromBlockedOrder(entry) {
    const key = blockedOrderKey(entry);
    state.blockedOrder = state.blockedOrder.filter((item) => item !== key);
  }

  function sharedSettingsSnapshot() {
    return BTFSharedState.normalizeSettings({
      titleKeywords: state.titleKeywords,
      upKeywords: state.upKeywords,
      categoryKeywords: state.categoryKeywords,
      tagKeywords: state.tagKeywords,
      specialTypes: state.specialTypes,
      blockedUpNames: state.blockedUpNames,
      blockedUps: state.blockedUps,
      blockedOrder: state.blockedOrder
    });
  }

  async function getSharedMeta() {
    const data = await storageGet('local', {
      [LOCAL_KEYS.sharedMeta]: { lastRevision: null, dirty: false }
    });
    const meta = data[LOCAL_KEYS.sharedMeta];
    return meta && typeof meta === 'object'
      ? { lastRevision: meta.lastRevision ?? null, dirty: meta.dirty === true }
      : { lastRevision: null, dirty: false };
  }

  function setSharedMeta(meta) {
    return storageSet('local', { [LOCAL_KEYS.sharedMeta]: meta });
  }

  function renderSharedState(status, detail, folderName = '') {
    const connected = status === 'connected';
    const warning = status === 'warning';
    sharedIndicator.textContent = connected ? '已连接' : warning ? '需授权' : status === 'busy' ? '更新中' : '未连接';
    sharedIndicator.classList.toggle('connected', connected);
    sharedIndicator.classList.toggle('warning', warning);
    sharedDetail.textContent = detail;
    openSharedSettingsButton.textContent = warning ? '完成长期授权' : '共享文件设置';
    refreshSharedStateButton.disabled = !connected;
    if (connected && folderName) {
      sharedDetail.textContent = `${folderName}\\${BTFSharedState.FILE_NAME} · 规则变更会自动写入`;
    }
  }

  function refreshEditorsFromState() {
    titleEditor?.setValues(state.titleKeywords);
    upEditor?.setValues(state.upKeywords);
    categoryEditor?.setValues(state.categoryKeywords);
    tagEditor?.setValues(state.tagKeywords);
    specialTypeEditor?.setValues(state.specialTypes);
    if (upList) {
      renderUpList();
    }
  }

  async function applySharedSettings(settings) {
    const next = BTFSharedState.normalizeSettings(settings);
    Object.assign(state, next);
    await Promise.all([
      storageSet('sync', {
        [SYNC_KEYS.titleKeywords]: next.titleKeywords,
        [SYNC_KEYS.upKeywords]: next.upKeywords,
        [SYNC_KEYS.categoryKeywords]: next.categoryKeywords,
        [SYNC_KEYS.tagKeywords]: next.tagKeywords,
        [SYNC_KEYS.specialTypes]: next.specialTypes,
        [SYNC_KEYS.specialTypesVersion]: SPECIAL_TYPES_VERSION
      }),
      storageSet('local', {
        [LOCAL_KEYS.blockedUpNames]: next.blockedUpNames,
        [LOCAL_KEYS.blockedUps]: next.blockedUps,
        [LOCAL_KEYS.blockedOrder]: next.blockedOrder
      })
    ]);
    refreshEditorsFromState();
  }

  async function mergeSharedState(forceUnion = false) {
    if (!sharedDirectoryHandle) {
      return;
    }
    renderSharedState('busy', '正在读取并合并共享状态……');
    const remote = await BTFSharedState.read(sharedDirectoryHandle);
    const meta = await getSharedMeta();
    const local = sharedSettingsSnapshot();
    let next = local;
    let envelope = remote;

    if (forceUnion || meta.lastRevision === null || meta.dirty || remote.revision === 0) {
      next = BTFSharedState.mergeSettings(remote.settings, local);
      envelope = await BTFSharedState.write(sharedDirectoryHandle, next, remote.revision);
      await applySharedSettings(next);
    } else if (remote.revision !== meta.lastRevision) {
      next = remote.settings;
      await applySharedSettings(next);
    }

    await setSharedMeta({ lastRevision: envelope.revision, dirty: false });
    sharedReady = true;
    renderSharedState('connected', '', sharedDirectoryHandle.name);
  }

  async function initializeSharedState() {
    try {
      sharedDirectoryHandle = await BTFSharedState.getStoredDirectory();
      if (!sharedDirectoryHandle) {
        renderSharedState('disconnected', '请在独立设置页中选择共享文件夹并完成长期授权。');
        return;
      }
      if (!await BTFSharedState.verifyPermission(sharedDirectoryHandle, false)) {
        renderSharedState('warning', '文件夹入口已保存；请到共享文件设置中完成长期授权。');
        return;
      }
      await mergeSharedState(false);
    } catch (error) {
      sharedReady = false;
      renderSharedState('warning', error.message);
    }
  }

  function openSharedSettings() {
    chrome.runtime.openOptionsPage();
  }

  async function refreshSharedStateNow() {
    try {
      if (!sharedDirectoryHandle) {
        openSharedSettings();
        return;
      }
      if (!await BTFSharedState.verifyPermission(sharedDirectoryHandle, false)) {
        renderSharedState('warning', '请先在共享文件设置中完成长期授权。');
        openSharedSettings();
        return;
      }
      await mergeSharedState(true);
      setStatus('已读取共享文件并与当前规则取并集');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        renderSharedState('warning', error.message);
        setStatus(`更新失败：${error.message}`, true);
      }
    }
  }

  async function flushSharedState() {
    if (!sharedDirectoryHandle || !sharedReady) {
      if (sharedDirectoryHandle) {
        const meta = await getSharedMeta();
        await setSharedMeta({ ...meta, dirty: true });
      }
      return;
    }

    const meta = await getSharedMeta();
    const remote = await BTFSharedState.read(sharedDirectoryHandle);
    let next = sharedSettingsSnapshot();
    if (meta.lastRevision !== null && remote.revision !== meta.lastRevision) {
      next = BTFSharedState.mergeSettings(remote.settings, next);
      await applySharedSettings(next);
    }
    const envelope = await BTFSharedState.write(sharedDirectoryHandle, next, remote.revision);
    await setSharedMeta({ lastRevision: envelope.revision, dirty: false });
    renderSharedState('connected', '', sharedDirectoryHandle.name);
  }

  function queueSharedWrite() {
    getSharedMeta()
      .then((meta) => setSharedMeta({ ...meta, dirty: true }))
      .catch(() => {});
    clearTimeout(sharedWriteTimer);
    sharedWriteTimer = setTimeout(() => {
      sharedWriteChain = sharedWriteChain
        .then(flushSharedState)
        .catch((error) => {
          sharedReady = false;
          renderSharedState('warning', `写入失败：${error.message}`);
          setStatus(`共享文件写入失败：${error.message}`, true);
        });
    }, 450);
  }

  function setStatus(message, isError = false) {
    clearTimeout(statusTimer);
    saveStatus.textContent = message;
    saveStatus.classList.toggle('error', isError);
    if (message) {
      statusTimer = setTimeout(() => {
        saveStatus.textContent = '';
        saveStatus.classList.remove('error');
      }, 2600);
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  class TagEditor {
    constructor(root, values, counter, onChange) {
      this.root = root;
      this.list = root.querySelector('.tag-list');
      this.input = root.querySelector('input');
      this.counter = counter;
      this.values = normalizeList(values);
      this.onChange = onChange;
      this.bind();
      this.render();
    }

    bind() {
      this.root.addEventListener('click', () => this.input.focus());
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
          event.preventDefault();
          this.addFromText(this.input.value);
        } else if (event.key === 'Backspace' && !this.input.value && this.values.length) {
          this.remove(this.values[this.values.length - 1]);
        }
      });
      this.input.addEventListener('blur', () => {
        if (this.input.value.trim()) {
          this.addFromText(this.input.value);
        }
      });
      this.input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') || '';
        if (!/[\n,，]/.test(text)) {
          return;
        }
        event.preventDefault();
        this.addFromText(text);
      });
    }

    addFromText(text) {
      const additions = text.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
      const next = normalizeList([...this.values, ...additions]);
      this.input.value = '';
      if (next.length === this.values.length) {
        return;
      }
      this.values = next;
      this.commit();
    }

    remove(value) {
      this.values = this.values.filter((item) => item !== value);
      this.commit();
    }

    setValues(values, shouldCommit = false) {
      this.values = normalizeList(values);
      this.render();
      if (shouldCommit) {
        this.onChange(this.values);
      }
    }

    commit() {
      this.render();
      this.onChange(this.values);
    }

    render() {
      this.list.replaceChildren();
      this.values.forEach((value) => {
        const tag = createElement('span', 'tag');
        const label = createElement('span', '', value);
        const remove = createElement('button', '', '×');
        remove.type = 'button';
        remove.title = `删除 ${value}`;
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          this.remove(value);
        });
        tag.append(label, remove);
        this.list.append(tag);
      });
      this.counter.textContent = String(this.values.length);
    }
  }

  async function saveSync(key, values) {
    try {
      await storageSet('sync', { [key]: values });
      if (SHARED_SYNC_KEYS.has(key)) {
        queueSharedWrite();
      }
      setStatus(Array.isArray(values) ? `已保存，共 ${values.length} 项` : '设置已保存');
    } catch (error) {
      setStatus(`保存失败：${error.message}`, true);
    }
  }

  function setupTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
        document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
        document.querySelector(`#panel-${tab.dataset.tab}`).classList.add('active');
        if (tab.dataset.tab === 'records') {
          refreshRecordData();
        }
      });
    });

    document.querySelectorAll('.segment').forEach((segment) => {
      segment.addEventListener('click', () => {
        state.recordMode = segment.dataset.recordMode;
        document.querySelectorAll('.segment').forEach((item) => item.classList.toggle('active', item === segment));
        renderRecords();
      });
    });
  }

  function sendTabMessage(message) {
    return new Promise((resolve) => {
      if (!state.activeTabId) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(state.activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  async function loadCurrentPage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://www.bilibili.com/')) {
      pageStatus.textContent = '打开B站首页后开始过滤';
      state.currentRecords = [];
      renderRecords();
      return;
    }
    state.activeTabId = tab.id;
    const response = await sendTabMessage({ type: 'BTF_GET_STATE' });
    if (!response?.active) {
      pageStatus.textContent = '请刷新B站首页以启用新版插件';
      state.currentRecords = [];
      renderRecords();
      return;
    }
    updateCurrentRecords(response.records);
  }

  function updateCurrentRecords(records) {
    state.currentRecords = state.enabled && Array.isArray(records) ? records : [];
    pageStatus.textContent = state.enabled
      ? `当前首页已匹配 ${state.currentRecords.length} 个视频`
      : '过滤已关闭，原有规则已保留';
    renderRecords();
  }

  async function refreshRecordData() {
    const localData = await storageGet('local', { [LOCAL_KEYS.history]: [] });
    state.history = Array.isArray(localData[LOCAL_KEYS.history]) ? localData[LOCAL_KEYS.history] : [];
    await loadCurrentPage();
  }

  function formatTime(timestamp) {
    if (!timestamp) {
      return '';
    }
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  function isUpBlocked(record) {
    if (record.upUid && state.blockedUps.some((item) => String(item.uid) === String(record.upUid))) {
      return true;
    }
    const exactNames = [
      ...state.blockedUpNames,
      ...state.blockedUps.map((item) => item.name).filter((name) => name && !/^UID\s+\d+$/i.test(name))
    ];
    return exactNames.some((name) => {
      return name.toLocaleLowerCase() === String(record.upName || '').toLocaleLowerCase();
    });
  }

  function blocklistCount() {
    const uidNames = new Set(
      state.blockedUps
        .map((item) => String(item.name || '').trim().toLocaleLowerCase())
        .filter((name) => name && !/^uid\s+\d+$/i.test(name))
    );
    const standaloneNames = state.blockedUpNames.filter((name) => !uidNames.has(name.toLocaleLowerCase()));
    return state.blockedUps.length + standaloneNames.length;
  }

  async function saveBlocklist(message = '') {
    try {
      await storageSet('local', {
        [LOCAL_KEYS.blockedUpNames]: state.blockedUpNames,
        [LOCAL_KEYS.blockedUps]: state.blockedUps,
        [LOCAL_KEYS.blockedOrder]: state.blockedOrder
      });
      queueSharedWrite();
      renderUpList();
      renderRecords();
      setStatus(message || `屏蔽名单已保存，共 ${blocklistCount()} 项`);
    } catch (error) {
      setStatus(`保存失败：${error.message}`, true);
    }
  }

  async function blockRecordUp(record) {
    if (record.upUid) {
      const upName = record.upName && record.upName !== '未读取到UP名称'
        ? record.upName
        : `UID ${record.upUid}`;
      state.blockedUps = [
        { uid: String(record.upUid), name: upName, source: 'manual' },
        ...state.blockedUps.filter((item) => String(item.uid) !== String(record.upUid))
      ];
      state.blockedUpNames = state.blockedUpNames.filter((name) => {
        return name.toLocaleLowerCase() !== upName.toLocaleLowerCase();
      });
      touchBlockedOrder({ uid: record.upUid });
    } else if (record.upName && record.upName !== '未读取到UP名称') {
      state.blockedUpNames = normalizeList([record.upName, ...state.blockedUpNames]);
      touchBlockedOrder({ name: record.upName });
    }
    await saveBlocklist('已加入屏蔽名单');
  }

  function createRecordItem(record) {
    const item = createElement('article', 'record-item');
    if (record.cover) {
      const image = createElement('img', 'record-cover');
      image.src = record.cover;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      item.append(image);
    } else {
      item.append(createElement('div', 'record-cover'));
    }

    const info = createElement('div');
    info.append(
      createElement('p', 'record-title', record.title),
      createElement('p', 'record-up', `${record.upName}${record.upUid ? ` · UID ${record.upUid}` : ''}`)
    );
    if (state.recordMode === 'history') {
      info.append(createElement('p', 'record-up', formatTime(record.matchedAt)));
    }
    item.append(info);

    const reasons = createElement('div', 'reason-list');
    (record.reasons || []).forEach((reason) => {
      reasons.append(createElement('span', `reason ${reason.type || ''}`, reason.label));
    });
    item.append(reasons);

    const actions = createElement('div', 'record-actions');
    if (record.url) {
      const open = createElement('a', '', '打开视频');
      open.href = record.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      actions.append(open);
    }
    if (state.recordMode === 'current') {
      const show = createElement('button', '', '本次显示');
      show.type = 'button';
      show.addEventListener('click', async () => {
        const response = await sendTabMessage({ type: 'BTF_SHOW_ONCE', id: record.id });
        if (response?.ok) {
          show.textContent = '已显示';
          show.disabled = true;
          setStatus('该视频已在当前页面恢复显示');
        }
      });
      actions.append(show);
    }
    const blockUp = createElement('button', '', isUpBlocked(record) ? '已在屏蔽名单' : '屏蔽这个UP');
    blockUp.type = 'button';
    blockUp.disabled = isUpBlocked(record);
    blockUp.addEventListener('click', () => blockRecordUp(record));
    actions.append(blockUp);
    item.append(actions);
    return item;
  }

  function renderRecords() {
    const records = state.recordMode === 'current' ? state.currentRecords : state.history;
    recordList.replaceChildren();
    if (!records.length) {
      recordList.append(createElement(
        'div',
        'empty-state',
        state.recordMode === 'current'
          ? (state.enabled ? '当前首页没有匹配到视频。若刚更新插件，请刷新B站首页。' : '过滤已关闭，首页视频正常显示。')
          : '最近还没有屏蔽记录。'
      ));
      return;
    }
    BTFRecordGroups.groupRecords(records).forEach((group) => {
      if (group.id === 'other' && !group.records.length) return;
      const section = createElement('section', 'record-group');
      section.dataset.recordGroup = group.id;
      const heading = createElement('div', 'record-group-heading');
      heading.append(createElement('h2', '', group.title), createElement('span', 'count-pill', String(group.records.length)));
      section.append(heading, createElement('p', 'record-group-description', group.description));
      const list = createElement('div', 'record-list');
      group.records.forEach((record) => list.append(createRecordItem(record)));
      if (!group.records.length) list.append(createElement('p', 'record-group-description', '暂无此类记录'));
      section.append(list);
      recordList.append(section);
    });
  }

  function parseBlockEntry(value) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    const linkUid = text.match(/space\.bilibili\.com\/(\d{2,})/i)?.[1];
    if (linkUid) {
      return { type: 'uid', uid: linkUid, name: `UID ${linkUid}` };
    }
    const namedUid = text.match(/^(.+?)\s*[|｜]\s*(?:UID\s*[:：]?\s*)?(\d{2,})$/i);
    if (namedUid) {
      return { type: 'uid', uid: namedUid[2], name: namedUid[1].trim() || `UID ${namedUid[2]}` };
    }
    const directUid = text.match(/^(?:UID\s*[:：]?\s*)?(\d{2,})$/i)?.[1];
    if (directUid) {
      return { type: 'uid', uid: directUid, name: `UID ${directUid}` };
    }
    return { type: 'name', name: text };
  }

  async function resolveUpName(uid) {
    try {
      const response = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(uid)}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        return '';
      }
      const result = await response.json();
      return result.code === 0 ? String(result.data?.card?.name || '').trim() : '';
    } catch {
      return '';
    }
  }

  async function addBlockEntry() {
    const entries = blockInput.value
      .split(/\r?\n/)
      .map(parseBlockEntry)
      .filter(Boolean);
    if (!entries.length) {
      setStatus('请输入UP名称、UID或空间链接', true);
      return;
    }
    for (const entry of entries) {
      if (entry.type === 'uid') {
        const existing = state.blockedUps.find((item) => String(item.uid) === entry.uid);
        let name = entry.name;
        if (/^UID\s+\d+$/i.test(name)) {
          name = existing?.name && !/^UID\s+\d+$/i.test(existing.name)
            ? existing.name
            : await resolveUpName(entry.uid) || name;
        }
        state.blockedUps = [
          {
            uid: entry.uid,
            name,
            source: existing?.source === 'official' ? 'official' : 'manual'
          },
          ...state.blockedUps.filter((item) => String(item.uid) !== entry.uid)
        ];
        if (name && !/^UID\s+\d+$/i.test(name)) {
          state.blockedUpNames = state.blockedUpNames.filter((item) => {
            return item.toLocaleLowerCase() !== name.toLocaleLowerCase();
          });
        }
        touchBlockedOrder({ uid: entry.uid });
      } else {
        const coveredByUid = state.blockedUps.find((item) => {
          return String(item.name || '').toLocaleLowerCase() === entry.name.toLocaleLowerCase();
        });
        if (!coveredByUid) {
          state.blockedUpNames = normalizeList([entry.name, ...state.blockedUpNames]);
          touchBlockedOrder({ name: entry.name });
        } else {
          touchBlockedOrder({ uid: coveredByUid.uid });
        }
      }
    }
    blockInput.value = '';
    await saveBlocklist(`已添加 ${entries.length} 项屏蔽条件`);
  }

  function renderUpList() {
    const query = upSearch.value.trim().toLocaleLowerCase();
    const uidNames = new Set(
      state.blockedUps
        .map((item) => String(item.name || '').trim().toLocaleLowerCase())
        .filter((name) => name && !/^uid\s+\d+$/i.test(name))
    );
    const manualNames = state.blockedUpNames
      .filter((name) => !uidNames.has(name.toLocaleLowerCase()))
      .map((name) => ({ type: 'name', name, uid: '', source: 'manual' }));
    const uidEntries = state.blockedUps
      .map((item) => ({ ...item, type: 'uid' }))
      .sort((a, b) => Number(a.source === 'official') - Number(b.source === 'official'));
    const orderIndex = new Map(state.blockedOrder.map((key, index) => [key, index]));
    const allItems = [...manualNames, ...uidEntries]
      .map((item, fallbackIndex) => ({ item, fallbackIndex }))
      .sort((a, b) => {
        const aIndex = orderIndex.get(blockedOrderKey(a.item));
        const bIndex = orderIndex.get(blockedOrderKey(b.item));
        if (aIndex !== undefined || bIndex !== undefined) {
          return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
        }
        return a.fallbackIndex - b.fallbackIndex;
      })
      .map(({ item }) => item);
    const items = allItems.filter((item) => {
      return !query
        || String(item.uid || '').includes(query)
        || String(item.name || '').toLocaleLowerCase().includes(query);
    });
    document.querySelector('#block-count').textContent = String(allItems.length);
    upList.replaceChildren();
    if (!items.length) {
      upList.append(createElement('div', 'empty-state', allItems.length ? '没有匹配的屏蔽项' : '屏蔽名单为空'));
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((up) => {
      const row = createElement('div', 'up-item');
      row.append(createElement('strong', '', up.name || `UID ${up.uid}`));
      const meta = createElement('div', 'up-meta', up.uid ? `UID ${up.uid}` : '按完整名称精确屏蔽');
      meta.append(createElement(
        'span',
        'source-badge',
        up.source === 'official' ? 'B站拉黑' : up.uid ? '名称 + UID' : '仅名称'
      ));
      row.append(meta);
      const remove = createElement('button', 'delete-up', '×');
      remove.type = 'button';
      remove.title = '从屏蔽名单移除';
      remove.addEventListener('click', async () => {
        if (up.type === 'uid') {
          state.blockedUps = state.blockedUps.filter((item) => String(item.uid) !== String(up.uid));
          state.blockedUpNames = state.blockedUpNames.filter((name) => {
            return name.toLocaleLowerCase() !== String(up.name || '').toLocaleLowerCase();
          });
        } else {
          state.blockedUpNames = state.blockedUpNames.filter((name) => name !== up.name);
        }
        removeFromBlockedOrder(up);
        await saveBlocklist('已从屏蔽名单移除');
      });
      row.append(remove);
      fragment.append(row);
    });
    upList.append(fragment);
  }

  async function importOfficialBlacklist() {
    importButton.disabled = true;
    importStatus.textContent = '正在读取……';
    try {
      const imported = [];
      const pageSize = 50;
      for (let page = 1; page <= 100; page += 1) {
        const response = await fetch(`https://api.bilibili.com/x/relation/blacks?pn=${page}&ps=${pageSize}&re_version=0`, {
          credentials: 'include'
        });
        if (!response.ok) {
          throw new Error(`请求失败（${response.status}）`);
        }
        const result = await response.json();
        if (result.code === -101) {
          throw new Error('请先登录B站账号');
        }
        if (result.code !== 0 || !result.data) {
          throw new Error(result.message || `接口返回错误 ${result.code}`);
        }
        const list = Array.isArray(result.data.list) ? result.data.list : [];
        list.forEach((item) => {
          if (item.mid) {
            imported.push({ uid: String(item.mid), name: item.uname || `UID ${item.mid}`, source: 'official' });
          }
        });
        const total = Number(result.data.total || 0);
        if (!list.length || list.length < pageSize || (total > 0 && imported.length >= total)) {
          break;
        }
      }

      const existingUids = new Set(state.blockedUps.map((item) => String(item.uid)));
      const newlyImported = imported.filter((item) => !existingUids.has(String(item.uid)));
      const merged = new Map();
      state.blockedUps.filter((item) => item.source !== 'official').forEach((item) => merged.set(String(item.uid), item));
      imported.forEach((item) => {
        if (!merged.has(String(item.uid))) {
          merged.set(String(item.uid), item);
        }
      });
      state.blockedUps = [...merged.values()];
      if (newlyImported.length) {
        touchBlockedOrder(newlyImported);
      }
      await saveBlocklist(`已同步 ${imported.length} 人`);
      importStatus.textContent = `已同步 ${imported.length} 人`;
    } catch (error) {
      importStatus.textContent = error.message;
      setStatus(`同步失败：${error.message}`, true);
    } finally {
      importButton.disabled = false;
    }
  }

  async function clearHistory() {
    state.history = [];
    await storageSet('local', { [LOCAL_KEYS.history]: [] });
    renderRecords();
    setStatus('屏蔽记录已清空');
  }

  async function loadData() {
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
    const localData = await storageGet('local', {
      [LOCAL_KEYS.blockedUpNames]: [],
      [LOCAL_KEYS.blockedUps]: [],
      [LOCAL_KEYS.blockedOrder]: [],
      [LOCAL_KEYS.history]: []
    });

    state.enabled = syncData[SYNC_KEYS.enabled] !== false;
    state.titleKeywords = normalizeList(
      syncData[SYNC_KEYS.titleKeywords]
        ?? syncData[SYNC_KEYS.legacyTitleKeywords]
        ?? DEFAULTS.titleKeywords,
      DEFAULTS.titleKeywords
    );
    state.upKeywords = normalizeList(syncData[SYNC_KEYS.upKeywords], DEFAULTS.upKeywords);
    state.categoryKeywords = normalizeList(syncData[SYNC_KEYS.categoryKeywords]);
    state.tagKeywords = normalizeList(syncData[SYNC_KEYS.tagKeywords]);
    state.specialTypes = normalizeList(syncData[SYNC_KEYS.specialTypes], DEFAULTS.specialTypes);
    if (Number(syncData[SYNC_KEYS.specialTypesVersion] || 0) < SPECIAL_TYPES_VERSION) {
      state.specialTypes = normalizeList([...state.specialTypes, ...DEFAULTS.specialTypes]);
      await storageSet('sync', {
        [SYNC_KEYS.specialTypes]: state.specialTypes,
        [SYNC_KEYS.specialTypesVersion]: SPECIAL_TYPES_VERSION
      });
    }
    state.qualityEnabled = syncData[SYNC_KEYS.qualityEnabled] !== false;
    state.qualityMode = ['loose', 'standard', 'strict'].includes(syncData[SYNC_KEYS.qualityMode])
      ? syncData[SYNC_KEYS.qualityMode]
      : DEFAULTS.qualityMode;
    state.blockedUpNames = normalizeList(localData[LOCAL_KEYS.blockedUpNames]);
    state.blockedUps = normalizeBlockedUps(localData[LOCAL_KEYS.blockedUps]);
    state.blockedOrder = normalizeBlockedOrder(localData[LOCAL_KEYS.blockedOrder]);
    if (!state.blockedOrder.length) {
      state.blockedOrder = BTFSharedState.normalizeSettings({
        blockedUpNames: state.blockedUpNames,
        blockedUps: state.blockedUps
      }).blockedOrder;
    }
    state.history = Array.isArray(localData[LOCAL_KEYS.history]) ? localData[LOCAL_KEYS.history] : [];

    if (syncData[SYNC_KEYS.titleKeywords] === null) {
      await storageSet('sync', { [SYNC_KEYS.titleKeywords]: state.titleKeywords });
    }
  }

  function setupEditors() {
    titleEditor = new TagEditor(
      document.querySelector('#title-editor'),
      state.titleKeywords,
      document.querySelector('#title-keyword-count'),
      (values) => {
        state.titleKeywords = values;
        saveSync(SYNC_KEYS.titleKeywords, values);
      }
    );
    upEditor = new TagEditor(
      document.querySelector('#up-editor'),
      state.upKeywords,
      document.querySelector('#up-keyword-count'),
      (values) => {
        state.upKeywords = values;
        saveSync(SYNC_KEYS.upKeywords, values);
      }
    );
    categoryEditor = new TagEditor(
      document.querySelector('#category-editor'),
      state.categoryKeywords,
      document.querySelector('#category-keyword-count'),
      (values) => {
        state.categoryKeywords = values;
        saveSync(SYNC_KEYS.categoryKeywords, values);
      }
    );
    tagEditor = new TagEditor(
      document.querySelector('#tag-editor'),
      state.tagKeywords,
      document.querySelector('#tag-keyword-count'),
      (values) => {
        state.tagKeywords = values;
        saveSync(SYNC_KEYS.tagKeywords, values);
      }
    );
    specialTypeEditor = new TagEditor(
      document.querySelector('#special-type-editor'),
      state.specialTypes,
      document.querySelector('#special-type-count'),
      (values) => {
        state.specialTypes = values;
        saveSync(SYNC_KEYS.specialTypes, values);
      }
    );
  }

  function renderQualityControls() {
    const descriptions = {
      loose: '宽松：质量分低于30时隐藏，只处理非常明显的低质视频。',
      standard: '标准：质量分低于42时隐藏，综合互动表现和重复推荐。',
      strict: '严格：质量分低于52时隐藏，首页会明显减少。'
    };
    const checkbox = document.querySelector('#quality-enabled');
    checkbox.checked = state.qualityEnabled;
    document.querySelector('.quality-modes').classList.toggle('disabled', !state.qualityEnabled);
    document.querySelectorAll('[data-quality-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.qualityMode === state.qualityMode);
    });
    document.querySelector('#quality-description').textContent = state.qualityEnabled
      ? descriptions[state.qualityMode]
      : '质量过滤已关闭，关键词、屏蔽名单、特殊类型、分区和标签规则仍然生效。';
  }

  function renderEnabledControl() {
    document.querySelector('#filter-enabled').checked = state.enabled;
    document.querySelector('#filter-enabled-label').textContent = state.enabled ? '已开启' : '已关闭';
  }

  function bindActions() {
    document.querySelector('#filter-enabled').addEventListener('change', async (event) => {
      const checkbox = event.target;
      checkbox.disabled = true;
      try {
        await storageSet('sync', { [SYNC_KEYS.enabled]: checkbox.checked });
        state.enabled = checkbox.checked;
        if (!state.enabled) state.currentRecords = [];
        renderEnabledControl();
        await loadCurrentPage();
        setStatus(state.enabled ? '过滤已开启' : '过滤已关闭，原有规则已保留');
      } catch (error) {
        renderEnabledControl();
        setStatus(`保存失败：${error.message}`, true);
      } finally {
        checkbox.disabled = false;
      }
    });
    document.querySelector('#quality-enabled').addEventListener('change', async (event) => {
      state.qualityEnabled = event.target.checked;
      renderQualityControls();
      await saveSync(SYNC_KEYS.qualityEnabled, state.qualityEnabled);
    });
    document.querySelectorAll('[data-quality-mode]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.qualityMode = button.dataset.qualityMode;
        renderQualityControls();
        await saveSync(SYNC_KEYS.qualityMode, state.qualityMode);
      });
    });
    document.querySelector('#add-block').addEventListener('click', addBlockEntry);
    blockInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        addBlockEntry();
      }
    });
    importButton.addEventListener('click', importOfficialBlacklist);
    upSearch.addEventListener('input', renderUpList);
    document.querySelector('#clear-history').addEventListener('click', clearHistory);
    openSharedSettingsButton.addEventListener('click', openSharedSettings);
    refreshSharedStateButton.addEventListener('click', refreshSharedStateNow);

    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type !== 'BTF_STATE_CHANGED') {
        return;
      }
      if (state.activeTabId && sender.tab?.id && sender.tab.id !== state.activeTabId) {
        return;
      }
      if (Array.isArray(message.history)) {
        state.history = message.history;
      }
      updateCurrentRecords(message.records);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes[SYNC_KEYS.enabled]) {
        state.enabled = changes[SYNC_KEYS.enabled].newValue !== false;
        renderEnabledControl();
        if (!state.enabled) updateCurrentRecords([]);
        else loadCurrentPage();
      }
      if (areaName !== 'local' || !changes[LOCAL_KEYS.history]) {
        return;
      }
      state.history = Array.isArray(changes[LOCAL_KEYS.history].newValue)
        ? changes[LOCAL_KEYS.history].newValue
        : [];
      if (state.recordMode === 'history') {
        renderRecords();
      }
    });
  }

  async function init() {
    setupTabs();
    await loadData();
    setupEditors();
    renderEnabledControl();
    renderQualityControls();
    bindActions();
    renderUpList();
    renderRecords();
    await initializeSharedState();
    await loadCurrentPage();
  }

  init().catch((error) => {
    pageStatus.textContent = '插件初始化失败';
    setStatus(error.message, true);
  });
})();
