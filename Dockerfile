# CloudBase 云托管 Dockerfile
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 80

ENV PORT=80
ENV NODE_ENV=production

CMD ["npm", "start"]
