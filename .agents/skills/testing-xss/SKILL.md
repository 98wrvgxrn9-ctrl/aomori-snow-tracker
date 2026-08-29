---
name: testing-xss-fixes
description: Test XSS vulnerability fixes in aomori-snow-tracker. Use when verifying escapeHtml() changes or auditing innerHTML injection points in docs/index.html.
---

# Testing XSS Fixes in Aomori Snow Tracker

## Overview

The frontend (`docs/index.html`) is a single-page app using Leaflet.js that renders JSON data via `innerHTML` in multiple places: detail panels, tooltips (`bindTooltip`), map labels (`L.divIcon`), and popups (`bindPopup`). All user-facing data must pass through `escapeHtml()` before innerHTML injection.

## Setup

1. Start a local HTTP server:
   ```bash
   cd /home/ubuntu/aomori-snow-tracker && python3 -m http.server 8080 --directory docs &
   ```

2. Back up data files before injecting payloads:
   ```bash
   cd docs/data
   cp koku.geojson koku.geojson.bak
   cp bus_status.json bus_status.json.bak
   cp snow_dump_sites.json snow_dump_sites.json.bak
   ```

3. Inject XSS payloads using Python (must use `ensure_ascii=False` to preserve Japanese characters):
   ```python
   import json
   payload = '<img src=x onerror="window._xss_fired=true">'
   # Modify the target field in each JSON file
   # Always use: json.dump(data, f, ensure_ascii=False, indent=2)
   ```

## Key Injection Points

| Data File | Field to Inject | Rendering Path |
|---|---|---|
| `koku.geojson` | First feature `properties['名前']` | Map label (divIcon), tooltip, detail panel |
| `bus_status.json` | `notes[0]` | Bus status section in right panel |
| `snow_dump_sites.json` | `sites[0].name` | Snow dump popup and tooltip |

## Verification Method

1. Open `http://localhost:8080/` in browser
2. Click "移動" card to load the map view
3. Check `window._xss_fired` in console — should be `undefined`
4. Check `document.querySelectorAll('img[src="x"]').length` — should be `0`
5. Interact with map elements (click areas, hover for tooltips, enable layer checkboxes)
6. Verify payloads display as literal escaped text (`&lt;img...&gt;`), not rendered HTML

## Leaflet-Specific Gotchas

- `bindTooltip(string)` renders HTML via innerHTML internally — even though the API takes a string, it's NOT safe without escaping
- `L.divIcon({ html: string })` also renders via innerHTML — labels on the map execute scripts if not escaped
- These are different rendering paths from the detail panel innerHTML — both must be tested separately
- Tooltip XSS fires on hover (not page load), while divIcon XSS fires on page load when map labels render

## Regression Testing

1. Restore original data files from `.bak` backups
2. Reload page and verify:
   - All 192 area labels render (check `document.querySelectorAll('.area-label').length`)
   - No double-escaped entities (`&amp;amp;`, `&amp;lt;`) in any label
   - Detail panel shows correct Japanese text for area names, dates, statuses
   - No JavaScript errors in console

## Common Issues

- **JSON corruption**: When injecting payloads with Python, always use `ensure_ascii=False` in `json.dump()` to preserve Japanese characters like '名前'
- **Clicking small markers**: Snow dump (❄) and other small markers may overlap with area polygons on the map, making it hard to click them directly. Use console DOM inspection as fallback verification
- **CDP timeout**: Complex JavaScript operations like `map.eachLayer()` may timeout via Chrome DevTools Protocol. Use simpler atomic queries instead

## Devin Secrets Needed

No secrets required — testing is done locally with static files.
