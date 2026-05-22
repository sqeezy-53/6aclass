window.BACKEND_URL = 'https://sixaclass.onrender.com/api';
window.CLOUDINARY_CLOUD_NAME = 'dvl3h61wd';
window.E2E_CLOUDINARY_CLOUD_NAME = window.CLOUDINARY_CLOUD_NAME;

// Chat6A moderation safety patch.
// Layer 1: instant local blocklist for insults, threats, sexual content, genital terms, and slurs.
// Layer 2: Perspective via backend, but client blocks at score >= 0.65.
// If backend/Render/Perspective times out or returns an error, fail open.
(function () {
  const originalFetch = window.fetch.bind(window);
  const MODERATION_CLIENT_THRESHOLD = 0.65;
  const MODERATION_SOFT_TIMEOUT_MS = 3500;

  function b64Utf8(s) {
    const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // Encoded on purpose: keeps the source less readable while the filter still works.
  const LOCAL_TOXIC_WORDS = ["0LTRg9GA0LA=","0LTRg9GA0LDQug==","0YLRg9C/0L7QuQ==","0YLRg9C/0LDRjw==","0YLRg9C/0L7QtQ==","0YLRg9C/0LjRhtCw","0YfQvNC+","0LvQvtGF","0LvQvtGI0LDRgNCw","0LTQtdCx0LjQuw==","0LTQsNGD0L0=","0LjQtNC40L7Rgg==","0LrRgNC10YLQuNC9","0YPRgNC+0LQ=","0LzRgNCw0LfRjA==","0YLQstCw0YDRjA==","0LPQvdC40LTQsA==","0YHQutC+0YLQuNC90LA=","0LbQuNCy0L7RgtC90L7QtQ==","0L3QuNGH0YLQvtC20LXRgdGC0LLQvg==","0L3QuNC60YfQtdC80L3Ri9C5","0LbQuNGA0L3Ri9C5","0LbQuNGA0L3QsNGP","0YHQtNC+0YXQvdC4","0YPQvNGA0Lg=","0YPQsdC10LnRgdGP","0YPQsdGM0Y4=","0LfQsNGA0LXQttGD","0LjQt9C+0LHRjNGO","0YHRg9C60LA=","0LHQu9GP0YLRjA==","0LHQu9GP0LTRjA==","0YXRg9C5","0YXQtdGA","0L/QuNC30LTQsA==","0L/QuNC30LTQtdGG","0LXQsdC70LDQvQ==","0YPQtdCx0L7Qug==","0LPQsNC90LTQvtC9","0LzRg9C00LDQug==","0YjQu9GO0YXQsA==","0L/QtdC90LjRgQ==","0YfQu9C10L0=","0L/QuNGB0Y7QvQ==","0L/QuNC/0LjRgdC60LA=","0L/QuNGB0YzQutCw","0LLQsNCz0LjQvdCw","0LLQu9Cw0LPQsNC70LjRidC1","0LrQu9C40YLQvtGA","0LfQsNC70YPQv9Cw","0LzQvtGI0L7QvdC60LA=","0Y/QuNGH0LrQuA==","0LDQvdGD0YE=","0L7Rh9C60L4=","0LbQvtC/0LA=","0LfQsNC00L3QuNGG0LA=","0YHQtdC60YE=","0YLRgNCw0YU=","0LzQuNC90LXRgg==","0L7RgtGB0L7RgQ==","0YHQv9C10YDQvNCw","0L/QuNC00L7RgA==","0L/QuNC00L7RgNCw0YE=","0L/QuNC00LDRgA==","0L/QtdC00LjQug==","0LPQvtC80LjQug=="].map(b64Utf8);
  const LOCAL_TOXIC_ROOTS = ["0YLRg9C/0L7RgNGL0Ls=","0YfQvNC+0Yg=","0LTQtdCx0LjQuw==","0LjQtNC40L7Rgg==","0LrRgNC10YLQuNC9","0YPRgNC+0LQ=","0L3QuNC60YfQtdC8","0L3QuNGH0YLQvtC2","0LbQuNGA0L0=","0YXRg9C1","0YXRg9C4","0YXRg9GP","0YXRg9C5","0YXRg9C10YE=","0YXQtdGA0L0=","0L/QuNC30LQ=","0LXQsdCw0L0=","0LXQsdC70LDQvQ==","0LXQsdC90YPRgg==","0YPQtdCx","0LfQsNC10LE=","0L3QsNC10LE=","0LHQu9GP0LQ=","0YHRg9C60LjQvQ==","0YHRg9GH0Lo=","0LzRg9C00LA=","0LzRgNCw0Lc=","0LPQvdC40LQ=","0LPQsNC90LTQvtC9","0LPQvtCy0L0=","0LTQtdGA0YzQvA==","0YjQu9GO0YU=","0L/QtdC90LjRgQ==","0L/QuNGB0Y7QvQ==","0L/QuNC/0LjRgdC6","0L/QuNGB0YzQug==","0LLQsNCz0LjQvQ==","0LLQu9Cw0LPQsNC70LjRiQ==","0LrQu9C40YLQvtGA","0LfQsNC70YPQvw==","0LzQvtGI0L7QvdC6","0Y/QuNGH0Lo=","0LDQvdGD0YE=","0YHRgNCw0Lo=","0LbQvtC/","0YLRgNCw0YU=","0LzQuNC90LXRgg==","0L7RgtGB0L7RgQ==","0YHQv9C10YDQvA==","0LrQvtC90Yc=","0LTRgNC+0Yc=","0L/QuNC00L7RgA==","0L/QuNC00LDRgA==","0L/QuNC00LDRgNCw0YE=","0L/QuNC00YDQsNGB","0L/QtdC00LjQug=="].map(b64Utf8);

  const LOCAL_TOXIC_PATTERNS = [
    {
      label: 'family_threat',
      test: (normalized) => {
        const hasFamilyTarget = /(^|\s)(семь[яюеи]|мам[ауые]|пап[ауые]|родител[ьяей]|брат[ауе]?|сестр[ауые])($|\s)/u.test(normalized);
        const hasViolence = /(^|\s)(убью|зарежу|порежу|изобью|побью|сломаю|разорву|раздроблю|разроблю|вырежу|разнесу|ударю)($|\s)/u.test(normalized);
        return hasFamilyTarget && hasViolence;
      }
    },
    {
      label: 'direct_family_threat_phrase',
      test: (normalized) => /(^|\s)(твою|твоих|твоей|твой|вашу|ваших|вашей|ваш)\s+(семь[яюеи]|мам[ауые]|пап[ауые]|родител[ьяей])/u.test(normalized)
    }
  ];

  function normalizeModerationText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[0@]/g, 'о')
      .replace(/[1!|]/g, 'и')
      .replace(/[3]/g, 'з')
      .replace(/[4]/g, 'ч')
      .replace(/[6]/g, 'б')
      .replace(/[a]/g, 'а')
      .replace(/[e]/g, 'е')
      .replace(/[o]/g, 'о')
      .replace(/[p]/g, 'р')
      .replace(/[c]/g, 'с')
      .replace(/[x]/g, 'х')
      .replace(/[y]/g, 'у')
      .replace(/[k]/g, 'к')
      .replace(/[m]/g, 'м')
      .replace(/[t]/g, 'т')
      .replace(/[h]/g, 'н')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function getModerationTextFromBody(body) {
    if (typeof body !== 'string') return '';
    try {
      const parsed = JSON.parse(body);
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch (_) {
      return '';
    }
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function spacedWordRegex(word, allowEndingLetters) {
    const letters = Array.from(word).map(escapeRegExp).join('\\s*');
    const suffix = allowEndingLetters ? '\\p{L}*' : '';
    return new RegExp('(^|\\s)' + letters + suffix + '($|\\s)', 'u');
  }

  function findLocalToxicHit(text) {
    const normalized = normalizeModerationText(text);
    if (!normalized) return '';
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const compact = normalized.replace(/\s+/g, '');

    for (const pattern of LOCAL_TOXIC_PATTERNS) {
      try {
        if (pattern.test(normalized, compact, tokens)) return pattern.label;
      } catch (_) {}
    }

    for (const word of LOCAL_TOXIC_WORDS) {
      const w = normalizeModerationText(word).replace(/\s+/g, '');
      if (!w) continue;
      if (tokens.includes(w)) return word;
      if (spacedWordRegex(w, false).test(normalized)) return word;
    }

    for (const root of LOCAL_TOXIC_ROOTS) {
      const r = normalizeModerationText(root).replace(/\s+/g, '');
      if (!r || r.length < 4) continue;
      if (tokens.some(token => token.startsWith(r))) return root;
      if (spacedWordRegex(r, true).test(normalized)) return root;
      if (r.length >= 5 && compact.includes(r)) return root;
    }

    return '';
  }

  function jsonResponse(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function withSoftTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('moderation_soft_timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  window.fetch = async function chat6aFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isModerateRequest = String(url).includes('/moderate');

    if (!isModerateRequest) {
      return originalFetch(input, init);
    }

    const text = getModerationTextFromBody(init && init.body);
    const localHit = findLocalToxicHit(text);
    if (localHit) {
      console.warn('[chat6a] moderation local block:', localHit);
      return jsonResponse({ toxic: true, score: 1, localRule: true, localHit, warnIssued: false, warns: null, maxWarns: null });
    }

    try {
      const response = await withSoftTimeout(originalFetch(input, init), MODERATION_SOFT_TIMEOUT_MS);

      if (response && response.ok) {
        try {
          const data = await response.clone().json();
          const score = Number(data && data.score);
          if (!data.toxic && Number.isFinite(score) && score >= MODERATION_CLIENT_THRESHOLD) {
            console.warn('[chat6a] moderation client threshold block:', score);
            return jsonResponse({ ...data, toxic: true, clientThreshold: MODERATION_CLIENT_THRESHOLD, warnIssued: !!data.warnIssued });
          }
        } catch (_) {}
        return response;
      }

      console.warn('[chat6a] moderation fail-open: backend status', response && response.status);
      return jsonResponse({ toxic: false, score: null, moderationBypassed: true, reason: 'backend_error_fail_open' });
    } catch (error) {
      console.warn('[chat6a] moderation fail-open: request failed', error && (error.message || error));
      return jsonResponse({ toxic: false, score: null, moderationBypassed: true, reason: 'network_or_timeout_fail_open' });
    }
  };
})();
