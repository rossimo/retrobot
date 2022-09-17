FROM alpine:3.16.2

WORKDIR /retrobot

RUN apk add --no-cache nodejs npm git
RUN npm install --global yarn cross-env forever

COPY . .

RUN yarn install
RUN yarn cache clean

ENV FOREVER_ROOT="./forever"

CMD ["forever", "src/index.js"]
