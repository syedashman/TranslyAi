import gc
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import router

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


app = FastAPI(
    title="AI Translator API",
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

app.include_router(router)


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ai-translator-backend"}
 