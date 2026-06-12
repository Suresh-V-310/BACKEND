FROM node:22-bookworm

RUN npm install -g \
      express \
      react \
      react-dom \
      vue \
      @angular/core \
      @angular/common \
      axios \
      lodash \
      socket.io \
      mongoose \
      bcrypt \
      jsonwebtoken \
      multer \
      cors \
      dotenv \
      redux \
      @reduxjs/toolkit

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["node", "--version"]
