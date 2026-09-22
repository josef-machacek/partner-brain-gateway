FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV GATEWAY_PORT=4000

EXPOSE 4000

CMD ["node", "--experimental-strip-types", "src/index.ts"]
