# Supply an approved Node >=22.18 Debian bookworm-slim image pinned by digest.
# Build/registration is a separate authorized cloud setup step.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install --yes --no-install-recommends git coreutils python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.17.0 && git config --system user.name 'Pitcrew change worker' && git config --system user.email 'pitcrew-worker@localhost'
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
