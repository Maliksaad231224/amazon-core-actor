# Use the Apify image that includes Node.js 20 + Chrome
FROM apify/actor-node-puppeteer-chrome:20

# Set working directory
WORKDIR /usr/src/app

# Copy package.json
COPY package.json ./

# 1. FIRST install dependencies as ROOT (has permissions to create node_modules)
RUN npm install --omit=dev

# 2. THEN copy the rest of your application code
COPY . ./

# 3. FINALLY switch to the non-root user for security when running the app
USER myuser

# Start the application
CMD ["node", "src/main.js"]
