import os
import json
import time
import hashlib
import logging
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

load_dotenv()

PERSPECTIVE_API_KEY = os.environ.get('PERSPECTIVE_API_KEY', '')
CLOUDINARY_CLOUD_NAME = os.environ.get('CLOUDINARY_CLOUD_NAME', '')
CLOUDINARY_UPLOAD_PRESET = os.environ.get('CLOUDINARY_UPLOAD_PRESET', '')
CLOUDINARY_API_KEY = os.environ.get('CLOUDINARY_API_KEY', '')
CLOUDINARY_API_SECRET = os.environ.get('CLOUDINARY_API_SECRET', '')
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('ALLOWED_ORIGINS', 'https://6aclass.online').split(',') if o.strip()]
FIREBASE_PROJECT_ID = os.environ.get('FIREBASE_PROJECT_ID', 'class6a-chat')
FIREBASE_SERVICE_ACCOUNT_JSON = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '')
TOXICITY_THRESHOLD = float(os.environ.get('TOXICITY_THRESHOLD', '0.65'))
MAX_WARNS = int(os.environ.get('MAX_WARNS', '3'))
ISSUE_MODERATION_WARNS = os.environ.get('ISSUE_MODERATION_WARNS', 'true').lower() == 'true'
MAX_UPLOAD_BYTES = int(os.environ.get('MAX_UPLOAD_BYTES', str(50 * 1024 * 1024)))

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger('chat6a')
_firebase_ready = False
_rate_buckets = {}
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX_REQ = int(os.environ.get('RATE_LIMIT_MAX_REQ', '30'))
RATE_LIMIT_UPLOAD_MAX_REQ = int(os.environ.get('RATE_LIMIT_UPLOAD_MAX_REQ', '20'))
RATE_LIMIT_MODERATE_MAX_REQ = int(os.environ.get('RATE_LIMIT_MODERATE_MAX_REQ', '30'))

app = FastAPI(title='Chat6A backend', version='4.0.0', docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS + ['https://www.6aclass.online'],
    allow_credentials=True,
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['Content-Type', 'Authorization', 'X-Request-Id'],
)

@app.middleware('http')
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()')
    response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
    response.headers.setdefault('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
    return response


def _init_firebase_admin():
    global _firebase_ready
    if _firebase_ready:
        return
    try:
        import firebase_admin
        from firebase_admin import credentials
        if firebase_admin._apps:
            _firebase_ready = True
            return
        options = {'projectId': FIREBASE_PROJECT_ID} if FIREBASE_PROJECT_ID else None
        if FIREBASE_SERVICE_ACCOUNT_JSON:
            firebase_admin.initialize_app(credentials.Certificate(json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)), options=options)
        else:
            firebase_admin.initialize_app(options=options)
        _firebase_ready = True
    except ImportError as exc:
        raise HTTPException(status_code=500, detail='Firebase Admin SDK не установлен') from exc
    except Exception as exc:
        logger.error('[auth] firebase init failed: %s', exc)
        raise HTTPException(status_code=500, detail='Firebase Auth не настроен на сервере') from exc


async def require_firebase_user(request: Request):
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Missing Authorization Bearer token')
    token = header.removeprefix('Bearer ').strip()
    if not token:
        raise HTTPException(status_code=401, detail='Empty Authorization Bearer token')
    _init_firebase_admin()
    try:
        from firebase_admin import auth as fb_auth
        decoded = fb_auth.verify_id_token(token, check_revoked=True)
        if not decoded.get('uid'):
            raise ValueError('token without uid')
        return decoded
    except Exception as exc:
        logger.warning('[auth] bad token: %s', exc)
        raise HTTPException(status_code=401, detail='Invalid Firebase ID token') from exc


async def optional_firebase_user(request: Request):
    try:
        return await require_firebase_user(request)
    except HTTPException as exc:
        logger.warning('[auth] upload allowed with bad or stale token: %s', exc.detail)
        return {'uid': 'upload-anon'}


def get_client_ip(request: Request):
    forwarded = request.headers.get('X-Forwarded-For', '')
    if os.environ.get('TRUSTED_PROXY', 'false').lower() == 'true' and forwarded:
        return forwarded.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def _limit_for(endpoint):
    if endpoint == 'upload':
        return RATE_LIMIT_UPLOAD_MAX_REQ
    if endpoint == 'moderate':
        return RATE_LIMIT_MODERATE_MAX_REQ
    return RATE_LIMIT_MAX_REQ


async def check_rate_limit(key_base, endpoint):
    key = f'rl:{key_base}:{endpoint}'
    now = time.time()
    bucket = [t for t in _rate_buckets.get(key, []) if now - t < RATE_LIMIT_WINDOW]
    if len(bucket) >= _limit_for(endpoint):
        _rate_buckets[key] = bucket
        return False
    bucket.append(now)
    _rate_buckets[key] = bucket
    return True


async def issue_moderation_warn(uid):
    if not ISSUE_MODERATION_WARNS or not uid:
        return None
    _init_firebase_admin()
    try:
        from firebase_admin import firestore as fb_firestore
        db = fb_firestore.client()
        ref = db.collection('users').document(uid)
        ref.set({'warns': fb_firestore.Increment(1)}, merge=True)
        snap = ref.get()
        warns = int((snap.to_dict() or {}).get('warns', 1) or 1)
        if warns >= MAX_WARNS:
            ref.set({'banned': True}, merge=True)
        return warns
    except Exception as exc:
        logger.error('[moderate] warn failed: %s', exc)
        return None


class ModerateRequest(BaseModel):
    text: str
    @field_validator('text')
    @classmethod
    def text_ok(cls, v):
        v = v.strip()
        if not v:
            raise ValueError('text не может быть пустым')
        if len(v) > 4000:
            raise ValueError('text слишком длинный')
        return v

PERSPECTIVE_URL = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze'

@app.get('/api/health')
async def health():
    return {'status': 'ok', 'timestamp': int(time.time())}

@app.post('/api/moderate')
async def moderate(request: Request, body: ModerateRequest, user: dict = Depends(require_firebase_user)):
    client_ip = get_client_ip(request)
    uid = str(user.get('uid', 'anon'))
    if not await check_rate_limit(client_ip, 'moderate') or not await check_rate_limit(f'uid:{uid}', 'moderate'):
        raise HTTPException(status_code=429, detail='Слишком много запросов')
    if not PERSPECTIVE_API_KEY:
        raise HTTPException(status_code=503, detail='Модерация временно недоступна')
    payload = {
        'comment': {'text': body.text},
        'requestedAttributes': {'TOXICITY': {}, 'INSULT': {}, 'THREAT': {}, 'IDENTITY_ATTACK': {}},
        'languages': ['ru', 'en'],
        'doNotStore': True,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(PERSPECTIVE_URL, params={'key': PERSPECTIVE_API_KEY}, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning('[moderate] unavailable: %s', exc)
        raise HTTPException(status_code=503, detail='Модерация временно недоступна') from exc
    scores = data.get('attributeScores', {})
    max_score = max((x.get('summaryScore', {}).get('value', 0.0) for x in scores.values()), default=0.0)
    toxic = max_score >= TOXICITY_THRESHOLD
    warns = await issue_moderation_warn(uid) if toxic else None
    return {'toxic': toxic, 'score': round(max_score, 4), 'warnIssued': warns is not None, 'warns': warns, 'maxWarns': MAX_WARNS}


def is_trusted_cloudinary_delivery_url(url):
    try:
        p = urlparse(url)
        return p.scheme == 'https' and p.netloc == 'res.cloudinary.com' and bool(CLOUDINARY_CLOUD_NAME) and p.path.startswith(f'/{CLOUDINARY_CLOUD_NAME}/')
    except Exception:
        return False


def _cloudinary_sign(params):
    payload = '&'.join(f'{k}={v}' for k, v in sorted(params.items())) + CLOUDINARY_API_SECRET
    return hashlib.sha256(payload.encode()).hexdigest()

@app.post('/api/upload')
async def upload(request: Request, file: UploadFile = File(...), type: str = Form(default='raw'), user: dict = Depends(optional_firebase_user)):
    client_ip = get_client_ip(request)
    uid = str(user.get('uid', 'upload-anon'))
    if not await check_rate_limit(client_ip, 'upload') or not await check_rate_limit(f'uid:{uid}', 'upload'):
        raise HTTPException(status_code=429, detail='Слишком много запросов')
    if type not in {'image', 'video', 'raw'}:
        raise HTTPException(status_code=400, detail='Недопустимый тип файла')
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail='Пустой файл')
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f'Файл слишком большой (макс {MAX_UPLOAD_BYTES // 1024 // 1024} МБ)')
    if not all([CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET]):
        raise HTTPException(status_code=500, detail='Загрузка файлов не настроена на сервере')

    content_type = (file.content_type or 'application/octet-stream').split(';', 1)[0].strip().lower()
    if content_type.startswith('audio/'):
        resource_type = 'video'
    elif type == 'raw':
        resource_type = 'raw'
    else:
        resource_type = type

    ts = int(time.time())
    sign_params = {'timestamp': str(ts), 'upload_preset': CLOUDINARY_UPLOAD_PRESET, 'overwrite': 'false', 'unique_filename': 'true', 'use_filename': 'false'}
    form_data = {**sign_params, 'signature': _cloudinary_sign(sign_params), 'api_key': CLOUDINARY_API_KEY}
    url = f'https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload'
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, data=form_data, files={'file': (file.filename or 'upload', content, content_type)})
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail='Cloudinary не ответил')
    except httpx.HTTPStatusError as exc:
        logger.error('[upload] Cloudinary HTTP %s: %s', exc.response.status_code, exc.response.text)
        raise HTTPException(status_code=502, detail='Ошибка Cloudinary') from exc
    except Exception as exc:
        logger.error('[upload] unexpected: %s', exc)
        raise HTTPException(status_code=500, detail='Внутренняя ошибка сервера') from exc
    secure_url = data.get('secure_url', '')
    if not is_trusted_cloudinary_delivery_url(secure_url):
        raise HTTPException(status_code=502, detail='Cloudinary вернул недоверенную ссылку')
    return {'url': secure_url}

@app.post('/api/security-alert')
async def security_alert(request: Request):
    client_ip = get_client_ip(request)
    if not await check_rate_limit(client_ip, 'security-alert'):
        raise HTTPException(status_code=429, detail='Слишком много запросов')
    return {'ok': True}

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error('[global] unhandled: %s', exc, exc_info=True)
    return JSONResponse(status_code=500, content={'detail': 'Внутренняя ошибка сервера'})

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('server:app', host='0.0.0.0', port=int(os.environ.get('PORT', 8000)), reload=os.environ.get('ENV', 'production') == 'development')
