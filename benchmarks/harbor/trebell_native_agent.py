import json
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
    _REMOTE_INSTRUCTION = "/installed-agent/instruction.txt"
    _REMOTE_API_KEY = "/installed-agent/openai-api-key"
    _OUTPUT = "/logs/agent/trebell-native.txt"
    _METRICS = "/logs/agent/trebell-native-metrics.json"

    @staticmethod
    @override
    def name() -> str:
        return "trebell-native"

    @override
    def get_version_command(self) -> str | None:
        return f". ~/.nvm/nvm.sh >/dev/null 2>&1 || true; node {self._REMOTE_RUNNER} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(__file__).resolve().parent / "dist" / "trebell-native-agent.mjs"
        if not bundle.is_file():
            raise FileNotFoundError(
                f"Missing Trebell Native Harbor bundle: {bundle}. "
                "Run npm run bench:terminal:bundle first."
            )
        # The bundled Harbor runner only requires curl here so nvm can install
        # Node 22. Bash/coreutils are part of the supported task base images,
        # while repository discovery/search already falls back to bounded
        # filesystem indexing when Git is unavailable. Installing Git and
        # ripgrep eagerly made slim TB4 images pull a large dependency set
        # before the agent could even start.
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "node --version"
            ),
        )
        # Harbor already mounts /logs/agent for each trial. Recreating the
        # mount point is unnecessary and can fail on Docker Desktop/Windows.
        await self.exec_as_root(environment, command="mkdir -p /installed-agent")
        await self._upload_agent_owned_file(
            environment, bundle, self._REMOTE_RUNNER
        )

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
        await self.exec_as_agent(
            environment,
            command=(
                "set -o pipefail; "
                ". ~/.nvm/nvm.sh >/dev/null 2>&1 || true; "
                f'export OPENAI_API_KEY="$(cat {self._REMOTE_API_KEY})"; '
                f"rm -f {self._REMOTE_API_KEY}; "
                f"node {self._REMOTE_RUNNER} {self._REMOTE_INSTRUCTION} "
                f"2>&1 | tee {self._OUTPUT}"
            ),
            env=env,
            cwd="/app",
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Expose Trebell's provider-reported usage through Harbor's standard result."""
        metrics_path = self.logs_dir / "trebell-native-metrics.json"
        if not metrics_path.is_file():
            return
        try:
            metrics = json.loads(metrics_path.read_text())
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
                "reasoning_output_tokens": int(
                    usage.get("reasoningOutputTokens") or 0
                ),
                "cache_write_input_tokens": int(
                    usage.get("cacheWriteInputTokens") or 0
                ),
            },
        }
