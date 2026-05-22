window.BACKEND_URL = 'https://sixaclass.onrender.com/api';
window.CLOUDINARY_CLOUD_NAME = 'dvl3h61wd';
window.E2E_CLOUDINARY_CLOUD_NAME = window.CLOUDINARY_CLOUD_NAME;

// Chat6A moderation safety patch.
// If the moderation backend/Render/Perspective times out or returns 5xx/429,
// do not block innocent messages and do not issue warnings. Real toxic responses
// from a healthy backend are still respected.
(function () {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function chat6aFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isModerateRequest = String(url).includes('/moderate');

    if (!isModerateRequest) {
      return originalFetch(input, init);
    }

    try {
      const response = await originalFetch(input, init);
      if (response && response.ok) return response;

      console.warn('[chat6a] moderation fail-open: backend status', response && response.status);
      return new Response(JSON.stringify({
        toxic: false,
        score: null,
        moderationBypassed: true,
        reason: 'backend_error_fail_open'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.warn('[chat6a] moderation fail-open: request failed', error && (error.message || error));
      return new Response(JSON.stringify({
        toxic: false,
        score: null,
        moderationBypassed: true,
        reason: 'network_or_timeout_fail_open'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
})();
