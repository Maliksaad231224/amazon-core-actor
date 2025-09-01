# Use the Apify image that includes Node.js 20 + Chrome
FROM apify/actor-node-puppeteer-chrome:20

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json ./

# Fix permissions for the app directory (CRITICAL STEP)
RUN chown -R myuser:myuser /usr/src/app

# Install production dependencies as the correct user
RUN npm install --omit=dev

# Copy the rest of your application code
COPY . ./

# (Optional) Verify versions
RUN echo "Node version: $(node -v)" && echo "NPM version: $(npm -v)"

# Start the application
CMD ["node", "src/main.js"]
