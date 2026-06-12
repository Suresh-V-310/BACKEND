FROM ruby:3.3-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git sqlite3 libsqlite3-dev \
    && gem install rails sinatra rspec \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["ruby", "--version"]
