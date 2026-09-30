import hashlib
import json
import os
import shlex
from pathlib import Path
from typing import Literal, override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage


class TrebellNativeOptions(InstalledAgentOptions):
    reasoning_effort: Literal[
        "none", "minimal", "low", "medium", "high", "xhigh", "max"
    ] = Field(default="max", description="OpenAI reasoning effort.")
    live_probe: bool = Field(
        default=False,
        description="Diagnostic only: stop after the first provider response and log its latency/usage.",
    )
    live_probe_turns: int = Field(
        default=1,
        ge=1,
        le=8,
        description="Number of provider responses to allow during a diagnostic live probe.",
    )


class TrebellNativeAgent(BaseInstalledAgent):
    """Harbor adapter that runs the real Trebell Native agent inside the task container."""

    capabilities = AgentCapabilities()
    MODEL_CONNECTION = ModelConnectionSpec(default_provider="openai")
    options_model = TrebellNativeOptions
    options: TrebellNativeOptions

    _REMOTE_RUNNER = "/installed-agent/trebell-native-agent.mjs"
    _REMOTE_RUNTIME = "/installed-agent/runtime"
    _REMOTE_INSTRUCTION = "/installed-agent/instruction.txt"
    _REMOTE_API_KEY = "/installed-agent/openai-api-key"
    _OUTPUT = "/logs/agent/trebell-native.txt"
    _METRICS = "/logs/agent/trebell-native-metrics.json"
    _PINNED_NODE_VERSION = "22.23.3"
    _PINNED_NODE_TARBALL_SHA256 = (
        "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af"
    )
    _REMOTE_NODE_ARCHIVE = "/tmp/trebell-node-linux-x64.tar.gz"
    _REMOTE_NODE_ROOT = "/opt/trebell-node"

    @staticmethod
    @override
    def name() -> str:
        return "trebell-native"

    @override
    def get_version_command(self) -> str | None:
        return (
            f'runtime="$(cat {self._REMOTE_RUNTIME} 2>/dev/null || true)"; '
            f'if [ "$runtime" = "bun" ]; then bun {self._REMOTE_RUNNER} --version; '
            f"else . ~/.nvm/nvm.sh >/dev/null 2>&1 || true; "
            f"node {self._REMOTE_RUNNER} --version; fi"
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(__file__).resolve().parent / "dist" / "trebell-native-agent.mjs"
        if not bundle.is_file():
            raise FileNotFoundError(
                f"Missing Trebell Native Harbor bundle: {bundle}. "
                "Run npm run bench:terminal:bundle first."
            )
        # Harbor already mounts /logs/agent for each trial. Recreating the
        # mount point is unnecessary and can fail on Docker Desktop/Windows.
        await self.exec_as_root(environment, command="mkdir -p /installed-agent")
        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self.exec_as_root(
                environment, command=f"chown {owner} /installed-agent"
            )
        await self._upload_agent_owned_file(
            environment, bundle, self._REMOTE_RUNNER
        )
        async def write_runtime_marker(runtime: str) -> None:
            if runtime not in {"bun", "node"}:
                raise ValueError(f"Unsupported Trebell Native runtime marker: {runtime!r}")
            marker = shlex.quote(self._REMOTE_RUNTIME)
            value = shlex.quote(runtime)
            await self.exec_as_root(
                environment,
                command=f"printf '%s\\n' {value} > {marker}; chmod 0644 {marker}",
            )

        # Avoid heavyweight runtime installation when the task image already
        # ships a compatible JavaScript runtime. Bun-based TB4 images are a
        # common example; the bundled Native runner is validated directly
        # before selection so incompatible runtimes fall through safely.
        runtime = None
        try:
            runtime_result = await self.exec_as_agent(
                environment,
                command=(
                    "set -euo pipefail; "
                    f"if command -v bun >/dev/null 2>&1 && "
                    f"bun {self._REMOTE_RUNNER} --version >/dev/null 2>&1; then "
                    "printf '%s\\n' bun; "
                    f"elif command -v node >/dev/null 2>&1 && "
                    f"node {self._REMOTE_RUNNER} --version >/dev/null 2>&1; then "
                    "printf '%s\\n' node; "
                    "else exit 42; fi"
                ),
            )
            runtime = str(runtime_result.stdout or "").strip()
        except Exception:
            pass
        if runtime in {"bun", "node"}:
            await write_runtime_marker(runtime)
            return
        self.logger.info(
            "No compatible preinstalled Bun/Node runtime; installing Node 22 fallback."
        )

        pinned_node_value = os.environ.get("TREBELL_NODE_PINNED_TARBALL", "").strip()
        if pinned_node_value:
            pinned_node = Path(pinned_node_value).expanduser().resolve()
            if not pinned_node.is_file():
                raise FileNotFoundError(f"Pinned Node tarball not found: {pinned_node}")
            digest = hashlib.sha256()
            with pinned_node.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            actual_sha256 = digest.hexdigest()
            if actual_sha256 != self._PINNED_NODE_TARBALL_SHA256:
                raise ValueError(
                    "Pinned Node tarball SHA-256 mismatch: "
                    f"expected {self._PINNED_NODE_TARBALL_SHA256}, got {actual_sha256}"
                )
            await environment.upload_file(pinned_node, self._REMOTE_NODE_ARCHIVE)
            archive = shlex.quote(self._REMOTE_NODE_ARCHIVE)
            root = shlex.quote(self._REMOTE_NODE_ROOT)
            expected = shlex.quote(f"v{self._PINNED_NODE_VERSION}")
            await self.exec_as_root(
                environment,
                command=(
                    "set -euo pipefail; "
                    f"rm -rf {root}; mkdir -p {root}; "
                    f"tar -xzf {archive} -C {root} --strip-components=1; "
                    f"ln -sf {root}/bin/node /usr/local/bin/node; "
                    f"ln -sf {root}/bin/npm /usr/local/bin/npm; "
                    f"ln -sf {root}/bin/npx /usr/local/bin/npx; "
                    f"if [ -e {root}/bin/corepack ]; then "
                    f"ln -sf {root}/bin/corepack /usr/local/bin/corepack; fi; "
                    f"rm -f {archive}; "
                    'actual="$(node --version)"; '
                    f'test "$actual" = {expected} || {{ echo "Unexpected Node version: $actual" >&2; exit 1; }}'
                ),
            )
            await self.exec_as_agent(
                environment,
                command=f"node {self._REMOTE_RUNNER} --version >/dev/null 2>&1",
            )
            await write_runtime_marker("node")
            return

        # Fallback only: curl is needed for nvm. Avoid Harbor's package-manager
        # path when the task image already ships curl; apt metadata refreshes
        # are unrelated benchmark setup and can be much slower or flakier than
        # the agent work itself.
        try:
            await self.exec_as_agent(
                environment, command="command -v curl >/dev/null 2>&1"
            )
        except Exception:
            await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "node --version"
            ),
        )
        await write_runtime_marker("node")

    @with_prompt_template
    @override
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        if not self.model_name:
            raise ValueError("Trebell Native requires --model openai/<model>.")
        model = self.model_name.split("/")[-1]
        access = self.model_connection
        if not access.api_key:
            raise ValueError("OPENAI_API_KEY is required for Trebell Native.")

        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=self._REMOTE_INSTRUCTION,
            filename="instruction.txt",
        )
        # Harbor's Docker exec backend expands per-exec env values into
        # `docker compose exec -e KEY=value`, which makes secrets visible in
        # the host process command line. Stage the API key as a mode-600 file
        # instead, read it inside the container, and delete it before Node starts.
        await self._upload_config_text(
            environment,
            content=access.api_key,
            remote_path=self._REMOTE_API_KEY,
            filename="openai-api-key",
        )
        env = {
            "TREBELL_MODEL": model,
            "TREBELL_REASONING_EFFORT": self.options.reasoning_effort,
            "TREBELL_HOME": "/tmp/trebell-home",
            "TREBELL_METRICS_PATH": self._METRICS,
            **(
                {
                    "TREBELL_HARBOR_LIVE_PROBE": "1",
                    "TREBELL_HARBOR_LIVE_PROBE_TURNS": str(self.options.live_probe_turns),
                }
                if self.options.live_probe
                else {}
            ),
        }
        reasoning_context = os.environ.get("TREBELL_OPENAI_REASONING_CONTEXT", "").strip()
        if reasoning_context:
            env["TREBELL_OPENAI_REASONING_CONTEXT"] = reasoning_context
        await self.exec_as_agent(
            environment,
            command=(
                "set -o pipefail; "
                f'runtime="$(cat {self._REMOTE_RUNTIME} 2>/dev/null || true)"; '
                '. ~/.nvm/nvm.sh >/dev/null 2>&1 || true; '
                f'export OPENAI_API_KEY="$(cat {self._REMOTE_API_KEY})"; '
                f"rm -f {self._REMOTE_API_KEY}; "
                f'if [ "$runtime" = "bun" ]; then runtime_cmd=bun; '
                'else runtime_cmd=node; fi; '
                f"$runtime_cmd {self._REMOTE_RUNNER} {self._REMOTE_INSTRUCTION} "
                f"2>&1 | tee {self._OUTPUT}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Expose Trebell's provider-reported usage through Harbor's standard result."""
        metrics_path = self.logs_dir / "trebell-native-metrics.json"
        if not metrics_path.is_file():
            return
        try:
            metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            usage = metrics.get("usage") or {}
            input_tokens = int(usage.get("inputTokens") or 0)
            cached_tokens = int(usage.get("cachedInputTokens") or 0)
            output_tokens = int(usage.get("outputTokens") or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self.logger.exception("Failed to read Trebell Native usage metrics")
            return
        context.n_input_tokens = input_tokens
        context.n_cache_tokens = cached_tokens
        context.n_output_tokens = output_tokens
        context.model_usage = {
            self.model_name or "openai/unknown": ModelUsage(
                n_input_tokens=input_tokens,
                n_cache_tokens=cached_tokens,
                n_output_tokens=output_tokens,
                cost_usd=None,
            )
        }
        context.metadata = {
            **(context.metadata or {}),
            "trebell_native": {
                "model_turns": int(metrics.get("modelTurns") or 0),
                "tool_calls": int(metrics.get("toolCalls") or 0),
                "provider_requests": int(metrics.get("providerRequests") or 0),
                "reasoning_effort": metrics.get("reasoningEffort"),
                "reasoning_context": metrics.get("reasoningContext"),
                "effective_reasoning_contexts": metrics.get("effectiveReasoningContexts") or [],
                "reasoning_output_tokens": int(
                    usage.get("reasoningOutputTokens") or 0
                ),
                "cache_write_input_tokens": int(
                    usage.get("cacheWriteInputTokens") or 0
                ),
                "cache_carryover": metrics.get("cacheCarryover") or {},
                "strategy": metrics.get("strategy") or {},
                "budgets": metrics.get("budgets") or {},
            },
        }
