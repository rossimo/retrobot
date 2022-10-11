FROM alpine:3.16.2

WORKDIR /retrobot

RUN apk add --no-cache nodejs npm git python3 xz-dev make g++
RUN npm install --global yarn cross-env forever

COPY . .

RUN yarn install && yarn cache clean

CMD ["yarn", "start"]
