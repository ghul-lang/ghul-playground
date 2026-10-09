# The analyse service, the ghūl language server, and the compiler it drives.
#
# Build context is the repository root, because the service shares the
# reference-set resolution in shared/ with the compile service. The two must
# agree, or the editor would report errors the build does not.
#
# Run limits are applied at run time, not here: see compose.yaml.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm curl \
 && rm -rf /var/lib/apt/lists/*

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

ARG GHUL_LANGUAGE_SERVER_VERSION=1.31.8

# Not published to npm; it ships as an asset on the extension's releases.
RUN npm install -g --no-audit --no-fund \
    "https://github.com/degory/ghul-vsce/releases/download/v${GHUL_LANGUAGE_SERVER_VERSION}/ghul-language-server-${GHUL_LANGUAGE_SERVER_VERSION}.tgz"

RUN useradd --create-home --shell /usr/sbin/nologin playground

USER playground
WORKDIR /home/playground

# Mount point for the compile service's cell cache, which this service reads.
# A new volume takes the ownership of the directory it is first mounted over,
# and either service may be the first to mount it.
RUN mkdir -p /home/playground/cells

ARG GHUL_COMPILER_VERSION=65.4.5
ARG GHUL_RUNTIME_VERSION=25.6.0
ARG GHUL_RASTER_VERSION=0.12.0

# Installing as a tool seeds the package cache, which is where the service
# finds the compiler dll; it does not need to be on PATH, because each
# analyser workspace names the compiler explicitly in its ghul.json.
RUN dotnet tool install --tool-path /home/playground/tools \
        ghul.compiler --version "${GHUL_COMPILER_VERSION}" \
 && dotnet new classlib -o /tmp/runtime-probe \
 && dotnet add /tmp/runtime-probe package ghul.runtime --version "${GHUL_RUNTIME_VERSION}" \
 && dotnet add /tmp/runtime-probe package ghul.raster --version "${GHUL_RASTER_VERSION}" \
 && rm -rf /tmp/runtime-probe

# The library sources an analyser for the wasm target reads in place of the
# reference assemblies: the same tags the compile service builds wasm against
# (scripts/check-wasm-pins.js checks the two images agree).
ARG GHUL_CORE_VERSION=0.40.0

ADD --chown=playground:playground \
    https://github.com/ghul-lang/ghul-core/archive/refs/tags/v${GHUL_CORE_VERSION}.tar.gz /tmp/ghul-core.tar.gz
ADD --chown=playground:playground \
    https://github.com/ghul-lang/ghul-runtime/archive/refs/tags/v${GHUL_RUNTIME_VERSION}.tar.gz /tmp/ghul-runtime.tar.gz
# ghul.raster's sources at the tag of the package above, for a wasm program
# that draws.
ADD --chown=playground:playground \
    https://github.com/ghul-lang/ghul-raster/archive/refs/tags/v${GHUL_RASTER_VERSION}.tar.gz /tmp/ghul-raster.tar.gz

RUN mkdir -p /home/playground/libraries/ghul-core /home/playground/libraries/ghul-runtime /home/playground/libraries/ghul-raster \
 && tar -xzf /tmp/ghul-core.tar.gz --strip-components=1 -C /home/playground/libraries/ghul-core \
 && tar -xzf /tmp/ghul-runtime.tar.gz --strip-components=1 -C /home/playground/libraries/ghul-runtime \
 && tar -xzf /tmp/ghul-raster.tar.gz --strip-components=1 -C /home/playground/libraries/ghul-raster \
 && rm /tmp/ghul-core.tar.gz /tmp/ghul-runtime.tar.gz /tmp/ghul-raster.tar.gz \
 && test -f /home/playground/libraries/ghul-runtime/wasm-sources.rsp \
 && test -d /home/playground/libraries/ghul-raster/src

ENV GHUL_COMPILER_DLL=/home/playground/tools/.store/ghul.compiler/${GHUL_COMPILER_VERSION}/ghul.compiler/${GHUL_COMPILER_VERSION}/tools/net10.0/any/ghul.dll \
    GHUL_RUNTIME_DLL=/home/playground/.nuget/packages/ghul.runtime/${GHUL_RUNTIME_VERSION}/lib/net10.0/ghul-runtime.dll \
    GHUL_RASTER_DLL=/home/playground/.nuget/packages/ghul.raster/${GHUL_RASTER_VERSION}/lib/net10.0/ghul-raster.dll \
    GHUL_CORE_DIR=/home/playground/libraries/ghul-core \
    GHUL_RUNTIME_SOURCE_DIR=/home/playground/libraries/ghul-runtime \
    GHUL_RUNTIME_SOURCE_VERSION=${GHUL_RUNTIME_VERSION} \
    GHUL_RASTER_SOURCE_DIR=/home/playground/libraries/ghul-raster \
    GHUL_RASTER_SOURCE_VERSION=${GHUL_RASTER_VERSION} \
    GHUL_CORE_VERSION=${GHUL_CORE_VERSION}

COPY --chown=playground:playground shared /home/playground/service/shared
COPY --chown=playground:playground analyse-service/*.js /home/playground/service/analyse-service/
COPY --chown=playground:playground package.json /home/playground/service/package.json

# `ws` is the only runtime dependency; monaco is a front-end asset and has no
# business in this image.
RUN cd /home/playground/service && npm install --omit=dev --no-audit --no-fund ws --ignore-scripts

ENV TMPDIR=/tmp \
    HOST=0.0.0.0 \
    PORT=5091

EXPOSE 5091

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5091/health || exit 1

WORKDIR /home/playground/service
ENTRYPOINT ["node", "analyse-service/server.js"]
