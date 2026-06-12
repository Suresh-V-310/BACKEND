FROM maven:3.9-eclipse-temurin-21

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends gradle curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["java", "-version"]
