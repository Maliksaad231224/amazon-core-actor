# Use the Apify image that includes Node.js 20 + Chrome
FROM apify/actor-node-puppeteer-chrome:20

# Set working directory
WORKDIR /usr/src/app

# First, ensure root owns the directory for installation
USER root

# Copy package.json
COPY package.json ./

# Fix permissions for the app directory
RUN chown -R myuser:myuser /usr/src/app

# Switch back to myuser for npm install
USER myuser

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of your application code
COPY --chown=myuser:myuser . ./

# Start the application
CMD ["node", "src/main.js"]
