# CloudBase 云托管 Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 80

ENV PORT=80
ENV NODE_ENV=production

CMD ["npm", "start"]
