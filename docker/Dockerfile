# aoe-sandbox: Docker image for Agent of Empires sandbox sessions
# This image provides Claude Code, OpenCode, Mistral Vibe, Codex CLI, Gemini CLI, Cursor CLI, Copilot CLI, and Pi in an isolated environment

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    ca-certificates \
    gnupg \
    jq \
    openssh-client \
    ripgrep \
    fzf \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (required for Codex CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Run as root - IS_SANDBOX=1 allows Claude Code to use --dangerously-skip-permissions
WORKDIR /root

# Install Claude Code CLI
# We download the binary directly instead of using the official install script
# because the script runs `claude install` (executes the binary) which fails
# under QEMU emulation during cross-platform Docker builds.
RUN set -eux; \
    GCS_BUCKET="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"; \
    version=$(curl -fsSL "$GCS_BUCKET/latest"); \
    case "$(uname -m)" in \
        x86_64|amd64) arch="x64" ;; \
        arm64|aarch64) arch="arm64" ;; \
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    platform="linux-${arch}"; \
    manifest=$(curl -fsSL "$GCS_BUCKET/$version/manifest.json"); \
    checksum=$(echo "$manifest" | jq -r ".platforms[\"$platform\"].checksum"); \
    mkdir -p /root/.local/bin /root/.local/share/claude/versions; \
    curl -fsSL -o "/root/.local/share/claude/versions/$version" "$GCS_BUCKET/$version/$platform/claude"; \
    actual=$(sha256sum "/root/.local/share/claude/versions/$version" | cut -d' ' -f1); \
    if [ "$actual" != "$checksum" ]; then echo "Checksum mismatch" >&2; exit 1; fi; \
    chmod +x "/root/.local/share/claude/versions/$version"; \
    ln -sf "/root/.local/share/claude/versions/$version" /root/.local/bin/claude; \
    test -s "/root/.local/share/claude/versions/$version"
ENV PATH="/root/.local/bin:${PATH}"

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

# Install Codex CLI (OpenAI)
RUN npm install -g @openai/codex

# Install Gemini CLI (Google)
RUN npm install -g @google/gemini-cli

# Install Mistral Vibe
RUN curl -LsSf https://mistral.ai/vibe/install.sh | bash
ENV PATH="/root/.vibe/bin:${PATH}"

# Install Cursor CLI
RUN curl -fsSL https://cursor.com/install | bash

# Install Copilot CLI (GitHub)
RUN npm install -g @github/copilot

# Install Pi (pi.dev)
RUN npm install -g @mariozechner/pi-coding-agent

# Create directories for credential mounts
RUN mkdir -p /root/.claude \
    /root/.config/opencode \
    /root/.local/share/opencode \
    /root/.vibe \
    /root/.codex \
    /root/.gemini \
    /root/.cursor \
    /root/.copilot \
    /root/.pi \
    /root/.factory \
    /root/.ssh

# Allow Claude Code to use --dangerously-skip-permissions as root
ENV IS_SANDBOX=1

# Verify that native binaries installed via curl-pipe-bash are not empty.
# These installers can silently produce 0-byte files under QEMU emulation
# during cross-platform Docker builds (the binary downloads fine but the
# self-install step fails when the host can't execute the foreign arch binary).
RUN set -eux; \
    for bin in /root/.local/bin/claude; do \
        test -s "$bin" || (echo "FATAL: $bin is empty (0 bytes), install failed silently" >&2; exit 1); \
    done; \
    echo "All native binaries verified"

# Set working directory
WORKDIR /workspace

# Default command - keep container running for docker exec
CMD ["sleep", "infinity"]
