"""
╔══════════════════════════════════════════════════════════════════╗
║          server.py — защищённый backend proxy для Чата 6А        ║
║                                                                  ║
║  /api/moderate                 — Perspective API fail-closed     ║
║  /api/upload                   — signed Cloudinary upload        ║
║  /api/security-alert           — audit events                    ║
║  /api/security-events          — admin audit read                ║
║  /api/cleanup-expired-messages — TTL cleanup helper              ║
║  /api/health                   — healthcheck                     ║
║                                                                  ║
║  Запуск: uvicorn server:app --host 0.0.0.0 --port 8000          ║
║  Зависимости: pip install fastapi uvicorn httpx python-dotenv    ║
║              firebase-admin python-multipart                    ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import logging
import hashlib
import time
from typing import Optional, Any

import httpx
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

try:
    import firebase_admin
    from firebase_admin import auth as fb_auth
    from firebase_admin import firestore as fb_firestore
    from firebase_admin import credentials
except Exception:  # firebase-admin optional for local dev, required in production
    firebase_admin = None
    fb_auth = None
    fb_firestore = None
    credentials = None

load_dotenv()

# ── Конфигурация ────────────────────────────────────────────────
PERSPECTIVE_API_KEY = os.environ.get("PERSPECTIVE_API_KEY", "")
CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
CLOUDINARY_UPLOAD_PRESET = os.environ.get("CLOUDINARY_UPLOAD_PRESET", "")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY", "")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "https://6aclass.online").split(",") if o.strip()]

REQUIRE_FIREBASE_AUTH = os.environ.get("REQUIRE_FIREBASE_AUTH", "0") == "1"
REQUIRE_SIGNED_CLOUDINARY_UPLOAD = os.environ.get("REQUIRE_SIGNED_CLOUDINARY_UPLOAD", "1") == "1"
TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "0") == "1"
ADMIN_UIDS = {x.strip() for x in os.environ.get("ADMIN_UIDS", "").split(",") if x.strip()}

TOXICITY_THRESHOLD = float(os.environ.get("TOXICITY_THRESHOLD", "0.75"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW", "60"))
RATE_LIMIT_MAX_REQ = int(os.environ.get("RATE_LIMIT_MAX_REQ", "30"))

ALLOWED_MIME_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
    "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "video/webm",
    "application/octet-stream",
}

DANGEROUS_EXTENSIONS = {
    "exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "sh", "php", "phtml", "js", "jar", "py", "rb", "html", "svg"
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("chat6a")

_rate_buckets: dict[str, list[float]] = {}
_audit_events: list[dict[str, Any]] = []

# ── Firebase Admin init ─────────────────────────────────────────
def init_firebase_admin() -> None:
    if firebase_admin is None or firebase_admin._apps:
        return
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    try:
        if cred_path and os.path.exists(cred_path):
            firebase_admin.initialize_app(credentials.Certificate(cred_path))
        else:
            firebase_admin.initialize_app()
        logger.info("Firebase Admin initialized")
    except Exception as e:
        logger.error("Firebase Admin init failed: %s", e)

init_firebase_admin()

class AuthContext(BaseModel):
    uid: str
    email: Optional[str] = None
    admin: bool = False
    claims: dict[str, Any] = {}


def get_client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def audit(event: str, request: Optional[Request] = None, uid: Optional[str] = None, **detail: Any) -> None:
    item = {
        "ts": int(time.time()),
        "event": event,
        "uid": uid,
        "ip": get_client_ip(request) if request else None,
        "detail": detail,
    }
    _audit_events.append(item)
    if len(_audit_events) > 1000:
        del _audit_events[: len(_audit_events) - 1000]
    logger.warning("[audit] %s uid=%s detail=%s", event, uid, detail)


def check_rate_limit(identity: str, endpoint: str) -> bool:
    key = f"{identity}:{endpoint}"
    now = time.time()
    bucket = [t for t in _rate_buckets.get(key, []) if now - t < RATE_LIMIT_WINDOW]
    if len(bucket) >= RATE_LIMIT_MAX_REQ:
        return False
    bucket.append(now)
    _rate_buckets[key] = bucket
    return True


async def require_auth(request: Request) -> AuthContext:
    if not REQUIRE_FIREBASE_AUTH:
        return AuthContext(uid="dev", admin=True, claims={"dev": True})
    if fb_auth is None or not firebase_admin or not firebase_admin._apps:
        audit("firebase_admin_unavailable", request)
        raise HTTPException(status_code=503, detail="Firebase Admin не настроен")
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        audit("missing_auth_token", request)
        raise HTTPException(status_code=401, detail="Требуется Firebase ID token")
    token = header.removeprefix("Bearer ").strip()
    try:
        decoded = fb_auth.verify_id_token(token, check_revoked=True)
    except Exception as e:
        audit("bad_auth_token", request, error=str(e)[:160])
        raise HTTPException(status_code=401, detail="Недействительный Firebase ID token")
    uid = decoded.get("uid", "")
    admin = bool(decoded.get("admin", False) or uid in ADMIN_UIDS)
    return AuthContext(uid=uid, email=decoded.get("email"), admin=admin, claims=decoded)


async def optional_auth(request: Request) -> Optional[AuthContext]:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or fb_auth is None or not firebase_admin or not firebase_admin._apps:
        return None
    try:
        decoded = fb_auth.verify_id_token(header.removeprefix("Bearer ").strip(), check_revoked=True)
        uid = decoded.get("uid", "")
        admin = bool(decoded.get("admin", False) or uid in ADMIN_UIDS)
        return AuthContext(uid=uid, email=decoded.get("email"), admin=admin, claims=decoded)
    except Exception:
        return None


async def require_admin(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
    if not ctx.admin:
        raise HTTPException(status_code=403, detail="Только для администратора")
    return ctx


app = FastAPI(title="Чат 6А — защищённый backend proxy", version="3.0.0", docs_url=None, redoc_url=None)

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


@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": int(time.time()), "firebaseAdmin": bool(firebase_admin and firebase_admin._apps)}


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


PERSPECTIVE_URL = "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze"


@app.post("/api/moderate")
async def moderate(request: Request, body: ModerateRequest, ctx: AuthContext = Depends(require_auth)):
    identity = f"uid:{ctx.uid}:ip:{get_client_ip(request)}"
    if not check_rate_limit(identity, "moderate"):
        audit("rate_limit_moderate", request, ctx.uid)
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    if not PERSPECTIVE_API_KEY:
        audit("moderation_key_missing", request, ctx.uid)
        return JSONResponse({"toxic": True, "score": 1.0, "reason": "moderation_unavailable"})

    payload = {
        "comment": {"text": body.text},
        "requestedAttributes": {"TOXICITY": {}, "INSULT": {}, "THREAT": {}, "IDENTITY_ATTACK": {}},
        "languages": ["ru", "en"],
        "doNotStore": True,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{PERSPECTIVE_URL}?key={PERSPECTIVE_API_KEY}", json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        audit("moderation_unavailable", request, ctx.uid, error=str(e)[:160])
        return JSONResponse({"toxic": True, "score": 1.0, "reason": "moderation_unavailable"})

    scores = data.get("attributeScores", {})
    max_score = max((attr.get("summaryScore", {}).get("value", 0.0) for attr in scores.values()), default=0.0)
    is_toxic = max_score >= TOXICITY_THRESHOLD
    return JSONResponse({"toxic": is_toxic, "score": round(max_score, 4)})


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


def _cloudinary_sign(params: dict[str, Any]) -> str:
    sorted_params = "&".join(f"{k}={v}" for k, v in sorted(params.items()) if v is not None and v != "")
    return hashlib.sha256((sorted_params + CLOUDINARY_API_SECRET).encode()).hexdigest()


@app.post("/api/upload")
async def upload(request: Request, file: UploadFile = File(...), type: str = Form(default="raw"), ctx: AuthContext = Depends(require_auth)):
    identity = f"uid:{ctx.uid}:ip:{get_client_ip(request)}"
    if not check_rate_limit(identity, "upload"):
        audit("rate_limit_upload", request, ctx.uid)
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    if type not in {"image", "video", "raw"}:
        raise HTTPException(status_code=400, detail="Недопустимый тип файла")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        audit("upload_too_large", request, ctx.uid, size=len(content))
        raise HTTPException(status_code=413, detail=f"Файл слишком большой (макс {MAX_UPLOAD_BYTES // 1024 // 1024} МБ)")

    content_type = file.content_type or "application/octet-stream"
    if type != "raw" and content_type not in ALLOWED_MIME_TYPES:
        audit("upload_bad_mime", request, ctx.uid, content_type=content_type)
        raise HTTPException(status_code=415, detail=f"Недопустимый MIME-тип: {content_type}")
    validate_upload_content(file.filename or "upload", content_type, content, type)

    if not CLOUDINARY_CLOUD_NAME:
        raise HTTPException(status_code=500, detail="Cloudinary cloud name не настроен")
    if REQUIRE_SIGNED_CLOUDINARY_UPLOAD and (not CLOUDINARY_API_KEY or not CLOUDINARY_API_SECRET):
        audit("cloudinary_signed_missing", request, ctx.uid)
        raise HTTPException(status_code=500, detail="Signed Cloudinary upload не настроен")
    if not REQUIRE_SIGNED_CLOUDINARY_UPLOAD and not CLOUDINARY_UPLOAD_PRESET:
        raise HTTPException(status_code=500, detail="Cloudinary upload preset не настроен")

    resource_type = "raw" if type == "raw" else type
    cloudinary_url = f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"

    form_data: dict[str, Any]
    if REQUIRE_SIGNED_CLOUDINARY_UPLOAD:
        timestamp = str(int(time.time()))
        form_data = {"timestamp": timestamp, "api_key": CLOUDINARY_API_KEY}
        if CLOUDINARY_UPLOAD_PRESET:
            form_data["upload_preset"] = CLOUDINARY_UPLOAD_PRESET
        form_data["signature"] = _cloudinary_sign({k: v for k, v in form_data.items() if k not in {"api_key", "signature"}})
    else:
        form_data = {"upload_preset": CLOUDINARY_UPLOAD_PRESET}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(cloudinary_url, data=form_data, files={"file": (file.filename or "upload", content, content_type)})
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Cloudinary не ответил")
    except httpx.HTTPStatusError as e:
        audit("cloudinary_http_error", request, ctx.uid, status=e.response.status_code, body=e.response.text[:240])
        raise HTTPException(status_code=502, detail="Ошибка Cloudinary")
    except Exception as e:
        audit("upload_unexpected", request, ctx.uid, error=str(e)[:160])
        raise HTTPException(status_code=500, detail="Внутренняя ошибка сервера")

    secure_url = data.get("secure_url", "")
    if not secure_url.startswith("https://"):
        raise HTTPException(status_code=502, detail="Cloudinary не вернул ссылку")
    audit("upload_success", request, ctx.uid, size=len(content), resource_type=resource_type)
    return JSONResponse({"url": secure_url})


@app.post("/api/security-alert")
async def security_alert(request: Request):
    ctx = await optional_auth(request)
    uid = ctx.uid if ctx else None
    identity = f"uid:{uid or 'anon'}:ip:{get_client_ip(request)}"
    if not check_rate_limit(identity, "security-alert"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    try:
        data = await request.json()
    except Exception:
        data = {}
    event = data.get("event") or data.get("csp-report", {}).get("violated-directive") or "client_security_alert"
    audit(str(event)[:80], request, uid, client=data)
    return {"ok": True}


@app.get("/api/security-events")
async def security_events(_: AuthContext = Depends(require_admin)):
    return {"events": _audit_events[-200:]}


@app.post("/api/cleanup-expired-messages")
async def cleanup_expired_messages(request: Request, ctx: AuthContext = Depends(require_auth)):
    """Best-effort cleanup. Для production лучше Cloud Scheduler/cron вызывает этот endpoint админским токеном."""
    if fb_firestore is None or not firebase_admin or not firebase_admin._apps:
        raise HTTPException(status_code=503, detail="Firestore Admin не настроен")
    if not check_rate_limit(f"uid:{ctx.uid}:ip:{get_client_ip(request)}", "cleanup"):
        raise HTTPException(status_code=429, detail="Слишком много запросов")
    db = fb_firestore.client()
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    deleted = 0
    try:
        # group messages
        for snap in db.collection("messages").where("deleteAt", "<=", now_iso).limit(100).stream():
            snap.reference.delete()
            deleted += 1
        # DM messages via collection group
        for snap in db.collection_group("messages").where("deleteAt", "<=", now_iso).limit(100).stream():
            snap.reference.delete()
            deleted += 1
    except Exception as e:
        audit("cleanup_error", request, ctx.uid, error=str(e)[:160])
        raise HTTPException(status_code=500, detail="Ошибка cleanup")
    audit("cleanup_done", request, ctx.uid, deleted=deleted)
    return {"ok": True, "deleted": deleted}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("[global] Необработанная ошибка: %s", exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), reload=os.environ.get("ENV", "production") == "development", log_level="info")
