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
║  Зависимости: pip install fastapi uvicorn httpx python-dotenv    ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import io
import logging
import hashlib
import hmac
import time
from functools import wraps
from typing import Optional

import httpx
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
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
ALLOWED_ORIGINS       = os.environ.get("ALLOWED_ORIGINS", "https://6aclass.online").split(",")

# Пороговый балл токсичности (0.0–1.0). 0.75 = блокируем при 75%+
TOXICITY_THRESHOLD = float(os.environ.get("TOXICITY_THRESHOLD", "0.75"))

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

# ── Rate limiting (простая in-memory реализация) ─────────────────
# Для production используй Redis + slowapi или аналог
_rate_buckets: dict[str, list[float]] = {}
RATE_LIMIT_WINDOW  = 60   # секунд
RATE_LIMIT_MAX_REQ = 30   # запросов за окно

def check_rate_limit(client_ip: str, endpoint: str) -> bool:
    """Возвращает True если лимит НЕ превышен."""
    key = f"{client_ip}:{endpoint}"
    now = time.time()
    bucket = _rate_buckets.get(key, [])
    # Удаляем старые метки
    bucket = [t for t in bucket if now - t < RATE_LIMIT_WINDOW]
    if len(bucket) >= RATE_LIMIT_MAX_REQ:
        return False
    bucket.append(now)
    _rate_buckets[key] = bucket
    return True

def get_client_ip(request: Request) -> str:
    """Извлекает IP клиента с учётом reverse-proxy заголовков."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
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
async def moderate(request: Request, body: ModerateRequest):
    """
    Проверяет текст на токсичность через Perspective API.
    Возвращает: { toxic: bool, score: float }
    """
    client_ip = get_client_ip(request)

    # Rate limiting
    if not check_rate_limit(client_ip, "moderate"):
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
    except httpx.TimeoutException:
        logger.warning("[moderate] Perspective API timeout")
        # fail-open: не блокируем если API недоступен
        return JSONResponse({"toxic": False, "score": 0.0})
    except httpx.HTTPStatusError as e:
        logger.error(f"[moderate] Perspective HTTP error: {e.response.status_code}")
        return JSONResponse({"toxic": False, "score": 0.0})
    except Exception as e:
        logger.error(f"[moderate] Unexpected error: {e}")
        return JSONResponse({"toxic": False, "score": 0.0})

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
    logger.info(
        f"[moderate] ip={client_ip} score={max_score:.3f} "
        f"toxic={is_toxic} text_len={len(body.text)}"
    )
    return JSONResponse({"toxic": is_toxic, "score": round(max_score, 4)})



DANGEROUS_EXTENSIONS = {
    "exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "sh", "php", "phtml", "js", "jar", "py", "rb"
}

MAGIC_SIGNATURES = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png":  [b"\x89PNG\r\n\x1a\n"],
    "image/gif":  [b"GIF87a", b"GIF89a"],
    "image/webp": [b"RIFF"],
    "audio/ogg":  [b"OggS"],
    "audio/mpeg": [b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"],
    "audio/wav":  [b"RIFF"],
    "audio/x-wav": [b"RIFF"],
    "video/webm": [b"\x1a\x45\xdf\xa3"],
}

def validate_upload_content(filename: str, content_type: str, content: bytes, upload_type: str) -> None:
    ext = (filename.rsplit('.', 1)[-1] if '.' in filename else '').lower()
    if ext in DANGEROUS_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Опасное расширение файла запрещено")
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")

    header = content[:16]
    if upload_type == "image":
        allowed = MAGIC_SIGNATURES.get(content_type, [])
        if not allowed or not any(header.startswith(sig) for sig in allowed):
            raise HTTPException(status_code=415, detail="Содержимое файла не соответствует MIME-типу")
    if b"<script" in content[:4096].lower() or b"<?php" in content[:4096].lower():
        raise HTTPException(status_code=415, detail="Файл похож на исполняемый скрипт")


# ══════════════════════════════════════════════════════════════════
#  § 3  ЗАГРУЗКА ФАЙЛОВ — Cloudinary прокси
# ══════════════════════════════════════════════════════════════════

@app.post("/api/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    type: str = Form(default="raw"),
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

    if not check_rate_limit(client_ip, "upload"):
        logger.warning(f"[upload] Rate limit exceeded for {client_ip}")
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

    if not CLOUDINARY_CLOUD_NAME or not CLOUDINARY_UPLOAD_PRESET:
        logger.error("[upload] Cloudinary env is not configured")
        raise HTTPException(status_code=500, detail="Загрузка файлов не настроена на сервере")

    # Для зашифрованных блобов всегда resource_type=raw
    resource_type = "raw" if type == "raw" else type

    cloudinary_url = (
        f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}"
        f"/{resource_type}/upload"
    )

    form_data = {
        "upload_preset": CLOUDINARY_UPLOAD_PRESET,
        # Для signed uploads (безопаснее) используй timestamp + signature
        # "timestamp": str(int(time.time())),
        # "signature": _cloudinary_sign({"timestamp": ..., "upload_preset": ...}),
        # "api_key":   CLOUDINARY_API_KEY,
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
    if not secure_url.startswith("https://"):
        logger.error(f"[upload] Cloudinary не вернул secure_url: {data}")
        raise HTTPException(status_code=502, detail="Cloudinary не вернул ссылку")

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
    if not check_rate_limit(client_ip, "security-alert"):
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
