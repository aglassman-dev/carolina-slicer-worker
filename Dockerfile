# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 node:24-bookworm-slim

ARG BAMBU_STUDIO_VERSION=v02.07.01.62
ARG BAMBU_STUDIO_URL=https://github.com/bambulab/BambuStudio/releases/download/v02.07.01.62/BambuStudio_ubuntu22.04-v02.07.01.62-20260616195227.AppImage
ARG BAMBU_STUDIO_SHA256=2749917af560f3b9a2681429da9c43d00c65d096e1a1c479cc49466634174549

LABEL org.opencontainers.image.title="Carolina Slicer Worker" \
      org.opencontainers.image.description="Isolated AGPL worker for signed, encrypted 3D production-estimate jobs" \
      org.opencontainers.image.source="https://github.com/aglassman-dev/carolina-slicer-worker" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      com.carolina3dprintstudio.bambu-studio.version="${BAMBU_STUDIO_VERSION}" \
      com.carolina3dprintstudio.bambu-studio.source="https://github.com/bambulab/BambuStudio"

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libdbus-1-3 \
    libegl1 \
    libfontconfig1 \
    libgl1 \
    libglu1-mesa \
    libgtk-3-0 \
    libnss3 \
    libopengl0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    libxkbcommon0 \
    libxrender1 \
    tini \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "${BAMBU_STUDIO_URL}" -o /tmp/BambuStudio.AppImage \
  && echo "${BAMBU_STUDIO_SHA256}  /tmp/BambuStudio.AppImage" | sha256sum --check --strict \
  && chmod 0755 /tmp/BambuStudio.AppImage \
  && cd /opt \
  && /tmp/BambuStudio.AppImage --appimage-extract >/dev/null \
  && mv /opt/squashfs-root /opt/bambu-studio \
  && rm /tmp/BambuStudio.AppImage \
  && test -x /opt/bambu-studio/AppRun \
  && find /opt/bambu-studio -type d -path "*/profiles/BBL" -print -quit | grep -q .

WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY lib ./lib
COPY scripts ./scripts
COPY slicer-worker ./slicer-worker
COPY LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md ./

RUN groupadd --system --gid 10001 slicer \
  && useradd --system --uid 10001 --gid slicer --home-dir /home/slicer --shell /usr/sbin/nologin slicer \
  && mkdir -p /home/slicer /work \
  && chown -R slicer:slicer /home/slicer /work \
  && chmod 0755 /app/scripts/cloud-entrypoint.sh

USER 10001:10001
ENV HOME=/home/slicer \
    NODE_ENV=production \
    SLICER_WORKER_ID=cloud-worker-1 \
    SLICER_WORKER_POLL_MS=10000

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/cloud-entrypoint.sh"]
