FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install | bash

# Ensure opencode is in PATH
ENV PATH="/root/.opencode/bin:/root/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Create data directory
RUN mkdir -p /data

# Set environment
ENV NODE_ENV=production
ENV XDG_DATA_HOME=/data
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the app
CMD ["node", "src/server.js"]
