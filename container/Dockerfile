FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY *.js ./

ENV NODE_ENV=production
ENV PORT=3847

EXPOSE 3847

CMD ["node", "server.js"]
