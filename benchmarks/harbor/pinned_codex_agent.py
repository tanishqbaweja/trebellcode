import asyncio
import hashlib
import os
import shlex
import tempfile
from pathlib import Path
from typing import Annotated, Literal, override

from pydantic import BeforeValidator, Field

from harbor.agents.installed.codex import Codex
from harbor.agents.installed.codex import CodexOptions
from harbor.agents.options import Cli
from harbor.environments.base import BaseEnvironment

from .agent_timeout_stop import stop_agent_tree
from .ca_bundle import ensure_ca_bundle


def _lowercase_bool(value):
    # Harbor parses --ak values, so "apps=false" arrives as the boolean False.
    return str(value).lower() if isinstance(value, bool) else value


def instruction_from_file(command: str, quoted: str, remote: str) -> str:
    """Harbor's command with its quoted instruction read from `remote` in the container instead: the same single
    argument, byte for byte, trailing newlines included (the x keeps $(...) from dropping them)."""
    if command.count(quoted) != 1:
        raise ValueError("the instruction must appear exactly once in the command")
    read = (
        f'TREBELL_CODEX_PROMPT="$(cat {shlex.quote(remote)}; printf x)"; '
        'TREBELL_CODEX_PROMPT="${TREBELL_CODEX_PROMPT%x}"; '
    )
    return read + command.replace(quoted, '"$TREBELL_CODEX_PROMPT"')


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
        BeforeValidator(_lowercase_bool),
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
    # What agent_timeout_stop.py looks for to stop Codex, and everything under it, at Harbor's agent timeout: Harbor's
    # run() starts `codex exec` with this flag.
    _CODEX_MARKER = "--dangerously-bypass-approvals-and-sandbox"
    # Harbor's run() puts the whole instruction, shell-quoted, on the docker compose exec command line, and Windows'
    # CreateProcess takes at most 32,767 characters, so a longer instruction fails there before Codex starts
    # (WinError 206: SWE-bench Multilingual's fastlane__fastlane-19207, 71,327 bytes). Such an instruction is uploaded to
    # this file instead, and the container's shell hands it to `codex exec` as the same single argument. A shorter
    # instruction keeps Harbor's command exactly as it was.
    _REMOTE_INSTRUCTION = "/tmp/trebell-codex-instruction.txt"
    _INLINE_INSTRUCTION_LIMIT = 24_000
    _instruction_on_file: str | None = None

    @override
    async def run(self, instruction, environment, context) -> None:
        quoted = shlex.quote(instruction)
        if len(quoted) <= self._INLINE_INSTRUCTION_LIMIT:
            return await super().run(instruction, environment, context)
        with tempfile.TemporaryDirectory() as folder:
            local = Path(folder) / "instruction.txt"
            local.write_bytes(instruction.encode("utf-8"))
            await environment.upload_file(local, self._REMOTE_INSTRUCTION)
        # Readable by the agent, which is the image's own USER when the task names none.
        await self.exec_as_root(
            environment, command=f"chmod 0644 {shlex.quote(self._REMOTE_INSTRUCTION)}"
        )
        self._instruction_on_file = quoted
        try:
            return await super().run(instruction, environment, context)
        finally:
            self._instruction_on_file = None

    @override
    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ):
        if self._instruction_on_file and self._instruction_on_file in command:
            command = instruction_from_file(
                command, self._instruction_on_file, self._REMOTE_INSTRUCTION
            )
        try:
            return await super().exec_as_agent(
                environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec
            )
        except asyncio.CancelledError:
            # Harbor's agent timeout (agent_timeout_stop.py): Codex takes no action after it. Stopping it here, inside
            # the cancelled exec and before Harbor's run() copies the sessions, means the copy ends where Codex stopped.
            await asyncio.shield(stop_agent_tree(self, environment, self._CODEX_MARKER))
            raise

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
        # The pinned binary reads the system CA store, so an image without one could not reach the API (ca_bundle.py).
        await ensure_ca_bundle(self, environment)
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
        # CODEX_HOME is made here as root, but Codex and Harbor's run() write into
        # it as the agent, which is the image's own USER when the task names no
        # user (risk-scorer-replay runs as nobody). Harbor then sets no
        # default_user, so it cannot be chowned; it is opened like the sessions
        # folder instead.
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
                "chmod 0777 /tmp/codex-home /logs/agent/codex-sessions; "
                "actual=\"$(codex --version | sed -E 's/^codex-cli[[:space:]]+//')\"; "
                f"test \"$actual\" = {expected} || {{ echo \"Unexpected Codex version: $actual\" >&2; exit 1; }}"
            ),
        )
