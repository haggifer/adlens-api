# Single image for both Cloud Run services. The API runs `node dist/main`; the worker service
# overrides the command to `node dist/worker`.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
# rules.json is emitted into dist by the nest-cli asset step during the build stage.
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main"]
