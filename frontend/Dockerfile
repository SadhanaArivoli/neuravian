FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
# GIT_COMMIT is injected by the build pipeline (build-full.mjs).
# It busts the Docker layer cache when the commit changes and is written
# to version.json so the Electron app can verify the frontend is current.
ARG GIT_COMMIT=unknown
LABEL org.neuroforge.git-commit=$GIT_COMMIT
COPY --from=builder /app/dist /usr/share/nginx/html
RUN printf '{"commit":"%s"}\n' "$GIT_COMMIT" > /usr/share/nginx/html/version.json
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
