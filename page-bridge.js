(() => {
  'use strict';

  if (location.pathname !== '/' && location.pathname !== '/index.html') {
    return;
  }

  const REQUEST_EVENT = 'btf-native-dislike-request';
  const RESPONSE_EVENT = 'btf-native-dislike-response';
  const activeCards = new WeakSet();

  function wait(delay) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  function dispatchPointerPresence(element) {
    if (!element) {
      return;
    }
    ['mouseenter', 'mouseover'].forEach((type) => {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: type === 'mouseover',
        cancelable: true,
        view: window
      }));
    });
  }

  function isVisible(element) {
    if (!element?.isConnected) {
      return false;
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  }

  function findContentDislikeOption(anchor) {
    const selector = [
      '.bili-video-card__info--no-interest-panel--item',
      '.bili-live-card__info--no-interest-panel--item'
    ].join(',');
    const candidates = [...document.querySelectorAll(selector)].filter((element) => (
      element.textContent?.trim() === '内容不感兴趣' && isVisible(element)
    ));
    const anchorRect = anchor.getBoundingClientRect();
    return candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftDistance = Math.abs(leftRect.left - anchorRect.left)
        + Math.abs(leftRect.top - anchorRect.bottom);
      const rightDistance = Math.abs(rightRect.left - anchorRect.left)
        + Math.abs(rightRect.top - anchorRect.bottom);
      return leftDistance - rightDistance;
    })[0] || null;
  }

  async function waitForElement(readElement, timeout = 1200) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = readElement();
      if (element) {
        return element;
      }
      await wait(40);
    }
    return null;
  }

  function respond(card, requestId, status, message = '') {
    card.dataset.btfNativeDislikeResponseId = requestId;
    card.dataset.btfNativeDislikeStatus = status;
    card.dataset.btfNativeDislikeMessage = message;
    card.dispatchEvent(new Event(RESPONSE_EVENT, { bubbles: true }));
  }

  async function triggerNativeDislike(card, requestId) {
    const nativeCard = card.matches?.('.enable-no-interest')
      ? card
      : card.querySelector('.enable-no-interest');
    if (!nativeCard) {
      throw new Error('这张卡片没有 B 站原生“不感兴趣”功能');
    }

    const wrap = nativeCard.querySelector(
      '.bili-video-card__wrap, .bili-live-card__wrap'
    );
    const trigger = nativeCard.querySelector(
      '.bili-video-card__info--no-interest, .bili-live-card__info--no-interest'
    );
    if (!trigger) {
      throw new Error('没有找到 B 站原生“不感兴趣”入口');
    }

    dispatchPointerPresence(wrap || nativeCard);
    dispatchPointerPresence(trigger.parentElement);
    dispatchPointerPresence(trigger);

    const option = await waitForElement(() => findContentDislikeOption(trigger));
    if (!option) {
      throw new Error('B 站原生“不感兴趣”菜单没有展开');
    }
    option.click();

    const applied = await waitForElement(() => {
      const overlay = nativeCard.querySelector(
        '.bili-video-card__no-interest, .bili-live-card__no-interest'
      );
      return isVisible(overlay) ? overlay : null;
    }, 800);
    if (!applied) {
      throw new Error('B 站原生“不感兴趣”状态没有生效');
    }
    respond(card, requestId, 'ok');
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const card = event.target?.closest?.('.feed-card, .bili-feed-card, .bili-video-card');
    const requestId = String(card?.dataset.btfNativeDislikeRequestId || '');
    if (!card || !requestId || activeCards.has(card)) {
      return;
    }
    activeCards.add(card);
    triggerNativeDislike(card, requestId)
      .catch((error) => {
        respond(card, requestId, 'error', String(error?.message || error));
      })
      .finally(() => {
        activeCards.delete(card);
      });
  }, true);
})();
