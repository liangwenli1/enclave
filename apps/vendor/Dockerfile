FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production ENCLAVE_DATA_DIR=/data PORT=3012
EXPOSE 3012
VOLUME ["/data"]
CMD ["node", "src/server.js"]
