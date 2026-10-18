"""Stop an agent's processes when Harbor's agent timeout cancels its run.

Harbor ends a run at the task's agent timeout by cancelling the agent's run(). With no output subscriber (`harbor run`
registers none) its docker exec is buffered, and a cancelled buffered exec ends neither the host-side
`docker compose exec` nor anything inside the container. So the agent kept running into the verifier's phase, in the
container the verifier grades. 2026-10-18: the Native runner made 5 tool calls in 82 s next to a Terminal-Bench 2.0
verifier, which never graded. In a forced-timeout check, an apt-get the agent had started still held apt's lock, so the
verifier's `apt-get update` failed and its tests never ran. A Codex lane is no different, except that its JSON event
stream fills the unread pipe sooner.

Both adapters therefore stop, on that cancellation, every process whose command line names the agent and every
process still under one. They are frozen first, so none can start another, and then killed, as at the end of a run.
The agent takes no action after the timeout, and the verifier finds the container as the agent left it at the timeout.
Processes the agent started earlier that are no longer under it (a server it put in the background) are left alone.
"""

import asyncio
from typing import Any


def stop_tree_script(marker: str) -> str:
    """Bash for the task container (Harbor runs every exec there through bash), using only /proc.

    Slim task images ship no ps or pkill. The marker is split in two so that this script's own command line, and its
    subshells', never contain it. The container's first process is never taken for the agent: every other process is
    under it.
    """
    half = len(marker) // 2
    pattern = f'"{marker[:half]}""{marker[half:]}"'
    return f"""me=$$; pattern={pattern}
declare -A parent=() tree=()
scan() {{
  parent=()
  local p pid stat
  for p in /proc/[0-9]*; do
    pid=${{p#/proc/}}; [ "$pid" = "$me" ] && continue
    read -r stat 2>/dev/null < "$p/stat" || continue
    stat=${{stat##*) }}; set -- $stat; parent[$pid]=$2
  done
}}
grow() {{
  local changed=1 pid
  while [ "$changed" = 1 ]; do
    changed=0
    for pid in "${{!parent[@]}}"; do
      if [ -z "${{tree[$pid]}}" ] && [ -n "${{tree[${{parent[$pid]}}]}}" ]; then tree[$pid]=1; changed=1; fi
    done
  done
}}
for p in /proc/[0-9]*; do
  pid=${{p#/proc/}}; [ "$pid" = "$me" ] || [ "$pid" = 1 ] && continue
  cmd="$(tr '\\000' ' ' 2>/dev/null < "$p/cmdline")" || continue
  case "$cmd" in *"$pattern"*) tree[$pid]=1;; esac
done
if [ "${{#tree[@]}}" -eq 0 ]; then echo "nothing was running"; exit 0; fi
scan; grow
for pid in "${{!tree[@]}}"; do kill -STOP "$pid" 2>/dev/null; done
scan; grow
stopped=""
for pid in "${{!tree[@]}}"; do
  name=""; read -r name 2>/dev/null < "/proc/$pid/comm"
  kill -KILL "$pid" 2>/dev/null && stopped="$stopped $pid(${{name:-?}})"
done
echo "stopped${{stopped:- nothing}}"
"""


async def stop_agent_tree(agent: Any, environment: Any, marker: str) -> None:
    """Run stop_tree_script as root, never raising: a failed stop is logged and the cancellation goes on."""
    try:
        result = await asyncio.wait_for(
            agent.exec_as_root(environment, command=stop_tree_script(marker)), timeout=60
        )
        stopped = " ".join(str(result.stdout or "").split()) or "no answer"
        agent.logger.info(f"Agent run cancelled at Harbor's agent timeout; {stopped}")
    except Exception as error:
        agent.logger.warning(
            f"Agent run cancelled at Harbor's agent timeout, but stopping the agent failed: {error}"
        )
