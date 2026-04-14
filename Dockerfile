# Этап 1: сборка Vite → backend/app/static
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY backend ./backend
COPY frontend ./frontend
WORKDIR /build/frontend
RUN npm install
RUN npm run build

# Этап 2: API + Pandoc + OpenCV
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libgomp1 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ /app/
COPY --from=frontend-build /build/backend/app/static /app/app/static

ENV TMP_ROOT=/app/tmp
# Render и другие PaaS задают порт через переменную PORT
ENV PORT=8000
RUN mkdir -p /app/tmp

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
