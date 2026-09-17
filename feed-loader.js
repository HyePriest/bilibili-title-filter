(() => {
  'use strict';

  // The current homepage checks the bottom of this anchor on document scroll
  // (200px preload margin). Filtering changes its position without scrolling.
  const ANCHOR_SELECTOR = 'main .load-more-anchor';
  const PRELOAD_MARGIN = 200;
  const RETRY_DELAY = 1500;
  const MAX_STALLED_ATTEMPTS = 3;
  const MAX_BURST = 6;
  const BURST_COOLDOWN = 15000;

  function create({ isActive }) {
    let timer = 0;
    let disposed = false;
    let lastRequest = 0;
    let stalledAttempts = 0;
    let burstAttempts = 0;
    let lastAnchor = null;
    let lastParent = null;
    let lastChildCount = -1;
    let lastPreviousSibling = null;
    let orderedAnchor = null;
    const orderedPlaceholders = new Set();

    function isPlaceholder(element) {
      return Boolean(element?.matches('.bili-video-card, .floor-single-card')
        && element.querySelector('.bili-video-card__skeleton, .floor-skeleton'));
    }

    function clearPlaceholderOrder() {
      orderedAnchor?.removeAttribute('data-btf-load-anchor');
      orderedAnchor = null;
      orderedPlaceholders.forEach(element => element.removeAttribute('data-btf-load-placeholder'));
      orderedPlaceholders.clear();
    }

    function alignLoadingAnchor(anchor) {
      // Bilibili renders a row of video skeletons BEFORE its floor-card anchor.
      // Once filtering packs surviving videos into partial rows, that anchor can
      // be a full row below already-visible vacancies. Put the anchor first in
      // the loading tail using CSS order, leaving Vue's DOM and loaded cards intact.
      if (getComputedStyle(anchor.parentElement).display !== 'grid') {
        clearPlaceholderOrder();
        return;
      }
      const placeholders = new Set();
      for (let node = anchor.previousElementSibling; isPlaceholder(node); node = node.previousElementSibling) {
        placeholders.add(node);
      }
      for (let node = anchor.nextElementSibling; node; node = node.nextElementSibling) {
        if (!isPlaceholder(node)) {
          clearPlaceholderOrder();
          return;
        }
        placeholders.add(node);
      }
      if (!placeholders.size) {
        clearPlaceholderOrder();
        return;
      }
      if (orderedAnchor !== anchor) {
        orderedAnchor?.removeAttribute('data-btf-load-anchor');
        orderedAnchor = anchor;
        anchor.setAttribute('data-btf-load-anchor', 'true');
      }
      orderedPlaceholders.forEach(element => {
        if (!placeholders.has(element)) {
          element.removeAttribute('data-btf-load-placeholder');
          orderedPlaceholders.delete(element);
        }
      });
      placeholders.forEach(element => {
        if (!orderedPlaceholders.has(element)) {
          element.setAttribute('data-btf-load-placeholder', 'true');
          orderedPlaceholders.add(element);
        }
      });
    }

    function schedule(delay = 350) {
      if (disposed || timer) return;
      timer = setTimeout(check, Math.max(delay, lastRequest + RETRY_DELAY - Date.now()));
    }

    function check() {
      timer = 0;
      if (disposed || !isActive() || document.visibilityState === 'hidden') return;

      const anchor = document.querySelector(ANCHOR_SELECTOR);
      if (!anchor) {
        clearPlaceholderOrder();
        lastAnchor = null;
        stalledAttempts = 0;
        return;
      }
      alignLoadingAnchor(anchor);
      const rect = anchor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom >= innerHeight + PRELOAD_MARGIN) return;

      const parent = anchor.parentElement;
      const childCount = parent.childElementCount;
      const previousSibling = anchor.previousElementSibling;
      if (anchor !== lastAnchor || parent !== lastParent
        || childCount !== lastChildCount || previousSibling !== lastPreviousSibling) {
        stalledAttempts = 0;
        lastAnchor = anchor;
        lastParent = parent;
        lastChildCount = childCount;
        lastPreviousSibling = previousSibling;
      }

      // This class is Bilibili's own request-in-progress indicator on the anchor.
      // Let slow requests finish; never reset the site's loading state.
      if (anchor.querySelector('.floor-skeleton.show-animation')) {
        schedule(RETRY_DELAY);
        return;
      }
      if (stalledAttempts >= MAX_STALLED_ATTEMPTS) return;

      const elapsed = Date.now() - lastRequest;
      if (burstAttempts >= MAX_BURST) {
        if (elapsed < BURST_COOLDOWN) {
          schedule(BURST_COOLDOWN - elapsed);
          return;
        }
        burstAttempts = 0;
      }
      stalledAttempts += 1;
      burstAttempts += 1;
      lastRequest = Date.now();

      // Bubble from document so the native window listener receives the same
      // target as a real page scroll, without moving the viewport or refreshing.
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      schedule(RETRY_DELAY);
    }

    function resume() {
      stalledAttempts = 0;
      burstAttempts = 0;
      schedule();
    }

    function onScroll(event) {
      // Our synthetic notification must not replenish its own retry budget.
      if (event.isTrusted) resume();
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'hidden') resume();
    }

    function dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = 0;
      clearPlaceholderOrder();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resume);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', resume, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return { schedule, dispose };
  }

  globalThis.BTFFeedLoader = { create };
})();
