# Saybooks hosted demo. node:20-slim (glibc) so better-sqlite3 uses its prebuilt binding.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Bake the conformance evidence into the image so the Spec tab has a report from second one.
RUN node -e "const R=require('./src/registry.js');R.loadModules();require('./src/conformance.js').runArea('o2c',{actor:'build'})"
ENV SAYBOOKS_DEMO=1 SAYBOOKS_PORT=8140
EXPOSE 8140
CMD ["node", "server.js"]
