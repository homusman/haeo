"""Bounded hub-local history and authenticated, read-only plan retrieval."""

from asyncio import Lock
from datetime import UTC, datetime
from pathlib import Path
import json
import logging
from typing import TYPE_CHECKING

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from custom_components.haeo_homusman.const import DOMAIN
from custom_components.haeo_homusman.core.const import CONF_MEASURED_POWER, CONF_MEASURED_POWER_INVERTED

if TYPE_CHECKING:
    from .coordinator import CoordinatorData

_LOGGER = logging.getLogger(__name__)
MAX_BYTES = 8 * 1024 * 1024
MAX_PLAN_BYTES = 512 * 1024
PAGE_SIZE = 32


def input_forecasts(hass: HomeAssistant, entry_id: str) -> dict:
    """Capture the plotted input forecasts as they existed at the start of a solve."""
    result = {}
    entries = er.async_entries_for_config_entry(er.async_get(hass), entry_id)
    for entry in entries:
        if (state := hass.states.get(entry.entity_id)) is None:
            continue
        attrs = state.attributes
        if not attrs.get("config_mode") or not isinstance(forecast := attrs.get("forecast"), list | tuple):
            continue
        element, field = attrs.get("element_name"), attrs.get("field_path")
        if not isinstance(element, str) or not isinstance(field, str):
            continue
        points = []
        for point in forecast[:2000]:
            if not isinstance(point, dict):
                continue
            at, value = point.get("time"), point.get("value")
            if isinstance(at, str):
                at = dt_util.parse_datetime(at)
            if isinstance(at, datetime) and isinstance(value, int | float):
                points.append([at.timestamp(), value])
        if len(points) > 1:
            result.setdefault(element, {})[field] = points
    return result


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
        "inputs": getattr(plan, "input_forecasts", None) or {},
    }


class PlanHistory:
    """Keep immutable records separate from dispatch-facing data."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        key = f"{DOMAIN}.plans.{entry_id}"
        self.store = Store(hass, 1, key, private=True)
        self.path = Path(hass.config.path(".storage", key))
        self.hass = hass
        self.lock = Lock()
        self.accepted: list[dict] = []
        self.latest: dict | None = None
        self.loaded = False

    async def load(self) -> None:
        """Load persisted history once under the archive lock."""
        if not self.loaded:
            try:
                data = await self.store.async_load()
                self.accepted = data["accepted"] if data else []
            except (OSError, ValueError, KeyError):
                _LOGGER.exception("Could not load archived HAEO plans")
            self.loaded = True
    async def record(self, plan: "CoordinatorData", decision: dict, accepted: bool) -> None:
        """Keep the candidate in memory and archive gated acceptance transitions."""
        async with self.lock:
            await self.load()
            record = plan_record(plan, decision)
            size = self.record_size(record)
            self.latest = record if size else None
            cutoff = plan.boundaries[0] - (plan.boundaries[-1] - plan.boundaries[0])
            pruned = self.prune(cutoff)
            if decision["reason"] == "gate_disabled":
                if self.accepted and not self.accepted[-1].get("ended_at"):
                    self.accepted[-1]["ended_at"] = datetime.now(UTC).isoformat()
                    pruned = True
            elif accepted and self.latest is not None:
                accepted_at = datetime.now(UTC).isoformat()
                self.accepted.append({**record, "accepted_at": accepted_at, "size": size})
                self.prune(cutoff)
                pruned = True
            if pruned:
                await self.save()

    @staticmethod
    def record_size(record: dict) -> int:
        """Return the encoded size if the plan can safely be served."""
        try:
            size = len(json.dumps(record, separators=(",", ":"), allow_nan=False).encode())
        except ValueError:
            _LOGGER.warning("Omitting nonfinite plan from history")
            return 0
        if size > MAX_PLAN_BYTES:
            _LOGGER.warning("Omitting plan that exceeds the history size limit")
            return 0
        return size

    def prune(self, cutoff: float) -> bool:
        """Keep the predecessor only while its original horizon can overlap the window."""
        count = len(self.accepted)
        while self.accepted:
            oldest = self.accepted[0]
            end = oldest["boundaries"][-1]
            if closed := oldest.get("ended_at"):
                end = min(end, datetime.fromisoformat(closed).timestamp())
            if len(self.accepted) > 1:
                end = min(end, datetime.fromisoformat(self.accepted[1]["accepted_at"]).timestamp())
            if end > cutoff:
                break
            self.accepted.pop(0)
        size = sum(plan["size"] for plan in self.accepted)
        while len(self.accepted) > 256 or size > MAX_BYTES:
            size -= self.accepted.pop(0)["size"]
        return len(self.accepted) != count

    async def save(self) -> None:
        """Write the current archive."""
        try:
            await self.store.async_save({"accepted": self.accepted})
        except (OSError, ValueError):
            _LOGGER.exception("Could not save archived HAEO plan")


    def storage_bytes(self) -> int:
        """Return the actual size of the on-disk archive file."""
        try:
            return self.path.stat().st_size
        except FileNotFoundError:
            return 0

    async def diagnostics(self) -> dict[str, int]:
        """Return the number of saved plans and actual on-disk bytes."""
        return {"plans": len(self.accepted), "bytes": await self.hass.async_add_executor_job(self.storage_bytes)}


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/plans",
    vol.Required("entry_id"): str,
    vol.Optional("plan_id"): str,
    vol.Optional("before"): str,
    vol.Optional("purge"): bool,
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
    async with history.lock:
        await history.load()
        if msg.get("purge"):
            await history.store.async_remove()
            history.accepted.clear()
            connection.send_result(msg["id"], {"plans": [], "archive": await history.diagnostics()})
            return
        response = await plans_response(history, coordinator.plan_decision, msg)
    if response is None:
        connection.send_error(msg["id"], "not_found", "Plan unavailable")
    else:
        if not msg.get("plan_id"):
            response["current_plan"] = coordinator.accepted_metadata
            response["measurements"] = {
                subentry.title: {
                    "entity_id": entity_id,
                    "inverted": bool(subentry.data.get(CONF_MEASURED_POWER_INVERTED)),
                }
                for subentry in entry.subentries.values()
                if isinstance(entity_id := subentry.data.get(CONF_MEASURED_POWER), str)
            }
        connection.send_result(msg["id"], response)


async def plans_response(history: PlanHistory, decision: dict, msg: dict) -> dict | None:
    """Return a plan or a bounded page of archive metadata."""
    if plan_id := msg.get("plan_id"):
        record = history.latest if plan_id == "candidate" else next(
            (record for record in history.accepted if record["id"] == plan_id), None
        )
        return record
    records = [
        {
            "id": record["id"],
            "accepted_at": record["accepted_at"],
            "ended_at": record.get("ended_at"),
            "ends": record["boundaries"][-1],
            "decision": record["decision"],
        }
        for record in reversed(history.accepted)
        if not msg.get("before") or record["id"] < msg["before"]
    ][:PAGE_SIZE]
    return {"plans": records, "decision": decision, "archive": await history.diagnostics()}

