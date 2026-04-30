"""
╔══════════════════════════════════════════════════════════════════╗
║          server.py — backend-прокси для чата 6А                 ║
║                                                                  ║
║  Что делает этот файл:                                           ║
║  1. /api/moderate — проверяет текст через Perspective API        ║
║  2. /api/upload   — грузит файлы в Cloudinary через signed upload║
║  3. /api/health   — простая проверка, что backend живой          ║
║                                                                  ║
║  Важно: секреты лежат в .env / Render Environment, не в коде.    ║
║  Запуск: uvicorn server:app --host 0.0.0.0 --port 8000           ║
╚══════════════════════════════════════════════════════════════════╝
"""

import hashlib
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

try:
    import redis.asyncio as redis_async
except Exception:  # redis не установлен локально — backend всё равно сможет работать без Redis
    redis_async = None


# ────────────────────────────────────────────────────────────────
# 0. ENV helpers
# ────────────────────────────────────────────────────────────────

load_dotenv()


def env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


# ────────────────────────────────────────────────────────────────
# 1. Configuration
# ────────────────────────────────────────────────────────────────

PERSPECTIVE_API_KEY = env_str("PERSPECTIVE_API_KEY")

CLOUDINARY_CLOUD_NAME = env_str("CLOUDINARY_CLOUD_NAME")
CLOUDINARY_UPLOAD_PRESET = env_str("CLOUDINARY_UPLOAD_PRESET")
CLOUDINARY_API_KEY = env_str("CLOUDINARY_API_KEY")
CLOUDINARY_API_SECRET = env_str("CLOUDINARY_API_SECRET")

ALLOWED_ORIGINS = [
    item.strip()
    for item in env_str("ALLOWED_ORIGINS", "https://6aclass.online").split(",")
    if item.strip()
]

TOXICITY_THRESHOLD = env_float("TOXICITY_THRESHOLD", 0.75)
MODERATION_FAIL_CLOSED = env_bool("MODERATION_FAIL_CLOSED", True)

# Общий fallback-лимит
MAX_UPLOAD_BYTES = env_int("MAX_UPLOAD_BYTES", 15 * 1024 * 1024)

# Отдельные лимиты по типам
MAX_IMAGE_BYTES = env_int("MAX_IMAGE_BYTES", 5 * 1024 * 1024)
MAX_AUDIO_BYTES = env_int("MAX_AUDIO_BYTES", 10 * 1024 * 1024)
MAX_RAW_BYTES = env_int("MAX_RAW_BYTES", 15 * 1024 * 1024)
MAX_VIDEO_BYTES = env_int("MAX_VIDEO_BYTES", 25 * 1024 * 1024)
ENABLE_VIDEO_UPLOADS = env_bool("ENABLE_VIDEO_UPLOADS", False)

# Rate limit
RATE_LIMIT_WINDOW = env_int("RATE_LIMIT_WINDOW", 60)
RATE_LIMIT_MAX_REQ = env_int("RATE_LIMIT_MAX_REQ", 30)

# Дневной лимит загрузок на IP. 300 МБ по умолчанию.
UPLOAD_DAILY_IP_LIMIT_BYTES = env_int("UPLOAD_DAILY_IP_LIMIT_BYTES", 300 * 1024 * 1024)

# Redis optional. Если REDIS_URL нет, используется память процесса.
REDIS_URL = env_str("REDIS_URL")


ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",

    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/aac",
    "audio/flac",

    "video/webm",

    # E2E-файлы: это зашифрованные байты, поэтому MIME обычно такой.
    "application/octet-stream",
}

DANGEROUS_EXTENSIONS = {
    "exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "sh",
    "php", "phtml", "js", "jar", "py", "rb", "pl", "cgi", "html", "htm"
}

MAGIC_SIGNATURES = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/gif": [b"GIF87a", b"GIF89a"],
    # WebP начинается с RIFF....WEBP. Ниже проверяем точнее.
    "image/webp": [b"RIFF"],

    "audio/ogg": [b"OggS"],
    "audio/mpeg": [b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"],
    "audio/wav": [b"RIFF"],
    "audio/x-wav": [b"RIFF"],

    "video/webm": [b"\x1a\x45\xdf\xa3"],
}


# ────────────────────────────────────────────────────────────────
# 2. Logging
# ────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("chat6a")


# ────────────────────────────────────────────────────────────────
# 3. Redis + local fallback
# ────────────────────────────────────────────────────────────────

redis_client: Optional[object] = None

# Локальная память нужна только если Redis не настроен.
# Минус: при рестарте сервера счётчики сбрасываются.
_local_rate_buckets: dict[str, list[float]] = {}
_local_upload_bytes: dict[str, tuple[int, float]] = {}


async def get_redis():
    global redis_client
    if redis_client is not None:
        return redis_client
    if not REDIS_URL or redis_async is None:
        return None

    try:
        redis_client = redis_async.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
        )
        await redis_client.ping()
        logger.info("[redis] connected")
        return redis_client
    except Exception as exc:
        logger.warning("[redis] not available, fallback to memory: %s", exc)
        redis_client = None
        return None


def get_client_ip(request: Request) -> str:
    """Берём реальный IP с учётом Render / reverse proxy."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def check_rate_limit(client_ip: str, endpoint: str) -> bool:
    """
    True = запрос можно пропустить.
    False = слишком много запросов.
    """
    r = await get_redis()
    if r is not None:
        bucket = int(time.time() // RATE_LIMIT_WINDOW)
        key = f"rl:{endpoint}:{client_ip}:{bucket}"
        try:
            count = await r.incr(key)
            if count == 1:
                await r.expire(key, RATE_LIMIT_WINDOW + 10)
            return count <= RATE_LIMIT_MAX_REQ
        except Exception as exc:
            logger.warning("[redis] rate limit failed, fallback to memory: %s", exc)

    # fallback без Redis
    key = f"{client_ip}:{endpoint}"
    now = time.time()
    bucket_list = _local_rate_buckets.get(key, [])
    bucket_list = [t for t in bucket_list if now - t < RATE_LIMIT_WINDOW]
    if len(bucket_list) >= RATE_LIMIT_MAX_REQ:
        _local_rate_buckets[key] = bucket_list
        return False
    bucket_list.append(now)
    _local_rate_buckets[key] = bucket_list
    return True


async def check_daily_upload_quota(client_ip: str, size_bytes: int) -> bool:
    """
    True = IP ещё не превысил дневной лимит загрузок.
    False = лимит уже превышен.
    """
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    r = await get_redis()

    if r is not None:
        key = f"upload_bytes:{client_ip}:{today}"
        try:
            used = await r.incrby(key, size_bytes)
            if used == size_bytes:
                await r.expire(key, 60 * 60 * 36)
            return used <= UPLOAD_DAILY_IP_LIMIT_BYTES
        except Exception as exc:
            logger.warning("[redis] upload quota failed, fallback to memory: %s", exc)

    # fallback без Redis
    key = f"{client_ip}:{today}"
    used, expires_at = _local_upload_bytes.get(key, (0, time.time() + 60 * 60 * 36))
    if time.time() > expires_at:
        used = 0
        expires_at = time.time() + 60 * 60 * 36
    used += size_bytes
    _local_upload_bytes[key] = (used, expires_at)
    return used <= UPLOAD_DAILY_IP_LIMIT_BYTES


# ────────────────────────────────────────────────────────────────
# 4. FastAPI app
# ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Чат 6А — Backend Proxy",
    version="3.0.0",
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
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(), geolocation=(), payment=(), usb=()",
    )
    response.headers.setdefault(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains; preload",
    )
    return response


@app.on_event("startup")
async def startup():
    # Не падаем, если Redis недоступен. Просто включится fallback.
    await get_redis()


# ────────────────────────────────────────────────────────────────
# 5. Healthcheck
# ────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    r = await get_redis()
    redis_status = "off"
    if REDIS_URL:
        redis_status = "ok" if r is not None else "error"

    return {
        "status": "ok",
        "timestamp": int(time.time()),
        "redis": redis_status,
        "video_uploads": ENABLE_VIDEO_UPLOADS,
    }


# ────────────────────────────────────────────────────────────────
# 6. Moderation
# ────────────────────────────────────────────────────────────────

class ModerateRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_not_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text не может быть пустым")
        if len(value) > 4000:
            raise ValueError("text слишком длинный, максимум 4000 символов")
        return value


def moderation_fallback(reason: str) -> JSONResponse:
    """
    fail-closed: если проверка токсичности сломалась, блокируем отправку.
    fail-open: если явно выключить MODERATION_FAIL_CLOSED=false, не блокируем.
    """
    if MODERATION_FAIL_CLOSED:
        return JSONResponse({"toxic": True, "score": 1.0, "reason": reason})
    return JSONResponse({"toxic": False, "score": 0.0, "reason": reason})


@app.post("/api/moderate")
async def moderate(request: Request, body: ModerateRequest):
    client_ip = get_client_ip(request)

    if not await check_rate_limit(client_ip, "moderate"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")

    if not PERSPECTIVE_API_KEY:
        logger.error("[moderate] PERSPECTIVE_API_KEY is not configured")
        return moderation_fallback("moderation_key_missing")

    perspective_url = (
        "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze"
        f"?key={PERSPECTIVE_API_KEY}"
    )

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
            resp = await client.post(perspective_url, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        logger.warning("[moderate] Perspective timeout")
        return moderation_fallback("moderation_timeout")
    except httpx.HTTPStatusError as exc:
        logger.error("[moderate] Perspective HTTP error: %s", exc.response.status_code)
        return moderation_fallback("moderation_http_error")
    except Exception as exc:
        logger.error("[moderate] Unexpected error: %s", exc)
        return moderation_fallback("moderation_unavailable")

    scores = data.get("attributeScores", {})
    max_score = max(
        (
            attr.get("summaryScore", {}).get("value", 0.0)
            for attr in scores.values()
        ),
        default=0.0,
    )
    toxic = max_score >= TOXICITY_THRESHOLD

    logger.info(
        "[moderate] ip=%s score=%.3f toxic=%s text_len=%d",
        client_ip,
        max_score,
        toxic,
        len(body.text),
    )

    return JSONResponse({"toxic": toxic, "score": round(max_score, 4)})


# ────────────────────────────────────────────────────────────────
# 7. Upload validation + Cloudinary signed upload
# ────────────────────────────────────────────────────────────────

def upload_limit_for_type(upload_type: str, content_type: str) -> int:
    if upload_type == "image":
        return MAX_IMAGE_BYTES
    if upload_type == "audio":
        return MAX_AUDIO_BYTES
    if upload_type == "video":
        return MAX_VIDEO_BYTES
    if upload_type == "raw":
        return MAX_RAW_BYTES
    return MAX_UPLOAD_BYTES


def validate_upload_content(
    filename: str,
    content_type: str,
    content: bytes,
    upload_type: str,
) -> None:
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()

    if ext in DANGEROUS_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Опасное расширение файла запрещено")

    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")

    # raw — это E2E-зашифрованный blob. Его нельзя проверять по magic bytes,
    # потому что после шифрования байты выглядят случайными.
    if upload_type == "raw":
        return

    header = content[:16]

    if upload_type == "image":
        allowed = MAGIC_SIGNATURES.get(content_type, [])
        if not allowed or not any(header.startswith(sig) for sig in allowed):
            raise HTTPException(status_code=415, detail="Содержимое файла не похоже на картинку")

        # RIFF есть и у WAV, и у WebP. Для WebP дополнительно ищем WEBP.
        if content_type == "image/webp" and content[8:12] != b"WEBP":
            raise HTTPException(status_code=415, detail="Файл не похож на WebP")

    if upload_type == "audio":
        # Для аудио в браузерах бывают разные MIME, поэтому проверка мягче.
        if not content_type.startswith("audio/"):
            raise HTTPException(status_code=415, detail="Файл не похож на аудио")

    if upload_type == "video":
        if not ENABLE_VIDEO_UPLOADS:
            raise HTTPException(status_code=403, detail="Видео временно отключено")
        if not content_type.startswith("video/"):
            raise HTTPException(status_code=415, detail="Файл не похож на видео")

    # Для незашифрованных файлов простая защита от попытки загрузить скрипт.
    sample = content[:4096].lower()
    if b"<script" in sample or b"<?php" in sample:
        raise HTTPException(status_code=415, detail="Файл похож на исполняемый скрипт")


def cloudinary_sign(params: dict[str, str]) -> str:
    """
    Cloudinary signature:
    сортируем параметры, склеиваем key=value через &, добавляем API secret,
    считаем SHA-1. API secret никогда не уходит в браузер.
    """
    sorted_params = "&".join(
        f"{key}={value}" for key, value in sorted(params.items()) if value is not None
    )
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

    upload_type = type.strip().lower()
    if upload_type not in {"image", "audio", "video", "raw"}:
        raise HTTPException(status_code=400, detail="Недопустимый тип файла")

    if upload_type == "video" and not ENABLE_VIDEO_UPLOADS:
        raise HTTPException(status_code=403, detail="Видео временно отключено")

    content = await file.read()
    content_type = file.content_type or "application/octet-stream"
    filename = file.filename or "upload"

    limit = min(upload_limit_for_type(upload_type, content_type), MAX_UPLOAD_BYTES)
    if len(content) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"Файл слишком большой, максимум {limit // 1024 // 1024} МБ",
        )

    if upload_type != "raw" and content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail=f"Недопустимый MIME-тип: {content_type}")

    validate_upload_content(filename, content_type, content, upload_type)

    if not await check_daily_upload_quota(client_ip, len(content)):
        raise HTTPException(status_code=429, detail="Дневной лимит загрузок для IP превышен")

    required_cloudinary = [
        CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_UPLOAD_PRESET,
        CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET,
    ]
    if not all(required_cloudinary):
        logger.error("[upload] Cloudinary env is not fully configured")
        raise HTTPException(status_code=500, detail="Cloudinary не настроен на сервере")

    # В Cloudinary аудио обычно идёт через video resource_type.
    resource_type = {
        "image": "image",
        "audio": "video",
        "video": "video",
        "raw": "raw",
    }[upload_type]

    timestamp = str(int(time.time()))
    sign_params = {
        "timestamp": timestamp,
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
    }

    form_data = {
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
        "timestamp": timestamp,
        "api_key": CLOUDINARY_API_KEY,
        "signature": cloudinary_sign(sign_params),
    }

    cloudinary_url = (
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}"
        f"/{resource_type}/upload"
    )

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                cloudinary_url,
                data=form_data,
                files={"file": (filename, content, content_type)},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        logger.error("[upload] Cloudinary timeout")
        raise HTTPException(status_code=504, detail="Cloudinary не ответил")
    except httpx.HTTPStatusError as exc:
        logger.error(
            "[upload] Cloudinary HTTP error: %s — %s",
            exc.response.status_code,
            exc.response.text[:500],
        )
        raise HTTPException(status_code=502, detail="Ошибка Cloudinary")
    except Exception as exc:
        logger.error("[upload] Unexpected error: %s", exc)
        raise HTTPException(status_code=500, detail="Внутренняя ошибка сервера")

    secure_url = data.get("secure_url", "")
    if not secure_url.startswith("https://"):
        logger.error("[upload] Cloudinary did not return secure_url: %s", data)
        raise HTTPException(status_code=502, detail="Cloudinary не вернул ссылку")

    logger.info(
        "[upload] ip=%s type=%s resource=%s size=%d url=%s...",
        client_ip,
        upload_type,
        resource_type,
        len(content),
        secure_url[:60],
    )

    return JSONResponse({"url": secure_url})


# ────────────────────────────────────────────────────────────────
# 8. Security audit endpoint
# ────────────────────────────────────────────────────────────────

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


# ────────────────────────────────────────────────────────────────
# 9. Global error handler
# ────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("[global] Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=env_int("PORT", 8000),
        reload=env_str("ENV", "production") == "development",
        log_level="info",
    )
