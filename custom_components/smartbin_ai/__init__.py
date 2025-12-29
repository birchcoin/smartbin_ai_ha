"""Strings for Smart Bin Upload integration."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN, DEFAULT_API_URL, DEFAULT_MODEL, DEFAULT_TEXT_MODEL
from . import main

_LOGGER = logging.getLogger(__name__)


async def _async_deploy_frontend_files(hass: HomeAssistant) -> None:
    """Copy frontend files to www directory for serving."""
    try:
        # Get paths
        integration_path = Path(__file__).parent
        frontend_source = integration_path / "frontend"
        www_target = Path(hass.config.path("www"))

        # Ensure www directory exists
        www_target.mkdir(parents=True, exist_ok=True)

        # List of frontend files to deploy
        frontend_files = [
            "smartbin_ai_dashboard_common.js",
            "smartbin_ai_dashboard.html",
            "smartbin_ai_remove_launcher.html",
            "smartbin_ai_upload_launcher.html",
            "smartbin_ai_nfc_test.html",
            "SmartBin_AI.svg",
        ]

        missing_files = []

        # Copy each file
        for filename in frontend_files:
            source_file = frontend_source / filename
            target_file = www_target / filename

            if source_file.exists():
                shutil.copy2(source_file, target_file)
                _LOGGER.debug(f"Deployed frontend file: {filename}")
            else:
                missing_files.append(filename)
                _LOGGER.warning(f"Frontend file not found: {filename}")

        if missing_files:
            _LOGGER.warning(
                "SmartBin AI frontend files missing from the integration package: %s. "
                "Reinstall/upgrade the integration to restore these files.",
                ", ".join(missing_files),
            )

        _LOGGER.info("SmartBin AI frontend files deployed to /config/www/")

    except Exception as e:
        _LOGGER.error(f"Failed to deploy frontend files: {e}", exc_info=True)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the SmartBin AI integration."""
    # Deploy frontend files to www directory
    await _async_deploy_frontend_files(hass)

    # Call the main setup which registers HTTP views and services
    return await main.async_setup(hass, config)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Smart Bin Upload from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry

    # Store config entry for access in services
    if "config_entry" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["config_entry"] = entry

    # Initialize data storage for bins and entities
    if "data" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["data"] = {"bins": {}}
    if "entities" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["entities"] = []

    # Register custom panel
    await _async_register_panel(hass)

    # Ensure input_text entities are created
    await _async_ensure_entities(hass)

    await hass.config_entries.async_forward_entry_setups(entry, ["sensor"])

    return True


async def _async_ensure_entities(hass: HomeAssistant) -> None:
    """Set default active bin in integration storage."""
    # Use internal storage instead of input_text entities for HACS compatibility
    if "active_bin" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["active_bin"] = "smartbin_001"
        _LOGGER.info("Set default active bin to smartbin_001")

    # Initialize bin names if not present
    data = hass.data[DOMAIN]["data"]
    bins_data = data.setdefault("bins", {})
    if not bins_data and not data.get("bins_initialized"):
        for i in range(1, 6):
            bin_id = f"smartbin_{i:03d}"
            bins_data[bin_id] = {"name": f"SmartBin {i:03d}"}
        data["bins_initialized"] = True
        store = hass.data[DOMAIN].get("store")
        if store:
            await store.async_save(hass.data[DOMAIN]["data"])
        _LOGGER.info("Seeded default SmartBin list (001-005).")


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register the frontend panel."""
    from homeassistant.components.frontend import async_register_built_in_panel
    
    async_register_built_in_panel(
        hass,
        component_name="iframe",
        sidebar_title="SmartBin AI",
        sidebar_icon="mdi:trash-can",
        frontend_url_path="smartbin_ai",
        require_admin=False,
        config={
            "mode": "storage",
            "title": "SmartBin AI Command Center",
            "url": "/local/smartbin_ai_dashboard.html",
        },
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_forward_entry_unload(entry, "sensor")

    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop("config_entry", None)

    return unload_ok
