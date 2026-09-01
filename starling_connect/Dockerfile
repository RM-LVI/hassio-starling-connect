ARG BUILD_FROM
FROM ${BUILD_FROM}

# Node.js runtime from the Alpine repos of the HA base image
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source + launcher
COPY src ./src
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
