"""Boot-time gVisor self-check, run by ``entrypoint.sh`` before uvicorn starts.

The same check ``/health`` uses (``utils.health.run_self_check``): a real
``--runtime=runsc`` box with the exec flags must report a gVisor kernel. Exit 0
on success, 1 otherwise — the entrypoint refuses to start the API on 1, so a
runner whose sandbox is not gVisor never serves a single request.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.logging import configure_logging, get_logger  # noqa: E402
from core.settings import settings  # noqa: E402
from utils.health import run_self_check  # noqa: E402


def main() -> int:
    """Run the check once and log the verdict."""
    configure_logging()
    logger = get_logger("sandbox_runner.selfcheck")
    verdict = asyncio.run(run_self_check(settings.sandbox))
    if verdict.ok:
        logger.info("sandbox_selfcheck_passed", "runsc box reported a gVisor kernel", runtime=settings.sandbox.runtime)
        return 0
    logger.error("sandbox_selfcheck_failed", "gVisor self-check failed", reason=verdict.reason)
    return 1


if __name__ == "__main__":
    sys.exit(main())
