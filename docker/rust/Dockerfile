FROM rust:1.83-bookworm

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev libpq-dev sqlite3 libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/rust-deps/src \
    && printf '%s\n' \
      '[package]' \
      'name = "compiler-deps"' \
      'version = "0.1.0"' \
      'edition = "2021"' \
      '' \
      '[dependencies]' \
      'serde = { version = "1", features = ["derive"] }' \
      'tokio = { version = "1", features = ["full"] }' \
      'reqwest = { version = "0.12", features = ["json"] }' \
      'clap = { version = "4", features = ["derive"] }' \
      'rand = "0.8"' \
      'chrono = { version = "0.4", features = ["serde"] }' \
      'diesel = { version = "2", features = ["sqlite"] }' \
      'actix-web = "4"' \
      > /opt/rust-deps/Cargo.toml \
    && printf 'fn main() {}\n' > /opt/rust-deps/src/main.rs \
    && cd /opt/rust-deps && cargo build --release

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

ENV CARGO_HOME=/usr/local/cargo

CMD ["rustc", "--version"]
