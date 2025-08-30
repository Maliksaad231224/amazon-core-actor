# Use official Apify Node image (Node 18)
FROM apify/actor-node:18

# Create app dir
WORKDIR /usr/src/app

# Install deps first (better layer caching)
COPY package.json ./
RUN npm install --only=production

# Copy the rest
COPY . ./

# (Optional) Show versions in build logs
RUN node -v && npm -v

# Start
CMD ["node", "src/main.js"]
