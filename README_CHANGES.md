# Chat 6A bugfix v2 — uncached full build

Build: `20260522-v2-uncached`

## Why v2 exists

The screenshots still show the old UI messages:

- `Сообщение слишком токсично и не отправлено`
- `Ошибка голосования: Missing or insufficient permissions`

That means the browser/site is still running the old cached `app.js` / `e2e-security-refactor.js`, or Firestore rules were not deployed.

## What changed in this build

1. Added versioned asset filenames:
   - `assets/js/chat/app.20260522-v2.js`
   - `assets/js/chat/e2e-security-refactor.20260522-v2.js`
   - `assets/js/chat/config.20260522-v2.js`
   - `assets/js/chat/theme-bootstrap.20260522-v2.js`
   - `assets/css/chat.20260522-v2.css`

2. Updated `index5.html` to load those versioned assets with query cache-busting.

3. Added `assets/js/chat/cache-reset.20260522-v2.js` to unregister old service workers and clear Cache Storage if they exist.

4. Changed the toxic-block toast text to:
   - `⛔ Заблокировано модерацией: реальная токсичность.`

   If the old text still appears, the deployed site is not loading this build.

5. Kept the previous fixes:
   - backend moderation errors are not treated as toxicity;
   - client no longer increments `warns`;
   - backend issues moderation warns via Firebase Admin SDK;
   - polls use `/polls/{pollId}/votes/{uid}`;
   - Firestore rules validate poll create/vote documents;
   - DM members cannot be changed by update.

6. Added temporary Firestore compatibility for old cached clients:
   - users may update only the legacy `polls/{pollId}.votes` field.
   - remove this rule after everyone is on v2.

## Deploy checklist

1. Upload the entire archive contents to the web root, not only one JS file.
2. Deploy `firebase/firestore.rules` to Firestore rules.
3. Restart/redeploy `server.py` on Render.
4. Open the site in an incognito window or hard-refresh:
   - Windows/Linux: `Ctrl + Shift + R`
   - DevTools → Network → Disable cache → reload
5. In browser console you should see:
   - `[chat6a] build 20260522-v2-uncached`
   - `[chat6a] e2e build 20260522-v2-uncached`
   - `[chat6a] app build 20260522-v2-uncached`

If those logs are missing, the old build is still being served.
