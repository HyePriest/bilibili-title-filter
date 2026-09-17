(() => {
  'use strict';

  const SYNC_KEYS = {
    titleKeywords: 'btfTitleKeywords',
    upKeywords: 'btfUpKeywords',
    categoryKeywords: 'btfCategoryKeywords',
    tagKeywords: 'btfTagKeywords',
    specialTypes: 'btfSpecialTypes',
    specialTypesVersion: 'btfSpecialTypesVersion',
    legacyTitleKeywords: 'blockedKeywords'
  };
  const LOCAL_KEYS = {
    blockedUpNames: 'btfBlockedUpNames',
    blockedUps: 'btfBlockedUps',
    blockedOrder: 'btfBlockedOrder',
    sharedMeta: 'btfSharedFileMeta'
  };
  const DEFAULTS = {
    titleKeywords: ['大型纪录片'],
    upKeywords: ['纪录片', '记录片'],
    categoryKeywords: [],
    tagKeywords: [],
    specialTypes: BTFSpecialTypes.DEFAULT_TYPES
  };

  const folderName = document.querySelector('#folder-name');
  const permissionState = document.querySelector('#permission-state');
  const permissionHelp = document.querySelector('#permission-help');
  const authorizeButton = document.querySelector('#authorize-folder');
  const chooseButton = document.querySelector('#choose-folder');
  const mergeButton = document.querySelector('#merge-now');
  const forgetButton = document.querySelector('#forget-folder');
  const actionStatus = document.querySelector('#action-status');
  let directoryHandle = null;

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

  async function loadLocalSettings() {
    const syncData = await storageGet('sync', {
      [SYNC_KEYS.titleKeywords]: null,
      [SYNC_KEYS.upKeywords]: DEFAULTS.upKeywords,
      [SYNC_KEYS.categoryKeywords]: DEFAULTS.categoryKeywords,
      [SYNC_KEYS.tagKeywords]: DEFAULTS.tagKeywords,
      [SYNC_KEYS.specialTypes]: DEFAULTS.specialTypes,
      [SYNC_KEYS.legacyTitleKeywords]: DEFAULTS.titleKeywords
    });
    const localData = await storageGet('local', {
      [LOCAL_KEYS.blockedUpNames]: [],
      [LOCAL_KEYS.blockedUps]: [],
      [LOCAL_KEYS.blockedOrder]: []
    });
    return BTFSharedState.normalizeSettings({
      titleKeywords: syncData[SYNC_KEYS.titleKeywords]
        ?? syncData[SYNC_KEYS.legacyTitleKeywords]
        ?? DEFAULTS.titleKeywords,
      upKeywords: syncData[SYNC_KEYS.upKeywords],
      categoryKeywords: syncData[SYNC_KEYS.categoryKeywords],
      tagKeywords: syncData[SYNC_KEYS.tagKeywords],
      specialTypes: syncData[SYNC_KEYS.specialTypes],
      blockedUpNames: localData[LOCAL_KEYS.blockedUpNames],
      blockedUps: localData[LOCAL_KEYS.blockedUps],
      blockedOrder: localData[LOCAL_KEYS.blockedOrder]
    });
  }

  async function applySettings(settings) {
    const next = BTFSharedState.normalizeSettings(settings);
    await Promise.all([
      storageSet('sync', {
        [SYNC_KEYS.titleKeywords]: next.titleKeywords,
        [SYNC_KEYS.upKeywords]: next.upKeywords,
        [SYNC_KEYS.categoryKeywords]: next.categoryKeywords,
        [SYNC_KEYS.tagKeywords]: next.tagKeywords,
        [SYNC_KEYS.specialTypes]: next.specialTypes,
        [SYNC_KEYS.specialTypesVersion]: BTFSpecialTypes.VERSION
      }),
      storageSet('local', {
        [LOCAL_KEYS.blockedUpNames]: next.blockedUpNames,
        [LOCAL_KEYS.blockedUps]: next.blockedUps,
        [LOCAL_KEYS.blockedOrder]: next.blockedOrder
      })
    ]);
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

  async function mergeSharedState(forceUnion = false) {
    if (!directoryHandle) {
      return;
    }
    setActionStatus('正在读取并合并共享状态……');
    const remote = await BTFSharedState.read(directoryHandle);
    const local = await loadLocalSettings();
    const meta = await getSharedMeta();
    let next = local;
    let envelope = remote;
    if (forceUnion || meta.lastRevision === null || meta.dirty || remote.revision === 0) {
      next = BTFSharedState.mergeSettings(remote.settings, local);
      envelope = await BTFSharedState.write(directoryHandle, next, remote.revision);
      await applySettings(next);
    } else if (remote.revision !== meta.lastRevision) {
      next = remote.settings;
      await applySettings(next);
    }
    await setSharedMeta({ lastRevision: envelope.revision, dirty: false });
    renderConnected();
    setActionStatus(`合并完成：${next.blockedUpNames.length + next.blockedUps.length} 条屏蔽名单记录`);
  }

  function setActionStatus(message, isError = false) {
    actionStatus.textContent = message;
    actionStatus.classList.toggle('error', isError);
  }

  function renderDisconnected() {
    folderName.textContent = '尚未选择共享文件夹';
    permissionState.textContent = '未连接';
    permissionState.className = 'status-badge';
    permissionHelp.textContent = '首次使用时，请在 Chrome 和 Edge 中分别选择同一个插件文件夹。';
    permissionHelp.className = 'permission-help';
    authorizeButton.hidden = true;
    chooseButton.textContent = '选择共享文件夹';
    mergeButton.disabled = true;
    forgetButton.hidden = true;
  }

  function renderNeedsPermission() {
    folderName.textContent = `${directoryHandle.name}\\${BTFSharedState.FILE_NAME}`;
    permissionState.textContent = '需要长期授权';
    permissionState.className = 'status-badge warning';
    permissionHelp.textContent = '点击“授予长期权限”，并在浏览器弹窗中选择“每次访问时允许”。';
    permissionHelp.className = 'permission-help warning';
    authorizeButton.hidden = false;
    chooseButton.textContent = '更换文件夹';
    mergeButton.disabled = true;
    forgetButton.hidden = false;
  }

  function renderConnected(justPicked = false) {
    folderName.textContent = `${directoryHandle.name}\\${BTFSharedState.FILE_NAME}`;
    permissionState.textContent = '已连接';
    permissionState.className = 'status-badge connected';
    permissionHelp.textContent = justPicked
      ? '当前连接已经完成。若下次打开又显示需要授权，请点击“授予长期权限”并选择“每次访问时允许”。'
      : '读写权限有效，插件会对两个浏览器的规则和屏蔽名单取并集。';
    permissionHelp.className = 'permission-help';
    authorizeButton.hidden = true;
    chooseButton.textContent = '更换文件夹';
    mergeButton.disabled = false;
    forgetButton.hidden = false;
  }

  async function chooseFolder() {
    try {
      directoryHandle = await BTFSharedState.chooseDirectory();
      await setSharedMeta({ lastRevision: null, dirty: true });
      await mergeSharedState(true);
      renderConnected(true);
      setActionStatus('文件夹已连接，现有规则已经取并集');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setActionStatus(`连接失败：${error.message}`, true);
      }
    }
  }

  async function authorizeFolder() {
    try {
      setActionStatus('请在浏览器弹窗中选择“每次访问时允许”');
      if (!await BTFSharedState.verifyPermission(directoryHandle, true)) {
        throw new Error('没有获得文件夹读写权限');
      }
      await mergeSharedState(true);
      setActionStatus('长期授权已确认，规则已经取并集');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        renderNeedsPermission();
        setActionStatus(`授权失败：${error.message}`, true);
      }
    }
  }

  async function mergeNow() {
    try {
      if (!await BTFSharedState.verifyPermission(directoryHandle, false)) {
        renderNeedsPermission();
        return;
      }
      await mergeSharedState(true);
    } catch (error) {
      setActionStatus(`合并失败：${error.message}`, true);
    }
  }

  async function forgetFolder() {
    try {
      await BTFSharedState.clearStoredDirectory();
      await setSharedMeta({ lastRevision: null, dirty: false });
      directoryHandle = null;
      renderDisconnected();
      setActionStatus('已取消连接；原共享文件没有被删除');
    } catch (error) {
      setActionStatus(`取消失败：${error.message}`, true);
    }
  }

  async function init() {
    chooseButton.addEventListener('click', chooseFolder);
    authorizeButton.addEventListener('click', authorizeFolder);
    mergeButton.addEventListener('click', mergeNow);
    forgetButton.addEventListener('click', forgetFolder);
    directoryHandle = await BTFSharedState.getStoredDirectory();
    if (!directoryHandle) {
      renderDisconnected();
      return;
    }
    if (!await BTFSharedState.verifyPermission(directoryHandle, false)) {
      renderNeedsPermission();
      return;
    }
    renderConnected();
    await mergeSharedState(false);
  }

  init().catch((error) => {
    setActionStatus(`设置页初始化失败：${error.message}`, true);
  });
})();
