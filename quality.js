(() => {
  'use strict';

  const THRESHOLDS = {
    loose: 30,
    standard: 42,
    strict: 52
  };
  const PRIOR = {
    views: 3000,
    coinRate: 0.01,
    favoriteRate: 0.006,
    likeRate: 0.04
  };

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function smoothedRate(count, views, priorRate) {
    return (number(count) + PRIOR.views * priorRate) / (number(views) + PRIOR.views);
  }

  function evaluate(detail, context = {}, mode = 'standard') {
    let score = 60;
    const details = [];
    const stat = detail?.stat || {};
    const views = number(stat.view);

    function adjust(points, label) {
      score += points;
      details.push({ points, label });
    }

    if (views > 0) {
      const coinRate = smoothedRate(stat.coin, views, PRIOR.coinRate);
      const favoriteRate = smoothedRate(stat.favorite, views, PRIOR.favoriteRate);
      const likeRate = smoothedRate(stat.like, views, PRIOR.likeRate);

      if (coinRate >= 0.025) {
        adjust(10, '投币表现优秀');
      } else if (coinRate >= 0.015) {
        adjust(5, '投币表现较好');
      } else if (coinRate < 0.004) {
        adjust(-10, '投币表现很低');
      } else if (coinRate < 0.007) {
        adjust(-5, '投币表现偏低');
      }

      if (favoriteRate >= 0.015) {
        adjust(10, '收藏表现优秀');
      } else if (favoriteRate >= 0.009) {
        adjust(5, '收藏表现较好');
      } else if (favoriteRate < 0.002) {
        adjust(-10, '收藏表现很低');
      } else if (favoriteRate < 0.004) {
        adjust(-5, '收藏表现偏低');
      }

      if (likeRate >= 0.08) {
        adjust(8, '点赞表现优秀');
      } else if (likeRate >= 0.055) {
        adjust(4, '点赞表现较好');
      } else if (likeRate < 0.015) {
        adjust(-8, '点赞表现很低');
      } else if (likeRate < 0.025) {
        adjust(-4, '点赞表现偏低');
      }
    }

    const sameUpIndex = number(context.sameUpIndex);
    if (sameUpIndex >= 3) {
      adjust(-22, `同一UP本页第${sameUpIndex}次出现`);
    }

    const seenCount = number(context.seenCount);
    if (seenCount >= 3) {
      adjust(-22, `最近已推荐${seenCount}次`);
    } else if (seenCount === 2) {
      adjust(-10, '最近已推荐2次');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const threshold = THRESHOLDS[mode] ?? THRESHOLDS.standard;
    return {
      score,
      threshold,
      hidden: score < threshold,
      details
    };
  }

  globalThis.BTFQuality = {
    THRESHOLDS,
    evaluate,
    smoothedRate
  };
})();
