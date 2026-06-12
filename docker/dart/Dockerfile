FROM dart:stable

USER root
RUN dart pub global activate flutter_tools 2>/dev/null || true

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["dart", "--version"]
