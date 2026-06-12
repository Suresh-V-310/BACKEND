FROM gcc:14-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      gcc \
      g++ \
      make \
      libc6-dev \
      libpthread-stubs0-dev \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["sh", "-lc", "gcc --version"]
