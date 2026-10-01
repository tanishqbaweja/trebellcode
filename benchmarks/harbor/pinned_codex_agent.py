import hashlib
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment


class PinnedCodexAgent(Codex):
    """Stock Harbor Codex with only the installer replaced by a pinned binary upload."""

    _PINNED_VERSION = "0.158.0"
    _PINNED_TARBALL_SHA256 = (
        "3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb"
    )
    _REMOTE_ARCHIVE = "/tmp/trebell-codex-linux-x64.tgz"
    _REMOTE_ROOT = "/opt/trebell-codex"
    _REMOTE_BINARY = (
        _REMOTE_ROOT + "/vendor/x86_64-unknown-linux-musl/bin/codex"
    )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        archive_value = os.environ.get("TREBELL_CODEX_PINNED_TARBALL", "").strip()
        if not archive_value:
            raise ValueError(
                "TREBELL_CODEX_PINNED_TARBALL must point to the official "
                f"@openai/codex@{self._PINNED_VERSION}-linux-x64 npm tarball."
            )
        archive = Path(archive_value).expanduser().resolve()
        if not archive.is_file():
            raise FileNotFoundError(f"Pinned Codex tarball not found: {archive}")

        digest = hashlib.sha256()
        with archive.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        actual_sha256 = digest.hexdigest()
        if actual_sha256 != self._PINNED_TARBALL_SHA256:
            raise ValueError(
                "Pinned Codex tarball SHA-256 mismatch: "
                f"expected {self._PINNED_TARBALL_SHA256}, got {actual_sha256}"
            )

        await environment.upload_file(archive, self._REMOTE_ARCHIVE)
        root = shlex.quote(self._REMOTE_ROOT)
        archive_remote = shlex.quote(self._REMOTE_ARCHIVE)
        binary = shlex.quote(self._REMOTE_BINARY)
        expected = shlex.quote(self._PINNED_VERSION)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"rm -rf {root}; mkdir -p {root}; "
                f"tar -xzf {archive_remote} -C {root} --strip-components=1; "
                f"chmod 0755 {binary}; ln -sf {binary} /usr/local/bin/codex; "
                f"rm -f {archive_remote}; "
                "mkdir -p /tmp/codex-home /logs/agent/codex-sessions; "
                "rm -rf /tmp/codex-home/sessions; "
                "ln -s /logs/agent/codex-sessions /tmp/codex-home/sessions; "
                "chmod 0777 /logs/agent/codex-sessions; "
                "actual=\"$(codex --version | sed -E 's/^codex-cli[[:space:]]+//')\"; "
                f"test \"$actual\" = {expected} || {{ echo \"Unexpected Codex version: $actual\" >&2; exit 1; }}"
            ),
        )
