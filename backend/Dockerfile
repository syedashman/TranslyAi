FROM python:3.11-slim
WORKDIR /app
# ffmpeg: required for Meeting Chat's "Upload Recording" video-to-audio extraction (app/services/video.py). Not
# present in python:3.11-slim by default. --no-install-recommends keeps the image small; the apt list cache is
# removed in the same layer so it isn't baked into the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]