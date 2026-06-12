FROM mcr.microsoft.com/dotnet/sdk:8.0

USER root
RUN dotnet new install Microsoft.DotNet.Web.ProjectTemplates.8.0 || true \
    && dotnet tool install --global dotnet-ef || true

ENV PATH="${PATH}:/root/.dotnet/tools"

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["dotnet", "--info"]
