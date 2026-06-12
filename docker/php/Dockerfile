FROM php:8.3-cli

RUN apt-get update \
    && apt-get install -y --no-install-recommends git unzip libcurl4-openssl-dev libpng-dev libzip-dev libonig-dev default-mysql-client \
    && docker-php-ext-install mysqli pdo pdo_mysql curl mbstring gd zip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

USER root
RUN composer global require --no-interaction \
      laravel/installer \
      symfony/symfony \
      codeigniter4/framework \
    && ln -sf /root/.composer/vendor/bin/* /usr/local/bin/ 2>/dev/null || true

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["php", "-v"]
