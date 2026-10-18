"""Give a task image that has no system CA bundle the Mozilla one, the same way in both adapters.

Native's runner brings its own Node, whose bundled roots make its API calls work in any image. The pinned Codex binary
reads the system store. So in an image without one, Codex could not reach the API at all: every connection failed with
"invalid peer certificate: UnknownIssuer". That happened in 4 of readout 4's 20 Terminal-Bench 2.0 images, regex-log
among them, on 2026-10-18. Harbor's stock installs get a store as a side effect of installing curl with the package
manager, and the pinned installs skip that step.

So, when the image has none, both adapters write certifi's Mozilla bundle (from Harbor's own Python) to
/etc/ssl/certs/ca-certificates.crt, where OpenSSL, curl and rustls look, before the agent starts. Images that have a
store are left alone. Both lanes see the same container.
"""

import hashlib
from pathlib import Path
from typing import Any

import certifi

BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt"
_UPLOAD_PATH = "/tmp/trebell-ca-bundle.pem"
_PROBE = (
    "for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do "
    '[ -s "$f" ] && { echo present; exit 0; }; done; echo missing'
)


async def ensure_ca_bundle(agent: Any, environment: Any) -> None:
    result = await agent.exec_as_root(environment, command=_PROBE)
    if "missing" not in str(result.stdout or ""):
        return
    source = Path(certifi.where())
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    await environment.upload_file(source, _UPLOAD_PATH)
    await agent.exec_as_root(
        environment,
        command=(
            f"set -euo pipefail; mkdir -p /etc/ssl/certs; mv {_UPLOAD_PATH} {BUNDLE_PATH}; chmod 0644 {BUNDLE_PATH}"
        ),
    )
    agent.logger.info(
        f"The image has no CA bundle; wrote certifi {certifi.__version__}'s ({digest[:12]}) to {BUNDLE_PATH}"
    )
