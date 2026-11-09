"""Bounded hub-local history and authenticated, read-only plan retrieval."""

from datetime import UTC
import json
import logging
from typing import TYPE_CHECKING

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from custom_components.haeo_homusman.const import DOMAIN

if TYPE_CHECKING:
    from .coordinator import CoordinatorData

_LOGGER = logging.getLogger(__name__)
MAX_BYTES = 8 * 1024 * 1024
MAX_PLAN_BYTES = 512 * 1024
PAGE_SIZE = 32


def plan_record(plan: "CoordinatorData", decision: dict[str, str | float | None]) -> dict:
    """Build a compact archive record using forecast-card units."""
    series = {}
    for name, devices in plan.outputs.items():
        for outputs in devices.values():
            for key, output in outputs.items():
                if not output.forecast:
                    continue
                points = [
                    [point["time"].timestamp(), float(point["value"]) * 100 if output.unit == "%" else point["value"]]
                    for point in output.forecast
                ]
                series.setdefault(name, {})[key] = points
    generated = plan.completed_at.astimezone(UTC).isoformat()
    return {
        "id": generated,
        "generated_at": generated,
        "boundaries": plan.boundaries,
        "decision": decision,
        "series": series,
    }


class PlanHistory:
    """Keep immutable records separate from dispatch-facing data."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self.store = Store(hass, 1, f"{DOMAIN}.plans.{entry_id}", private=True)
        self.accepted: list[dict] = []
        self.latest: dict | None = None
        self.loaded = False

    async def record(self, plan: "CoordinatorData", decision: dict, accepted: bool) -> None:
        """Keep the latest candidate and save accepted transitions."""
        if not self.loaded:
            try:
                data = await self.store.async_load()
                self.accepted = data["accepted"] if data else []
            except (OSError, ValueError, KeyError):
                _LOGGER.exception("Could not load archived HAEO plans")
            self.loaded = True
        record = plan_record(plan, decision)
        try:
            size = len(json.dumps(record, separators=(",", ":"), allow_nan=False))
        except ValueError:
            _LOGGER.warning("Omitting nonfinite plan from history")
            return
        if size > MAX_PLAN_BYTES:
            _LOGGER.warning("Omitting plan that exceeds the history size limit")
            return
        self.latest = record
        if not accepted:
            return
        self.accepted.append({**record, "accepted_at": record["id"], "size": size})
        cutoff = plan.boundaries[0] - (plan.boundaries[-1] - plan.boundaries[0])
        # Keep one predecessor to explain the segment active at the cutoff.
        while len(self.accepted) > 1 and self.accepted[1]["boundaries"][0] < cutoff:
            self.accepted.pop(0)
        while len(self.accepted) > 1 and (
            len(self.accepted) > 256 or sum(plan["size"] for plan in self.accepted) > MAX_BYTES
        ):
            self.accepted.pop(0)
        try:
            await self.store.async_save({"accepted": self.accepted})
        except (OSError, ValueError):
            _LOGGER.exception("Could not save archived HAEO plan")


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/plans",
    vol.Required("entry_id"): str,
    vol.Optional("plan_id"): str,
    vol.Optional("before"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def websocket_plans(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Return paginated summaries or one archived plan."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    runtime = getattr(entry, "runtime_data", None)
    coordinator = getattr(runtime, "coordinator", None)
    if entry is None or entry.domain != DOMAIN or coordinator is None:
        connection.send_error(msg["id"], "not_found", "HAEO Homusman hub unavailable")
        return
    history = coordinator.plan_history
    if plan_id := msg.get("plan_id"):
        record = history.latest if plan_id == "candidate" else next(
            (record for record in history.accepted if record["id"] == plan_id), None
        )
        if record is None:
            connection.send_error(msg["id"], "not_found", "Plan unavailable")
        else:
            connection.send_result(msg["id"], record)
        return
    records = [
        {key: record[key] for key in ("id", "accepted_at", "decision")}
        for record in reversed(history.accepted)
        if not msg.get("before") or record["id"] < msg["before"]
    ][:PAGE_SIZE]
    connection.send_result(msg["id"], {"plans": records, "decision": coordinator.plan_decision})

