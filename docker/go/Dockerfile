FROM golang:1.23-bookworm

USER root
RUN mkdir -p /opt/gomod && cd /opt/gomod \
    && go mod init compiler-deps \
    && go get github.com/gin-gonic/gin@v1.10.0 \
    && go get github.com/labstack/echo/v4@v4.13.3 \
    && go get gorm.io/gorm@v1.25.12 \
    && go mod tidy

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

ENV GOPROXY=https://proxy.golang.org,direct
ENV GOMODCACHE=/opt/gomod/pkg/mod

CMD ["go", "version"]
