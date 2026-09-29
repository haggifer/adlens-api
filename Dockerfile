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
COPY package*.json ./
# In the same layer as the install, or the removed files would still be stored: ffprobe-static ships binaries for every
# platform (~330 MB), and Cloud Run only needs linux/x64; the npm cache isn't needed at runtime either.
RUN npm ci --omit=dev \
    && rm -rf node_modules/ffprobe-static/bin/darwin node_modules/ffprobe-static/bin/win32 \
        node_modules/ffprobe-static/bin/linux/ia32 \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main"]
