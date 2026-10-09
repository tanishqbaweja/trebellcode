import hashlib
import os
import shlex
from pathlib import Path
from typing import Annotated, Literal, override

from pydantic import Field

from harbor.agents.installed.codex import Codex
from harbor.agents.installed.codex import CodexOptions
from harbor.agents.options import Cli
from harbor.environments.base import BaseEnvironment


class PinnedCodexOptions(CodexOptions):
    service_tier: Annotated[
        Literal["fast"] | None,
        Cli("-c", format="-c service_tier={value}"),
    ] = Field(
        default=None,
        description="OpenAI processing tier. Fast changes serving speed, not the model.",
    )
    web_search: Annotated[
        Literal["disabled"],
        Cli("-c", format="-c web_search={value}"),
    ] = Field(
        default="disabled",
        description="Hosted Codex web search is disabled for benchmark fairness.",
    )
    apps: Annotated[
        Literal["false"],
        Cli("-c", format="-c features.apps={value}"),
    ] = Field(
        default="false",
        description=(
            "ChatGPT apps/connectors (the codex_apps MCP server, whose tools include "
            "connector web search) are disabled for benchmark fairness."
        ),
    )


class PinnedCodexAgent(Codex):
    """Pinned stock Harbor Codex with Windows-safe persisted-session lookup."""

    _PINNED_VERSION = "0.158.0"
    options_model = PinnedCodexOptions
    _PINNED_TARBALL_SHA256 = (
        "3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb"
    )
    _REMOTE_ARCHIVE = "/tmp/trebell-codex-linux-x64.tgz"
    _REMOTE_ROOT = "/opt/trebell-codex"
    _REMOTE_BINARY = (
        _REMOTE_ROOT + "/vendor/x86_64-unknown-linux-musl/bin/codex"
    )

    @override
    def _get_session_dir(self) -> Path | None:
        # The benchmark persists Codex sessions in a real /logs/agent directory.
        # Harbor also syncs the CODEX_HOME sessions symlink itself, which becomes
        # an inaccessible reparse point on Windows hosts (WinError 1920).
        #
        # Never fall back to Harbor's agent/sessions path here. There is a
        # small post-run race where codex-sessions may not be visible yet;
        # touching the reparse point in that window converts an otherwise
        # completed solve into a trial infrastructure error before the verifier
        # can run. Usage can be recovered from the persisted Codex rollout by
        # Trebell's pair reporter, so "no session visible yet" is safer than an
        # unsafe fallback.
        sessions_dir = self.logs_dir / "codex-sessions"
        try:
            if not sessions_dir.exists():
                return None
            session_dirs = []
            for candidate in sessions_dir.rglob("*"):
                try:
                    if candidate.is_dir():
                        session_dirs.append(candidate)
                except OSError:
                    continue
            if not session_dirs:
                return None
            max_depth = max(len(d.parts) for d in session_dirs)
            deepest = [d for d in session_dirs if len(d.parts) == max_depth]
            if not deepest:
                return None
            existing = []
            for candidate in deepest:
                try:
                    existing.append((candidate.stat().st_mtime, candidate))
                except OSError:
                    continue
            return max(existing)[1] if existing else None
        except OSError:
            return None

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
