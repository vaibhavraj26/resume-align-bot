# Use a Node.js LTS image based on Debian
FROM node:20-bullseye-slim

# Install necessary OS packages for Puppeteer / Chromium
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# We don't need the standalone Chromium as we just installed google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
# Point puppeteer to the installed Chrome (the one we just apt-get installed)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Create temp directory for generating files
RUN mkdir -p temp && chmod 777 temp

# Install dependencies first to cache this layer
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

# Expose the Express API port
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
