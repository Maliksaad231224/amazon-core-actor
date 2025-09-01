# Use the Apify image that includes Node.js 20 + Chrome
FROM apify/actor-node-puppeteer-chrome:20

# Set working directory
WORKDIR /usr/src/app

# Copy package.json
COPY package.json ./

# Ensure we're using the correct user (myuser is the default in Apify images)
USER myuser

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of your application code
COPY --chown=myuser:myuser . ./

# Start the application
CMD ["node", "src/main.js"]
