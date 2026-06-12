FROM r-base:4.4.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4-openssl-dev libssl-dev libxml2-dev libfontconfig1-dev libharfbuzz-dev libfribidi-dev \
    && Rscript -e "install.packages(c('dplyr','ggplot2','tidyr','readr','shiny','caret','data.table'), repos='https://cloud.r-project.org')" \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["Rscript", "--version"]
