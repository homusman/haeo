"""Display-only references are bounded, normalized and optional."""
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

package = ModuleType("custom_components.haeo_homusman")
package.__path__ = [str(Path(__file__).parents[1] / "custom_components/haeo_homusman")]
sys.modules.setdefault(package.__name__, package)

FILE = Path(__file__).parents[1] / "custom_components/haeo_homusman/coordinator/price_references.py"
spec = importlib.util.spec_from_file_location("price_references_test", FILE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def attributes(unit="$/kWh"):
    return {"unit_of_measurement": unit, "forecast": [
        {"time": "2026-11-21T10:00:00+11:00", "value": 20},
        {"time": "2026-11-21T11:00:00+11:00", "value": 100},
    ]}


def test_normalize_cent_units_and_terminal_boundary():
    points = module.price_reference_points(attributes("c/kWh"))
    assert [point[1] for point in points] == [0.2, 1, 1]
    assert points[-1][0] - points[-2][0] == 3600


def test_invalid_references_are_omitted():
    assert module.price_reference_points(attributes("kW")) == []
    attrs = attributes()
    attrs["forecast"][0]["value"] = float("nan")
    assert module.price_reference_points(attrs) == []
    attrs = attributes()
    attrs["forecast"][1]["time"] = attrs["forecast"][0]["time"]
    assert module.price_reference_points(attrs) == []
    attrs["forecast"] *= 2049
    assert module.price_reference_points(attrs) == []


def test_collect_missing_sensor_does_not_block_valid_reference_or_mutate_config():
    config = {"raw_import_price": "sensor.raw", "raw_export_price": "sensor.missing"}
    entry = SimpleNamespace(subentries={"grid": SimpleNamespace(title="Grid", data=config)})
    state = SimpleNamespace(state="0.2", attributes=attributes())
    hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity: state if entity == "sensor.raw" else None))
    result = module.reference_price_forecasts(hass, entry)
    assert list(result["Grid"]) == ["display.raw_import_price"]
    assert config == {"raw_import_price": "sensor.raw", "raw_export_price": "sensor.missing"}
    state.state = "unavailable"
    assert module.reference_price_forecasts(hass, entry) == {}
