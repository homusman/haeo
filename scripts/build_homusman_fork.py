"""Convert the upstream HAEO package to an independently installable fork.

Run on a checkout of homusman/haeo. Never install both with the same domain.
The script is idempotent and deliberately leaves upstream history intact.
"""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path("custom_components")
OLD = ROOT / "haeo"
NEW = ROOT / "haeo_homusman"

if OLD.exists() and NEW.exists():
    raise SystemExit("Refusing to convert: both original and fork packages exist")
if OLD.exists():
    OLD.rename(NEW)
if not NEW.exists():
    raise SystemExit("Integration source not found")

# All runtime code, schema, translations and shipped frontend assets need
# their own module namespace, API domain and card registration identifiers.
text_extensions = {".py", ".json", ".js", ".ts", ".tsx", ".html", ".css", ".yaml", ".yml"}
replacements = (
    ("custom_components/haeo", "custom_components/haeo_homusman"),
    ("custom_components.haeo", "custom_components.haeo_homusman"),
    ('"haeo"', '"haeo_homusman"'),
    ("'haeo'", "'haeo_homusman'"),
    ("/haeo-static", "/haeo-homusman-static"),
    ("haeo-forecast-card", "haeo-homusman-forecast-card"),
    ("haeo-topology-card", "haeo-homusman-topology-card"),
    ("haeo.zip", "haeo_homusman.zip"),
    ('"haeo/', '"haeo_homusman/'),
    ("'haeo/", "'haeo_homusman/"),
)
for directory in [NEW, Path("frontend"), Path("tests")]:
    if not directory.exists():
        continue
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in text_extensions:
            continue
        original = path.read_text(encoding="utf-8")
        modified = original
        for before, after in replacements:
            modified = modified.replace(before, after)
        if modified != original:
            path.write_text(modified, encoding="utf-8")
        if path.suffix == ".js" and "www" in path.parts:
            name = path.name.replace("haeo-", "haeo-homusman-")
            if name != path.name:
                path.rename(path.with_name(name))

manifest_path = NEW / "manifest.json"
manifest = json.loads(manifest_path.read_text())
manifest.update(
    domain="haeo_homusman",
    name="HAEO - Homusman fork",
    version="0.5.1",
    documentation="https://github.com/homusman/haeo",
    issue_tracker="https://github.com/homusman/haeo/issues",
    codeowners=["@homusman"],
)
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

hacs_path = Path("hacs.json")
hacs = json.loads(hacs_path.read_text())
hacs["name"] = "HAEO - Homusman fork"
hacs["filename"] = "haeo_homusman.zip"
hacs_path.write_text(json.dumps(hacs, indent=2) + "\n")

project_path = Path("pyproject.toml")
if project_path.exists():
    content = project_path.read_text()
    content = content.replace('version = "0.5.0"', 'version = "0.5.1"', 1)
    project_path.write_text(content)

# Must be different names so the two dashboard cards do not register the same
# browser custom elements. Give the fork its own card script filenames, too.
print(f"Converted {NEW}, manifest domain={manifest['domain']}, version={manifest['version']}")
