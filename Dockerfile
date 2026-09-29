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
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main"]
