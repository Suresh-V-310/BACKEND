FROM node:22-bookworm

RUN npm install -g \
      bootstrap \
      tailwindcss \
      @mui/material \
      react \
      react-dom

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["node", "--version"]
