"""Sensors for smart bin data."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity

from . import DOMAIN, DEFAULT_BINS


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    data = hass.data[DOMAIN]["data"]
    bins = list(data.get("bins", {}).keys()) or DEFAULT_BINS
    entities = [SmartBinDataSensor(hass, bin_id) for bin_id in bins]
    hass.data[DOMAIN]["entities"].extend(entities)
    async_add_entities(entities, True)


class SmartBinDataSensor(SensorEntity):
    def __init__(self, hass, bin_id: str) -> None:
        self.hass = hass
        self._bin_id = bin_id
        self._attr_unique_id = f"{bin_id}_data"
        self._attr_name = f"{bin_id.replace('smartbin_ai_', 'Smart Bin ')} - Data"
        self._attr_icon = "mdi:package-variant"

    @property
    def state(self):
        return self._item_count()

    @property
    def extra_state_attributes(self):
        entry = self._entry()
        images = list(entry.get("images", []))
        inventory = entry.get("inventory", {"items": []})
        history = list(entry.get("history", []))
        analysis_status = entry.get("analysis_status")
        folder_id = self._bin_id.replace("smartbin_", "")
        latest_filename = images[-1] if images else None
        latest_url = (
            f"/local/bins/{folder_id}/{latest_filename}" if latest_filename else None
        )
        return {
            "images": images,
            "inventory": inventory,
            "history": history,
            "analysis_status": analysis_status,
            "image_count": len(images),
            "item_count": self._item_count(inventory),
            "latest_filename": latest_filename,
            "latest_url": latest_url,
        }

    def _entry(self) -> dict:
        data = self.hass.data[DOMAIN]["data"]
        bins = data.setdefault("bins", {})
        entry = bins.setdefault(self._bin_id, {})
        entry.setdefault("images", [])
        entry.setdefault("history", [])
        entry.setdefault("analysis_status", {"state": "idle", "message": "Ready."})
        inventory = entry.get("inventory")
        if not isinstance(inventory, dict) or "items" not in inventory:
            entry["inventory"] = {"items": []}
        return entry

    def _item_count(self, inventory=None) -> int:
        if inventory is None:
            inventory = self._entry().get("inventory", {"items": []})
        items = inventory.get("items", []) if isinstance(inventory, dict) else []
        return sum(int(item.get("quantity", 0)) for item in items if isinstance(item, dict))
