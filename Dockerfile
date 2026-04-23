FROM mcr.microsoft.com/playwright:v1.52.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3010
CMD ["node", "src/server.js"]
