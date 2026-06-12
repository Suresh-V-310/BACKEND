FROM eclipse-temurin:21-jdk

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip gradle \
    && curl -fsSL -o /tmp/kotlin.zip https://github.com/JetBrains/kotlin/releases/download/v2.1.0/kotlin-compiler-2.1.0.zip \
    && unzip /tmp/kotlin.zip -d /opt \
    && ln -sf /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && rm /tmp/kotlin.zip \
    && mkdir -p /opt/kotlin-libs \
    && curl -fsSL -o /opt/kotlin-libs/kotlinx-coroutines-core.jar \
      https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.9.0/kotlinx-coroutines-core-jvm-1.9.0.jar \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

ENV KOTLIN_LIBS=/opt/kotlin-libs

CMD ["kotlinc", "-version"]
