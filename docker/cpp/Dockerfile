FROM gcc:14-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential g++ gcc make cmake pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["g++", "--version"]
