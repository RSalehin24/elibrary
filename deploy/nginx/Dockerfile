FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

COPY frontend/ ./

ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

FROM nginx:1.27-alpine

COPY deploy/nginx/entrypoint.sh /usr/local/bin/library-nginx-entrypoint.sh
COPY deploy/nginx/library.conf.template /etc/nginx/templates/default.conf.template
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html

RUN chmod +x /usr/local/bin/library-nginx-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/library-nginx-entrypoint.sh"]
