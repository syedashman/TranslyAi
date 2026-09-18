from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import router

app = FastAPI(
    title="AI Translator API",
    description="Multilingual transcription, translation, and summarization API.",
    version="1.0.0",
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
 