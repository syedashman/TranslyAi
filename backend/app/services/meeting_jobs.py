"""In-memory registry for meeting-processing jobs.

Why in-memory instead of a queue/broker: the backend Dockerfile runs a single uvicorn process (no --workers,
no gunicorn), so there is exactly one process holding this state - no risk of one worker accepting the upload and
a different one answering the status poll. This is the simplest architecture that actually fits the current Render
deployment, per the task's explicit "do not introduce Celery/Redis unless absolutely required."

Trade-off, stated plainly: a job's live state lives only in this process's memory. If the dyno restarts mid-job
(a deploy, a crash), in-flight jobs are lost - the status endpoint will 404 for that id afterward. Completed jobs
are also best-effort mirrored to Supabase (see meeting_store.py) when a service-role key is configured, so a
restart doesn't necessarily lose already-finished results, but a job's live progress is never durable.
"""

import time
import uuid
from typing import Optional

STAGES = ("queued", "uploading", "extracting_audio", "transcribing", "translating", "summarizing", "completed", "failed")

_JOBS: dict[str, dict] = {}
_MAX_JOBS = 500  # a simple cap so a long-running server doesn't accumulate unbounded memory from old jobs


def _evict_oldest_if_full() -> None:
    if len(_JOBS) < _MAX_JOBS:
        return
    oldest_id = min(_JOBS, key=lambda job_id: _JOBS[job_id]["created_at"])
    _JOBS.pop(oldest_id, None)


def create_job(user_id: Optional[str], duration_seconds: Optional[int], meeting_chat_id: Optional[str] = None) -> dict:
    _evict_oldest_if_full()
    job = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "meeting_chat_id": meeting_chat_id,
        "status": "queued",
        "duration_seconds": duration_seconds,
        "transcript": None,
        "translation": None,
        "summary": None,
        "error_message": None,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    _JOBS[job["id"]] = job
    return dict(job)


def get_job(job_id: str) -> Optional[dict]:
    job = _JOBS.get(job_id)
    return dict(job) if job else None


def update_job(job_id: str, **fields) -> Optional[dict]:
    job = _JOBS.get(job_id)
    if job is None:
        return None
    job.update(fields)
    job["updated_at"] = time.time()
    return dict(job)
