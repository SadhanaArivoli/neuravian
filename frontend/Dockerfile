FROM node:20-alpine AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
COPY desktop/src/preload/viewer-api-contract.ts /desktop/src/preload/viewer-api-contract.ts
RUN npm run build

FROM nginx:alpine
# GIT_COMMIT is injected by the build pipeline (build-full.mjs).
# It busts the Docker layer cache when the commit changes and is written
# to version.json so the Electron app can verify the frontend is current.
ARG GIT_COMMIT=unknown
ARG RELEASE_VERSION=unknown
LABEL org.neuravian.component=frontend \
      org.neuravian.git-commit=$GIT_COMMIT \
      org.neuravian.release-version=$RELEASE_VERSION \
      org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$GIT_COMMIT
COPY --from=builder /app/dist /usr/share/nginx/html
RUN printf '{"commit":"%s","version":"%s","releaseVersion":"%s","component":"frontend"}\n' \
    "$GIT_COMMIT" "$RELEASE_VERSION" "$RELEASE_VERSION" > /usr/share/nginx/html/version.json
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
