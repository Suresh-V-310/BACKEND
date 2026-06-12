FROM node:22-bookworm

RUN npm install -g \
      typescript \
      ts-node \
      express \
      axios \
      @nestjs/core \
      @nestjs/common \
      @nestjs/platform-express \
      typeorm \
      prisma \
      rxjs \
      @prisma/client

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["ts-node", "--version"]
