# Single image for the API and both jobs. The API runs `node dist/main`; the analysis Cloud Run Job
# overrides the command to `node dist/worker`, the daily cleanup job to `node dist/cleanup`.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ffprobe-static's Linux binary is a 2018 static build that segfaults on any hostname lookup under this image's glibc,
# so it can't open a signed URL. Debian's ffprobe is dynamically linked and resolves names normally.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# In the same layer as the install, or the removed files would still be stored: ffprobe-static ships binaries for every
# platform (~330 MB) and none is used here; the npm cache isn't needed at runtime either. MediaProber runs
# ffprobe-static's path, which then points at Debian's ffprobe (locally it's the bundled binary for the platform).
RUN npm ci --omit=dev \
    && rm -rf node_modules/ffprobe-static/bin/darwin node_modules/ffprobe-static/bin/win32 \
        node_modules/ffprobe-static/bin/linux/ia32 \
    && ln -sf /usr/bin/ffprobe node_modules/ffprobe-static/bin/linux/x64/ffprobe \
    && npm cache clean --force
# A segfault exits with 139; a refused connection with 1. Resolving localhost is enough to catch the static binary.
RUN node_modules/ffprobe-static/bin/linux/x64/ffprobe -v quiet https://localhost:9/; test $? -ne 139
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main"]
