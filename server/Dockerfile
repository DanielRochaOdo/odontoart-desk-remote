FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
