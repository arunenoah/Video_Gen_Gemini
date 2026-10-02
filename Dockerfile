# SparkGarden — one Python process + ffmpeg. State lives in VIDEOGEN_DATA_DIR (mount a persistent disk there).
FROM python:3.12-slim

# ffmpeg: stitching clips and extracting preview frames. util-linux (setpriv) is in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home app

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x deploy/entrypoint.sh

# Listens on $PORT (platforms set it; default 8767). Data folder is created/owned by the entrypoint.
ENV VIDEOGEN_BIND=0.0.0.0 \
    VIDEOGEN_DATA_DIR=/var/data \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
