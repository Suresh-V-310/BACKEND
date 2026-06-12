FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends octave \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["octave", "--version"]
