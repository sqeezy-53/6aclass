"""
╔══════════════════════════════════════════════════════════════════╗
║          server.py — Бэкенд-прокси для чата 6А                  ║
║                                                                  ║
║  Задачи:                                                         ║
║  1. /api/moderate  — проксирует запросы к Perspective API        ║
║     (API-ключ хранится ТОЛЬКО здесь, не во фронтенде)           ║
║  2. /api/upload    — проксирует загрузку файлов на Cloudinary    ║
║     (upload_preset и cloud_name только здесь)                   ║
║  3. /api/health    — healthcheck для мониторинга                 ║
║                                                                  ║
║  Запуск: uvicorn server:app --host 0.0.0.0 --port 8000          ║
║  Зависимости: pip install fastapi uvicorn httpx python-dotenv firebase-admin    ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import io
import json
import logging
import hashlib
import hmac
import time
from functools import wraps
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

# ── Загружаем переменные окружения из .env ──────────────────────
load_dotenv()

# ── Конфигурация (НИКОГДА не хардкоди эти значения в коде) ──────
PERSPECTIVE_API_KEY   = os.environ.get("PERSPECTIVE_API_KEY", "")      # Google Perspective
CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "")    # dvl3h61wd (пример)
CLOUDINARY_UPLOAD_PRESET = os.environ.get("CLOUDINARY_UPLOAD_PRESET", "")  # unsigned preset
CLOUDINARY_API_KEY    = os.environ.get("CLOUDINARY_API_KEY", "")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "")
ALLOWED_ORIGINS       = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "https://6aclass.online").split(",") if o.strip()]
FIREBASE_PROJECT_ID   = os.environ.get("FIREBASE_PROJECT_ID", "class6a-chat")
FIREBASE_SERVICE_ACCOUNT_JSON = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")

# Пороговый балл токсичности (0.0–1.0). 0.75 = блокируем при 75%+
TOXICITY_THRESHOLD = float(os.environ.get("TOXICITY_THRESHOLD", "0.75"))
MAX_WARNS = int(os.environ.get("MAX_WARNS", "3"))
ISSUE_MODERATION_WARNS = os.environ.get("ISSUE_MODERATION_WARNS", "true").lower() == "true"

# Лимит размера загружаемого файла (байты). 50 МБ по умолчанию.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

# Разрешённые MIME-типы файлов
ALLOWED_MIME_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
    "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "video/webm",
    "application/octet-stream",  # зашифрованные E2E-блобы
}

# ── Логирование ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("chat6a")

# ── Firebase Auth ────────────────────────────────────────────────
_firebase_ready = False

def _init_firebase_admin() -> None:
    """Ленивая инициализация Firebase Admin SDK для проверки ID token."""
    global _firebase_ready
    if _firebase_ready:
        return
    try:
        import firebase_admin
        from firebase_admin import credentials

        if firebase_admin._apps:
            _firebase_ready = True
            return

        options = {"projectId": FIREBASE_PROJECT_ID} if FIREBASE_PROJECT_ID else None
        if FIREBASE_SERVICE_ACCOUNT_JSON:
            service_account = json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
            cred = credentials.Certificate(service_account)
            firebase_admin.initialize_app(cred, options=options)
        else:
            firebase_admin.initialize_app(options=options)
        _firebase_ready = True
    except ImportError as exc:
        logger.error("[auth] firebase-admin не установлен")
        raise HTTPException(status_code=500, detail="Firebase Admin SDK не установлен") from exc
    except Exception as exc:
        logger.error("[auth] Firebase Admin SDK не настроен: %s", exc)
        raise HTTPException(status_code=500, detail="Firebase Auth не настроен на сервере") from exc

async def require_firebase_user(request: Request) -> dict:
    """Fail-closed проверка Authorization: Bearer <Firebase ID token>."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization Bearer token")
    token = header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty Authorization Bearer token")

    _init_firebase_admin()
    try:
        from firebase_admin import auth as fb_auth
        decoded = fb_auth.verify_id_token(token, check_revoked=True)
        if not decoded.get("uid"):
            raise ValueError("token without uid")
        return decoded
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[auth] invalid Firebase ID token: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from exc


async def issue_moderation_warn(uid: str) -> Optional[int]:
    """Выдаёт варн через Firebase Admin SDK. Клиенту это делать нельзя."""
    if not ISSUE_MODERATION_WARNS:
        return None
    if not uid:
        return None
    _init_firebase_admin()
    try:
        from firebase_admin import firestore as fb_firestore
        db = fb_firestore.client()
        user_ref = db.collection("users").document(uid)
        user_ref.set({"warns": fb_firestore.Increment(1)}, merge=True)
        snap = user_ref.get()
        if not snap.exists:
            return 1
        data = snap.to_dict() or {}
        warns = data.get("warns", 1)
        return int(warns) if isinstance(warns, (int, float)) else 1
    except Exception as exc:
        logger.error("[moderate] failed to issue warn for uid=%s: %s", uid, exc)
        return None

import asyncio

# ── Rate limiting ─────────────────────────────────────────────────
# Использует Redis если REDIS_URL задан в .env (рекомендуется для production
# с несколькими воркерами uvicorn --workers N).
# При отсутствии Redis — in-memory fallback (работает только с 1 воркером).
REDIS_URL          = os.environ.get("REDIS_URL", "")
RATE_LIMIT_WINDOW  = 60   # секунд
RATE_LIMIT_MAX_REQ = 30   # запросов за окно
RATE_LIMIT_UPLOAD_MAX_REQ = int(os.environ.get("RATE_LIMIT_UPLOAD_MAX_REQ", "12"))
RATE_LIMIT_MODERATE_MAX_REQ = int(os.environ.get("RATE_LIMIT_MODERATE_MAX_REQ", "30"))
RATE_LIMIT_SECURITY_ALERT_MAX_REQ = int(os.environ.get("RATE_LIMIT_SECURITY_ALERT_MAX_REQ", "20"))

_redis_client = None
_rate_buckets: dict[str, list[float]] = {}  # fallback

async def _get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if not REDIS_URL:
        return None
    try:
        import redis.asyncio as aioredis
        _redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
        await _redis_client.ping()
        logger.info("[rate] Redis подключён: %s", REDIS_URL.split("@")[-1])
    except Exception as e:
        logger.warning("[rate] Redis недоступен, используем in-memory fallback: %s", e)
        _redis_client = None
    return _redis_client

def _limit_for_endpoint(endpoint: str) -> int:
    return {
        "upload": RATE_LIMIT_UPLOAD_MAX_REQ,
        "moderate": RATE_LIMIT_MODERATE_MAX_REQ,
        "security-alert": RATE_LIMIT_SECURITY_ALERT_MAX_REQ,
    }.get(endpoint, RATE_LIMIT_MAX_REQ)

async def check_rate_limit(client_ip: str, endpoint: str) -> bool:
    """
    Возвращает True если лимит НЕ превышен.
    Redis-режим: атомарный sliding window через ZADD/ZREMRANGEBYSCORE — работает
    при любом числе воркеров.
    Fallback (in-memory): корректен только при одном воркере.
    """
    key = f"rl:{client_ip}:{endpoint}"
    now = time.time()

    redis = await _get_redis()
    if redis is not None:
        try:
            pipe = redis.pipeline()
            pipe.zremrangebyscore(key, 0, now - RATE_LIMIT_WINDOW)
            pipe.zadd(key, {str(now): now})
            pipe.zcard(key)
            pipe.expire(key, RATE_LIMIT_WINDOW + 1)
            results = await pipe.execute()
            count = results[2]
            return count <= _limit_for_endpoint(endpoint)
        except Exception as e:
            logger.warning("[rate] Redis ошибка, fallback: %s", e)

    # In-memory fallback
    bucket = _rate_buckets.get(key, [])
    bucket = [t for t in bucket if now - t < RATE_LIMIT_WINDOW]
    if len(bucket) >= _limit_for_endpoint(endpoint):
        _rate_buckets[key] = bucket
        return False
    bucket.append(now)
    _rate_buckets[key] = bucket
    if len(_rate_buckets) > 10_000:
        stale = [k for k, v in _rate_buckets.items()
                 if all(now - t >= RATE_LIMIT_WINDOW for t in v)]
        for k in stale:
            del _rate_buckets[k]
    return True



def get_client_ip(request: Request) -> str:
    """
    Извлекает реальный IP клиента.
    БЕЗОПАСНОСТЬ: X-Forwarded-For может подделываться клиентом.
    Если используется reverse-proxy (nginx/Caddy), доверяй только
    последнему IP в цепочке — он добавляется самим прокси и не
    может быть подделан клиентом.
    Если приложение запущено без reverse-proxy — используй client.host напрямую.
    Установи TRUSTED_PROXY=true в .env только если сервер за nginx/Caddy.
    """
    trusted_proxy = os.environ.get("TRUSTED_PROXY", "false").lower() == "true"
    if trusted_proxy:
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            ips = [ip.strip() for ip in forwarded.split(",") if ip.strip()]
            # Select the client address before the configured trusted proxy hops.
            # Default: one trusted reverse proxy appends its own IP to XFF.
            try:
                hops = max(1, int(os.environ.get("TRUSTED_PROXY_HOPS", "1")))
            except ValueError:
                hops = 1
            idx = -(hops + 1)
            if len(ips) >= hops + 1:
                return ips[idx]
    return request.client.host if request.client else "unknown"

# ── FastAPI приложение ───────────────────────────────────────────
app = FastAPI(
    title="Чат 6А — Бэкенд-прокси",
    version="2.0.0",
    docs_url=None,   # Отключаем Swagger в production
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization", "X-Request-Id"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()")
    response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
    response.headers.setdefault(
        "Content-Security-Policy",
        "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
    )
    return response

# ══════════════════════════════════════════════════════════════════
#  § 1  HEALTHCHECK
# ══════════════════════════════════════════════════════════════════

@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": int(time.time())}


# ══════════════════════════════════════════════════════════════════
#  § 2  МОДЕРАЦИЯ — Perspective API прокси
# ══════════════════════════════════════════════════════════════════

class ModerateRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("text не может быть пустым")
        if len(v) > 4000:
            raise ValueError("text слишком длинный (макс 4000 символов)")
        return v


PERSPECTIVE_URL = (
    "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze"
    f"?key={PERSPECTIVE_API_KEY}"
)

@app.post("/api/moderate")
async def moderate(request: Request, body: ModerateRequest, user: dict = Depends(require_firebase_user)):
    """
    Проверяет текст на токсичность через Perspective API.
    Возвращает: { toxic: bool, score: float }
    """
    client_ip = get_client_ip(request)
    uid = str(user.get("uid", "anon"))
    if not PERSPECTIVE_API_KEY:
        logger.error("[moderate] Perspective API key is not configured")
        raise HTTPException(status_code=503, detail="Модерация временно недоступна")

    # Rate limiting: IP + authenticated user
    if not await check_rate_limit(client_ip, "moderate") or not await check_rate_limit(f"uid:{uid}", "moderate"):
        logger.warning(f"[moderate] Rate limit exceeded for {client_ip}")
        raise HTTPException(status_code=429, detail="Слишком много запросов")

    payload = {
        "comment":         {"text": body.text},
        "requestedAttributes": {
            "TOXICITY":       {},
            "INSULT":         {},
            "THREAT":         {},
            "IDENTITY_ATTACK": {},
        },
        "languages": ["ru", "en"],
        "doNotStore": True,  # не сохранять текст в Google
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(PERSPECTIVE_URL, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException as exc:
        logger.warning("[moderate] Perspective API timeout")
        raise HTTPException(status_code=503, detail="Модерация временно недоступна") from exc
    except httpx.HTTPStatusError as exc:
        logger.error("[moderate] Perspective HTTP error: %s", exc.response.status_code)
        raise HTTPException(status_code=503, detail="Модерация временно недоступна") from exc
    except Exception as exc:
        logger.error("[moderate] Unexpected error: %s", exc)
        raise HTTPException(status_code=503, detail="Модерация временно недоступна") from exc

    # Берём максимальный балл среди всех атрибутов
    scores = data.get("attributeScores", {})
    max_score = max(
        (
            attr.get("summaryScore", {}).get("value", 0.0)
            for attr in scores.values()
        ),
        default=0.0,
    )

    is_toxic = max_score >= TOXICITY_THRESHOLD
    warns_count: Optional[int] = None
    warn_issued = False
    if is_toxic:
        warns_count = await issue_moderation_warn(uid)
        warn_issued = warns_count is not None

    logger.info(
        f"[moderate] ip={client_ip} uid={uid} score={max_score:.3f} "
        f"toxic={is_toxic} warn_issued={warn_issued} text_len={len(body.text)}"
    )
    return JSONResponse({
        "toxic": is_toxic,
        "score": round(max_score, 4),
        "warnIssued": warn_issued,
        "warns": warns_count,
        "maxWarns": MAX_WARNS,
    })



DANGEROUS_EXTENSIONS = {
    "exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "sh", "php", "phtml", "js", "jar", "py", "rb"
}

MAGIC_SIGNATURES = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png":  [b"\x89PNG\r\n\x1a\n"],
    "image/gif":  [b"GIF87a", b"GIF89a"],
    "image/webp": [b"RIFF"],  # additionally requires WEBP at offset 8
    "audio/ogg":  [b"OggS"],
    "audio/mpeg": [b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"],
    "audio/wav":  [b"RIFF"],  # additionally requires WAVE at offset 8
    "audio/x-wav": [b"RIFF"],  # additionally requires WAVE at offset 8
    "video/webm": [b"\x1a\x45\xdf\xa3"],
}

def validate_upload_content(filename: str, content_type: str, content: bytes, upload_type: str) -> None:
    ext = (filename.rsplit('.', 1)[-1] if '.' in filename else '').lower()
    if ext in DANGEROUS_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Опасное расширение файла запрещено")
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")

    header = content[:64]
    if upload_type != "raw":
        allowed = MAGIC_SIGNATURES.get(content_type, [])
        if not allowed or not any(header.startswith(sig) for sig in allowed):
            raise HTTPException(status_code=415, detail="Содержимое файла не соответствует MIME-типу")
        if content_type == "image/webp" and content[8:12] != b"WEBP":
            raise HTTPException(status_code=415, detail="Некорректный WEBP-файл")
        if content_type in {"audio/wav", "audio/x-wav"} and content[8:12] != b"WAVE":
            raise HTTPException(status_code=415, detail="Некорректный WAV-файл")
    if b"<script" in content[:4096].lower() or b"<?php" in content[:4096].lower():
        raise HTTPException(status_code=415, detail="Файл похож на исполняемый скрипт")



def is_trusted_cloudinary_delivery_url(url: str) -> bool:
    """Проверяет, что Cloudinary вернул URL именно из нашего cloud-name."""
    try:
        parsed = urlparse(url)
        return (
            parsed.scheme == "https"
            and parsed.netloc == "res.cloudinary.com"
            and bool(CLOUDINARY_CLOUD_NAME)
            and (parsed.path == f"/{CLOUDINARY_CLOUD_NAME}" or parsed.path.startswith(f"/{CLOUDINARY_CLOUD_NAME}/"))
        )
    except Exception:
        return False

# ══════════════════════════════════════════════════════════════════
#  § 3  ЗАГРУЗКА ФАЙЛОВ — Cloudinary прокси
# ══════════════════════════════════════════════════════════════════

@app.post("/api/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    type: str = Form(default="raw"),
    user: dict = Depends(require_firebase_user),
):
    """
    Принимает зашифрованный E2E-блоб (или обычный файл для группового чата),
    загружает на Cloudinary и возвращает secure_url.

    Параметры:
      file — загружаемый файл (multipart)
      type — 'image' | 'video' | 'raw' (для зашифрованных блобов всегда 'raw')

    Возвращает: { url: str }
    """
    client_ip = get_client_ip(request)

    uid = str(user.get("uid", "anon"))
    if not await check_rate_limit(client_ip, "upload") or not await check_rate_limit(f"uid:{uid}", "upload"):
        logger.warning("[upload] Rate limit exceeded for ip=%s uid=%s", client_ip, uid)
        raise HTTPException(status_code=429, detail="Слишком много запросов")

    # Валидация типа
    if type not in {"image", "video", "raw"}:
        raise HTTPException(status_code=400, detail="Недопустимый тип файла")

    # Читаем содержимое
    content = await file.read()

    # Проверка размера
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Файл слишком большой (макс {MAX_UPLOAD_BYTES // 1024 // 1024} МБ)"
        )

    # Проверка MIME (только для незашифрованных файлов, raw пропускаем)
    content_type = file.content_type or "application/octet-stream"
    if type != "raw" and content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail=f"Недопустимый MIME-тип: {content_type}")

    validate_upload_content(file.filename or "upload", content_type, content, type)

    if not all([CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET]):
        logger.error("[upload] Cloudinary signed upload env is not configured")
        raise HTTPException(status_code=500, detail="Загрузка файлов не настроена на сервере")

    # Для зашифрованных блобов всегда resource_type=raw
    resource_type = "raw" if type == "raw" else type

    cloudinary_url = (
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}"
        f"/{resource_type}/upload"
    )

    # Signed upload only. Unsigned preset fallback is intentionally removed for production safety.
    ts = int(time.time())
    sign_params = {
        "timestamp": str(ts),
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
        "overwrite": "false",
        "unique_filename": "true",
        "use_filename": "false",
    }
    signature = _cloudinary_sign(sign_params)
    form_data = {
        **sign_params,
        "signature": signature,
        "api_key": CLOUDINARY_API_KEY,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                cloudinary_url,
                data=form_data,
                files={"file": (file.filename or "upload", content, content_type)},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        logger.error("[upload] Cloudinary timeout")
        raise HTTPException(status_code=504, detail="Cloudinary не ответил")
    except httpx.HTTPStatusError as e:
        logger.error(f"[upload] Cloudinary HTTP error: {e.response.status_code} — {e.response.text}")
        raise HTTPException(status_code=502, detail="Ошибка Cloudinary")
    except Exception as e:
        logger.error(f"[upload] Unexpected: {e}")
        raise HTTPException(status_code=500, detail="Внутренняя ошибка сервера")

    secure_url = data.get("secure_url", "")
    if not is_trusted_cloudinary_delivery_url(secure_url):
        logger.error(f"[upload] Cloudinary вернул недоверенный secure_url: {data}")
        raise HTTPException(status_code=502, detail="Cloudinary вернул недоверенную ссылку")

    logger.info(
        f"[upload] ip={client_ip} size={len(content)} "
        f"type={resource_type} url={secure_url[:60]}…"
    )
    return JSONResponse({"url": secure_url})


# ══════════════════════════════════════════════════════════════════
#  § 4  ВСПОМОГАТЕЛЬНОЕ — подпись Cloudinary (signed uploads)
# ══════════════════════════════════════════════════════════════════

def _cloudinary_sign(params: dict) -> str:
    """
    Генерирует подпись для signed Cloudinary upload.
    Используй если перейдёшь с unsigned на signed preset (рекомендуется для production).

    params — словарь параметров запроса (без api_key и signature)
    """
    sorted_params = "&".join(
        f"{k}={v}" for k, v in sorted(params.items())
    )
    payload = sorted_params + CLOUDINARY_API_SECRET
    return hashlib.sha256(payload.encode()).hexdigest()



@app.post("/api/security-alert")
async def security_alert(request: Request):
    """Принимает клиентские security/audit события. Не раскрывает детали наружу."""
    client_ip = get_client_ip(request)
    # Endpoint intentionally has IP-only rate limiting because CSP reports may be unauthenticated.
    if not await check_rate_limit(client_ip, "security-alert"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    try:
        data = await request.json()
    except Exception:
        data = {}
    logger.warning("[security-alert] ip=%s event=%s", client_ip, data.get("event", "unknown"))
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
#  § 5  ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК
# ══════════════════════════════════════════════════════════════════

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"[global] Необработанная ошибка: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Внутренняя ошибка сервера"},
    )


# ══════════════════════════════════════════════════════════════════
#  Точка входа для прямого запуска (python server.py)
# ══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=os.environ.get("ENV", "production") == "development",
        log_level="info",
    )