FROM node:20

# Install OpenJDK 17, Python 3, pip, venv, GCC, and G++
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    python3 \
    python3-pip \
    python3-venv \
    gcc \
    g++ \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Validate Java installation
RUN java -version
RUN javac -version

WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package.json package-lock.json* ./

RUN npm install

# Copy the entire project
COPY . .

# Run: bash scripts/install-runtime-dependencies.sh || true
RUN bash scripts/install-runtime-dependencies.sh || true

EXPOSE 5000

CMD ["npm", "start"]
