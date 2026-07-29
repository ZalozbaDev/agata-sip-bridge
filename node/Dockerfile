# build container
FROM node:24 AS sipclientbuild
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# RUN ls -l

# deployment container
#FROM nginx:stable-alpine

#COPY --from=webappbuild /app/dist /usr/share/nginx/html
# internal port is 80
#CMD ["nginx", "-g", "daemon off;"]

# === STAGE 2: Deployment-Container (Kein Nginx!) ===
FROM node:24
WORKDIR /app

# Nur die produktionsrelevanten Abhängigkeiten installieren
COPY package*.json ./
RUN npm ci --only=production
# RUN npm ci --omit=dev

# Kopiere das gebaute Frontend UND den Backend-Code aus Stage 1
COPY --from=sipclientbuild /app/dist ./dist
#COPY --from=sipclientbuild /app/server.js ./server.js 
# (Ersetzen Sie 'server.js' durch Ihre Haupt-Backend-Datei, z. B. 'index.js' oder 'src/')

# Umgebungsvariable für den Produktionsmodus
ENV NODE_ENV=production
EXPOSE 3000

# Startet Ihre JavaScript-App direkt
CMD ["node", "dist/index.js"]
