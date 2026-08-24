FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DB_PATH=/app/data/djs_database.sqlite

CMD ["node", "src/index.js"]
