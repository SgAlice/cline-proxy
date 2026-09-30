FROM node:22-alpine
WORKDIR /app
COPY proxy.mjs ./
ENV NODE_ENV=production PORT=3060 HOST=0.0.0.0
EXPOSE 3060
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3060/health || exit 1
USER node
CMD ["node", "proxy.mjs"]
