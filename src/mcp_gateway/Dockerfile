FROM node:20-slim

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --production

COPY . /app

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start"]
