window.BACKEND_URL = 'https://sixaclass.onrender.com/api';
window.CLOUDINARY_CLOUD_NAME = 'dvl3h61wd';
window.E2E_CLOUDINARY_CLOUD_NAME = window.CLOUDINARY_CLOUD_NAME;

// Chat6A moderation safety patch.
// Layer 1: instant local blocklist for obvious insults/threats.
// Layer 2: Perspective via backend, but client blocks at score >= 0.65.
// If backend/Render/Perspective times out or returns an error, fail open:
// do not block innocent messages and do not issue warnings.
(function () {
  const originalFetch = window.fetch.bind(window);
  const MODERATION_CLIENT_THRESHOLD = 0.65;
  const MODERATION_SOFT_TIMEOUT_MS = 3500;

  const LOCAL_TOXIC_WORDS = [
    'чмо', 'чмошник', 'чмошница',
    'тупой', 'тупая', 'тупое', 'тупые', 'тупица',
    'жирный', 'жирная', 'жирное', 'жирдяй', 'жируха',
    'лох', 'лошара',
    'дебил', 'дебилка', 'дебилы',
    'даун', 'дауны',
    'урод', 'уродка', 'уроды',
    'сдохни', 'умри', 'убейся',
    'никчемный', 'никчемная', 'ничтожество'
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

  function findLocalToxicHit(text) {
    const normalized = normalizeModerationText(text);
    if (!normalized) return '';
    const compact = normalized.replace(/\s+/g, '');

    for (const word of LOCAL_TOXIC_WORDS) {
      const w = normalizeModerationText(word).replace(/\s+/g, '');
      if (!w) continue;

      const wordBoundaryRe = new RegExp('(^|\\s)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)', 'u');
      if (wordBoundaryRe.test(normalized)) return word;

      // Catches simple bypasses like "ч.м.о" or "т у п о й" after compacting.
      if (w.length >= 4 && compact.includes(w)) return word;
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
      return jsonResponse({
        toxic: true,
        score: 1,
        localRule: true,
        localHit,
        warnIssued: false,
        warns: null,
        maxWarns: null
      });
    }

    try {
      const response = await withSoftTimeout(originalFetch(input, init), MODERATION_SOFT_TIMEOUT_MS);

      if (response && response.ok) {
        try {
          const data = await response.clone().json();
          const score = Number(data && data.score);
          if (!data.toxic && Number.isFinite(score) && score >= MODERATION_CLIENT_THRESHOLD) {
            console.warn('[chat6a] moderation client threshold block:', score);
            return jsonResponse({
              ...data,
              toxic: true,
              clientThreshold: MODERATION_CLIENT_THRESHOLD,
              warnIssued: !!data.warnIssued
            });
          }
        } catch (_) {}
        return response;
      }

      console.warn('[chat6a] moderation fail-open: backend status', response && response.status);
      return jsonResponse({
        toxic: false,
        score: null,
        moderationBypassed: true,
        reason: 'backend_error_fail_open'
      });
    } catch (error) {
      console.warn('[chat6a] moderation fail-open: request failed', error && (error.message || error));
      return jsonResponse({
        toxic: false,
        score: null,
        moderationBypassed: true,
        reason: 'network_or_timeout_fail_open'
      });
    }
  };
})();
