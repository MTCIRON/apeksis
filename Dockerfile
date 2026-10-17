# syntax=docker/dockerfile:1.7
# Immutable multi-arch Python 3.12.12 Bookworm manifest, queried from Docker Hub.
ARG PYTHON_IMAGE=python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
FROM ${PYTHON_IMAGE} AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/cache
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg libgomp1 libsndfile1 ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 voxi \
    && useradd --uid 10001 --gid 10001 --no-create-home voxi \
    && mkdir -p /models \
    && chown 10001:10001 /models
RUN python -m pip install uv==0.6.17
WORKDIR /app
COPY pyproject.toml uv.lock README.md /app/
COPY THIRD_PARTY_NOTICES.md /app/
COPY src /app/src
COPY scripts/provision_models.py /app/scripts/provision_models.py
COPY scripts/bootstrap_secrets.py /app/scripts/bootstrap_secrets.py
COPY infra/healthcheck.py /app/infra/healthcheck.py

FROM base AS gateway
RUN uv export --locked --no-dev --no-emit-project --no-hashes --output-file /tmp/constraints.txt \
    && python -m pip install -c /tmp/constraints.txt .
USER 10001:10001
EXPOSE 8080
CMD ["uvicorn", "voxi.gateway:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

FROM base AS tts
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN uv export --locked --no-dev --extra tts --no-emit-project --no-hashes --output-file /tmp/constraints.txt \
    && python -m pip install -c /tmp/constraints.txt --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple torch==2.7.0 \
    && python -m pip install -c /tmp/constraints.txt '.[tts]'
USER 10001:10001
EXPOSE 8081
CMD ["uvicorn", "voxi.workers.tts:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "1"]

FROM base AS antalia
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN uv export --locked --no-dev --extra antalia --no-emit-project --no-hashes --output-file /tmp/constraints.txt \
    && python -m pip install -c /tmp/constraints.txt --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple torch==2.7.0 \
    && python -m pip install -c /tmp/constraints.txt '.[antalia]'
USER 10001:10001
EXPOSE 8083
CMD ["uvicorn", "voxi.workers.tts:app", "--host", "0.0.0.0", "--port", "8083", "--workers", "1"]

FROM base AS stt
# CPU CTranslate2 does not need torch. CUDA builds install the matching torch
# wheel solely to supply pinned NVIDIA CUDA 12.6 / cuDNN 9 runtime libraries.
ARG INSTALL_CUDA_TORCH=0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126
RUN uv export --locked --no-dev --extra stt --extra tts --no-emit-project --no-hashes --output-file /tmp/constraints.txt \
    && if [ "$INSTALL_CUDA_TORCH" = 1 ]; then \
      python -m pip install -c /tmp/constraints.txt --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple torch==2.7.0; \
    fi \
    && python -m pip install -c /tmp/constraints.txt '.[stt]'
USER 10001:10001
EXPOSE 8082
CMD ["uvicorn", "voxi.workers.stt:app", "--host", "0.0.0.0", "--port", "8082", "--workers", "1"]

FROM base AS smoke
RUN uv export --locked --no-dev --extra dev --no-emit-project --no-hashes --output-file /tmp/constraints.txt \
    && python -m pip install -c /tmp/constraints.txt . openai==1.78.1
COPY scripts/smoke.py /app/scripts/smoke.py
USER 10001:10001
ENTRYPOINT ["python", "/app/scripts/smoke.py"]
CMD ["--base-url", "http://gateway:8080/v1", "--output-dir", "/tmp/smoke-output"]
