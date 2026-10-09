# The compile service, and the compiler it drives.
#
# The compiler is the component that parses hostile input, so it is the
# component this image exists to contain. It is managed code, so the realistic
# failure modes are hangs, stack overflow, unbounded memory and unbounded
# output rather than memory-safety exploits. The controls that matter are
# therefore resource limits and a small blast radius, not exploit hardening.
#
# Build context is the repository root, because the service shares the
# reference-set resolution in shared/ with the analyse service. The two must
# agree, or the editor would report errors the build does not.
#
# Run limits are applied at run time, not here: see compose.yaml.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS base

# Node runs the service; the SDK supplies dotnet, the reference pack the
# compiler compiles against, and a place to install the compiler tool.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

RUN useradd --create-home --shell /usr/sbin/nologin playground

USER playground
WORKDIR /home/playground

# Mount points for the named volumes in compose.yaml. A new volume takes the
# ownership of the directory it is first mounted over, so these have to exist,
# owned by this user, before the volume does.
RUN mkdir -p /home/playground/results /home/playground/cells

ARG GHUL_COMPILER_VERSION=65.4.4
ARG GHUL_RUNTIME_VERSION=25.5.0
ARG GHUL_RASTER_VERSION=0.12.0

RUN dotnet tool install --tool-path /home/playground/tools \
        ghul.compiler --version "${GHUL_COMPILER_VERSION}" \
 && dotnet new classlib -o /tmp/runtime-probe \
 && dotnet add /tmp/runtime-probe package ghul.runtime --version "${GHUL_RUNTIME_VERSION}" \
 && dotnet add /tmp/runtime-probe package ghul.raster --version "${GHUL_RASTER_VERSION}" \
 && rm -rf /tmp/runtime-probe

# The disassembler the assembly view runs over a compiled program, pinned like
# the compiler: a new version can change the listing a reader is shown.
ARG ILSPYCMD_VERSION=11.0.0.9375

RUN dotnet tool install --tool-path /home/playground/tools \
        ilspycmd --version "${ILSPYCMD_VERSION}"

# The library sources a --target wasm compile builds against, at the tags
# ghul-cli pins for this compiler (scripts/check-wasm-pins.js holds the two in
# step). The runtime's sources are the tag of the runtime package above.
ARG GHUL_CORE_VERSION=0.39.0

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

# Resolved once here rather than discovered per request, so a missing piece
# fails the build rather than the first user request.
ENV ILSPYCMD=/home/playground/tools/ilspycmd

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
COPY --chown=playground:playground compile-service/*.js /home/playground/service/compile-service/

# The compiler writes its output next to the source, so the service needs a
# writable scratch directory. compose.yaml mounts a tmpfs there, which is why
# the root filesystem can stay read-only.
ENV TMPDIR=/tmp \
    HOST=0.0.0.0 \
    PORT=5090

EXPOSE 5090

# Hits the service's own health endpoint, which compiles a fixed program and
# caches the result. It must not need a token: the check has none to present,
# and gating it behind one reports a working service as permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=20s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5090/health') \
      .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /home/playground/service
ENTRYPOINT ["node", "compile-service/server.js"]
