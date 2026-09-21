import gc
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routes import router
from app.services.chat_store import ChatStore

logger = logging.getLogger("ai-translator")
logging.basicConfig(level=logging.INFO)


def _log_memory_usage(label: str) -> None:
    try:
        import resource

        rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        logger.info("MEMORY USAGE (%s): %.2f MB", label, rss_mb)
    except Exception as exc:
        logger.info("MEMORY USAGE (%s): unavailable (%s)", label, exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    gc.collect()
    _log_memory_usage("startup")
    yield
    await ChatStore.close()


app = FastAPI(
    title="TranslyAi API",
    description="Multilingual transcription, translation, and summarization API.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error("UNHANDLED ERROR on %s %s: %r", request.method, request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error. Please try again."})


app.include_router(router)


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ai-translator-backend"}
 