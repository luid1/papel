# Imagem oficial do Puppeteer — já vem com Chrome testado e funcionando
FROM ghcr.io/puppeteer/puppeteer:22

USER root
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY webhook-handler.js ./

EXPOSE 3001

CMD ["node", "webhook-handler.js"]
