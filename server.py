"""
╔══════════════════════════════════════════════════════════════════╗
║          server.py — Бэкенд-прокси для чата 6А                  ║
║                                                                  ║
║  Что делает этот сервер:                                         ║
║  1. /api/moderate  — проверяет текст через Perspective API       ║
║  2. /api/upload    — грузит файлы в Cloudinary с подписью        ║
║  3. /api/health    — проверка, что backend живой                 ║
║                                                                  ║
║  Простыми словами:                                               ║
║  - секретные ключи лежат только на backend;                      ║
║  - браузер не знает Cloudinary API secret;                       ║
║  - Redis, если подключён, хранит счётчики лимитов;               ║
║  - если Redis не подключён, есть fallback в памяти процесса.     ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import logging
import hashlib
import time

import httpx
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

try:
    import redis.asyncio as redis_async
except Exception:
    redis_async = None

load_dotenv()

# ────────────────────────────────────────────────────────────────
# Конфигурация
# ────────────────────────────────────────────────────────────────
PERSPECTIVE_API_KEY = os.environ.get("PERSPECTIVE_API_KEY", "")

CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
CLOUDINARY_UPLOAD_PRESET = os.environ.get("CLOUDINARY_UPLOAD_PRESET", "")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY", "")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "")

ALLOWED_ORIGINS = [
    x.strip()
    for x in os.environ.get("ALLOWED_ORIGINS", "https://6aclass.online").split(",")
    if x.strip()
]
REDIS_URL = os.environ.get("REDIS_URL", "")

TOXICITY_THRESHOLD = float(os.environ.get("TOXICITY_THRESHOLD", "0.75"))
MODERATION_FAIL_CLOSED = os.environ.get("MODERATION_FAIL_CLOSED", "true").lower() in {
    "1", "true", "yes", "on"
}

RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW", "60"))
RATE_LIMIT_MAX_REQ = int(os.environ.get("RATE_LIMIT_MAX_REQ", "30"))

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(15 * 1024 * 1024)))
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(5 * 1024 * 1024)))
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(10 * 1024 * 1024)))
MAX_RAW_BYTES = int(os.environ.get("MAX_RAW_BYTES", str(15 * 1024 * 1024)))
UPLOAD_DAILY_IP_LIMIT_BYTES = int(
    os.environ.get("UPLOAD_DAILY_IP_LIMIT_BYTES", str(300 * 1024 * 1024))
)
ENABLE_VIDEO_UPLOADS = os.environ.get("ENABLE_VIDEO_UPLOADS", "false").lower() in {
    "1", "true", "yes", "on"
}

ALLOWED_MIME_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
    "audio/wav", "audio/x-wav", "audio/aac", "audio/flac",
    "application/octet-stream",
}

DANGEROUS_EXTENSIONS = {
    "exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "sh",
    "php", "phtml", "js", "jar", "py", "rb",
}

MAGIC_SIGNATURES = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/gif": [b"GIF87a", b"GIF89a"],
    "image/webp": [b"RIFF"],
    "audio/ogg": [b"OggS"],
    "audio/mpeg": [b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"],
    "audio/wav": [b"RIFF"],
    "audio/x-wav": [b"RIFF"],
    "video/webm": [b"\x1a\x45\xdf\xa3"],
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("chat6a")

redis_client = None
if REDIS_URL and redis_async:
    try:
        redis_client = redis_async.from_url(REDIS_URL, decode_responses=True)
        logger.info("[redis] REDIS_URL configured")
    except Exception as exc:
        logger.warning("[redis] init failed: %s", exc)
        redis_client = None
elif REDIS_URL and not redis_async:
    logger.warning("[redis] REDIS_URL set, but redis package is not installed")

# Fallback-хранилища в памяти. Они сбрасываются при рестарте сервера.
_rate_buckets: dict[str, list[float]] = {}
_upload_bytes_buckets: dict[str, tuple[str, int]] = {}

app = FastAPI(
    title="Чат 6А — Бэкенд-прокси",
    version="2.1.0",
    docs_url=None,
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
    return response


def get_client_ip(request: Request) -> str:
    """Берём IP с учётом reverse proxy, например Render."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def check_rate_limit(client_ip: str, endpoint: str) -> bool:
    """True = запрос можно пропустить. False = лимит превышен."""
    if redis_client:
        window_id = int(time.time() // RATE_LIMIT_WINDOW)
        key = f"rl:{endpoint}:{client_ip}:{window_id}"
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, RATE_LIMIT_WINDOW + 10)
        return count <= RATE_LIMIT_MAX_REQ

    key = f"{client_ip}:{endpoint}"
    now = time.time()
    bucket = [t for t in _rate_buckets.get(key, []) if now - t < RATE_LIMIT_WINDOW]
    if len(bucket) >= RATE_LIMIT_MAX_REQ:
        _rate_buckets[key] = bucket
        return False
    bucket.append(now)
    _rate_buckets[key] = bucket
    return True


async def check_daily_upload_quota(client_ip: str, size_bytes: int) -> None:
    """Ограничивает общий объём загрузок с одного IP в день."""
    if UPLOAD_DAILY_IP_LIMIT_BYTES <= 0:
        return

    day = time.strftime("%Y%m%d", time.gmtime())
    if redis_client:
        key = f"upload_bytes:{client_ip}:{day}"
        total = await redis_client.incrby(key, size_bytes)
        if total == size_bytes:
            await redis_client.expire(key, 60 * 60 * 26)
        if total > UPLOAD_DAILY_IP_LIMIT_BYTES:
            raise HTTPException(status_code=429, detail="Дневной лимит загрузок превышен")
        return

    key = client_ip
    stored_day, total = _upload_bytes_buckets.get(key, (day, 0))
    if stored_day != day:
        total = 0
    total += size_bytes
    _upload_bytes_buckets[key] = (day, total)
    if total > UPLOAD_DAILY_IP_LIMIT_BYTES:
        raise HTTPException(status_code=429, detail="Дневной лимит загрузок превышен")


def moderation_fail(reason: str) -> JSONResponse:
    """fail-closed: если проверка не работает, считаем сообщение токсичным."""
    if MODERATION_FAIL_CLOSED:
        return JSONResponse({"toxic": True, "score": 1.0, "reason": reason})
    return JSONResponse({"toxic": False, "score": 0.0, "reason": reason})


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "timestamp": int(time.time()),
        "redis": bool(redis_client),
    }


class ModerateRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_not_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text не может быть пустым")
        if len(value) > 4000:
            raise ValueError("text слишком длинный (макс 4000 символов)")
        return value


@app.post("/api/moderate")
async def moderate(request: Request, body: ModerateRequest):
    client_ip = get_client_ip(request)
    if not await check_rate_limit(client_ip, "moderate"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")

    if not PERSPECTIVE_API_KEY:
        logger.error("[moderate] PERSPECTIVE_API_KEY is missing")
        return moderation_fail("missing_api_key")

    url = "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze"
    payload = {
        "comment": {"text": body.text},
        "requestedAttributes": {
            "TOXICITY": {},
            "INSULT": {},
            "THREAT": {},
            "IDENTITY_ATTACK": {},
        },
        "languages": ["ru", "en"],
        "doNotStore": True,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, params={"key": PERSPECTIVE_API_KEY}, json=payload)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException:
        logger.warning("[moderate] Perspective API timeout")
        return moderation_fail("moderation_timeout")
    except httpx.HTTPStatusError as exc:
        logger.error("[moderate] Perspective HTTP error: %s", exc.response.status_code)
        return moderation_fail("moderation_http_error")
    except Exception as exc:
        logger.error("[moderate] Unexpected error: %s", exc)
        return moderation_fail("moderation_unavailable")

    scores = data.get("attributeScores", {})
    max_score = max(
        (
            attr.get("summaryScore", {}).get("value", 0.0)
            for attr in scores.values()
        ),
        default=0.0,
    )
    toxic = max_score >= TOXICITY_THRESHOLD
    logger.info("[moderate] ip=%s score=%.3f toxic=%s text_len=%s", client_ip, max_score, toxic, len(body.text))
    return JSONResponse({"toxic": toxic, "score": round(max_score, 4)})


def validate_upload_content(filename: str, content_type: str, content: bytes, upload_type: str) -> None:
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext in DANGEROUS_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Опасное расширение файла запрещено")
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")

    if b"<script" in content[:4096].lower() or b"<?php" in content[:4096].lower():
        raise HTTPException(status_code=415, detail="Файл похож на исполняемый скрипт")

    header = content[:16]
    if upload_type == "image":
        allowed = MAGIC_SIGNATURES.get(content_type, [])
        if not allowed or not any(header.startswith(sig) for sig in allowed):
            raise HTTPException(status_code=415, detail="Содержимое файла не соответствует MIME-типу")


def per_type_limit(upload_type: str) -> int:
    if upload_type == "image":
        return min(MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES)
    if upload_type == "video":
        return min(MAX_UPLOAD_BYTES, 25 * 1024 * 1024)
    return min(MAX_RAW_BYTES, MAX_UPLOAD_BYTES)


def _cloudinary_sign(params: dict) -> str:
    """
    Подпись Cloudinary.

    Cloudinary берёт параметры запроса, сортирует их по ключу,
    склеивает как key=value&key=value, добавляет API secret и считает SHA-1.
    Файл и api_key в подпись не входят.
    """
    sorted_params = "&".join(f"{k}={v}" for k, v in sorted(params.items()) if v is not None)
    payload = sorted_params + CLOUDINARY_API_SECRET
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@app.post("/api/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    type: str = Form(default="raw"),
):
    client_ip = get_client_ip(request)
    if not await check_rate_limit(client_ip, "upload"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")

    if type not in {"image", "video", "raw"}:
        raise HTTPException(status_code=400, detail="Недопустимый тип файла")
    if type == "video" and not ENABLE_VIDEO_UPLOADS:
        raise HTTPException(status_code=415, detail="Видео временно отключено")

    content = await file.read()
    limit_bytes = per_type_limit(type)
    if len(content) > limit_bytes:
        raise HTTPException(status_code=413, detail=f"Файл слишком большой (макс {limit_bytes // 1024 // 1024} МБ)")

    await check_daily_upload_quota(client_ip, len(content))

    content_type = file.content_type or "application/octet-stream"
    if type != "raw" and content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail=f"Недопустимый MIME-тип: {content_type}")

    validate_upload_content(file.filename or "upload", content_type, content, type)

    required = [
        CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_UPLOAD_PRESET,
        CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET,
    ]
    if not all(required):
        logger.error("[upload] Cloudinary env is not fully configured")
        raise HTTPException(status_code=500, detail="Загрузка файлов не настроена на сервере")

    resource_type = "raw" if type == "raw" else type
    cloudinary_url = f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"

    timestamp = str(int(time.time()))
    signed_params = {
        "timestamp": timestamp,
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
    }
    form_data = {
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
        "timestamp": timestamp,
        "api_key": CLOUDINARY_API_KEY,
        "signature": _cloudinary_sign(signed_params),
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                cloudinary_url,
                data=form_data,
                files={"file": (file.filename or "upload", content, content_type)},
            )
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException:
        logger.error("[upload] Cloudinary timeout")
        raise HTTPException(status_code=504, detail="Cloudinary не ответил")
    except httpx.HTTPStatusError as exc:
        logger.error("[upload] Cloudinary HTTP error: %s — %s", exc.response.status_code, exc.response.text)
        raise HTTPException(status_code=502, detail="Ошибка Cloudinary")
    except Exception as exc:
        logger.error("[upload] Unexpected error: %s", exc)
        raise HTTPException(status_code=500, detail="Внутренняя ошибка сервера")

    secure_url = data.get("secure_url", "")
    if not secure_url.startswith("https://"):
        logger.error("[upload] Cloudinary did not return secure_url: %s", data)
        raise HTTPException(status_code=502, detail="Cloudinary не вернул ссылку")

    logger.info("[upload] ip=%s size=%s type=%s url=%s", client_ip, len(content), resource_type, secure_url[:80])
    return JSONResponse({"url": secure_url})


@app.post("/api/security-alert")
async def security_alert(request: Request):
    client_ip = get_client_ip(request)
    if not await check_rate_limit(client_ip, "security-alert"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    try:
        data = await request.json()
    except Exception:
        data = {}
    logger.warning("[security-alert] ip=%s event=%s", client_ip, data.get("event", "unknown"))
    return {"ok": True}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("[global] Необработанная ошибка: %s", exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=os.environ.get("ENV", "production") == "development",
        log_level="info",
    )
