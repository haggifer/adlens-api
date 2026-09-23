# Single image for the API and the analysis worker. The API runs `node dist/main`; the analysis Cloud
# Run Job overrides the command to `node dist/worker`.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
# rules.json is emitted into dist by the nest-cli asset step during the build stage.
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main"]
