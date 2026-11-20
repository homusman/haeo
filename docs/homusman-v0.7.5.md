# HAEO Homusman v0.7.5 — raw tariff comparison overlays

Grid elements now offer optional **Raw import price sensor** and **Raw export
price sensor** fields. Select the original Amber (or another HAEO-compatible)
forecast sensor before price filtering. Keep the actual Import/Export price inputs
pointed at the sensors the optimizer should use.

The fork forecast card displays raw prices as dotted lines in the corresponding
tariff colors, alongside the solid optimizer-input prices on the same price scale.
Tariff visibility controls also hide the matching raw overlay. Fixed price ranges
still apply, so increase the price range if a raw spike lies outside the plot.

Configure this through Settings → Devices & services → HAEO Homusman → Grid
element settings. Each direction is optional and can be removed to hide it.
No card YAML mapping is needed. After updating through HACS, restart Home
Assistant and refresh the dashboard to load the updated card assets.

These references are display-only. They do not become required optimizer inputs,
change costs, trigger solves, or affect acceptance or dispatch. Unavailable or
malformed reference forecasts are omitted. Supported units are $/kWh, AUD/kWh,
c/kWh and ¢/kWh; cent prices are normalized for display.

New candidate and accepted-plan records capture raw forecasts at generation time.
The lower comparison pane uses those saved references, not today's raw forecast.
Plans saved before this release have no raw overlay. A short note below the plots
identifies the dotted lines as raw forecasts before filtering.

Validation covers reference parsing, missing sensors, optional Grid configuration,
direction/color pairing, retained pin/domain settings and the existing backend
and card regression suites.
