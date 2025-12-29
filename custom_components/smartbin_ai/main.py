"""Smart bin image upload endpoint for Home Assistant."""

from __future__ import annotations

import base64
from datetime import datetime
import secrets
import time
import json
import os
from pathlib import Path
from functools import partial
import logging

import aiohttp
from aiohttp import web
import voluptuous as vol

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.const import EVENT_HOMEASSISTANT_START

from .const import DEFAULT_API_URL, DEFAULT_MODEL, DEFAULT_TEXT_MODEL, DOMAIN

LOGGER = logging.getLogger(__name__)
STORAGE_VERSION = 1
STORAGE_KEY = DOMAIN
ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
CONDITION_RANK = {"good": 0, "fair": 1, "needs replacement": 2}
UPLOAD_TOKEN_TTL = 300

# Normalize JPEG orientation based on EXIF so AI bboxes match browser display.
def _normalize_image_orientation(image_bytes: bytes) -> bytes:
    try:
        from PIL import Image, ImageOps
        import io
        with Image.open(io.BytesIO(image_bytes)) as img:
            if not img.format or img.format.upper() not in ("JPEG", "JPG", "PNG"):
                return image_bytes
            exif = img.getexif()
            orientation = exif.get(274)
            if not orientation or orientation == 1:
                return image_bytes
            normalized = ImageOps.exif_transpose(img)
            buffer = io.BytesIO()
            normalized.save(buffer, format="JPEG", quality=95, optimize=True)
            return buffer.getvalue()
    except Exception:
        return image_bytes


def _get_api_config(hass: HomeAssistant) -> tuple[str, str, str]:
    """Get API configuration from config entry."""
    config_entry = hass.data.get(DOMAIN, {}).get("config_entry")
    if config_entry:
        api_key = config_entry.data.get("api_key", "")
        api_url = config_entry.data.get("api_url", DEFAULT_API_URL)
        model = config_entry.data.get("model", DEFAULT_MODEL)
        return api_key, api_url, model
    return "", DEFAULT_API_URL, DEFAULT_MODEL


def _get_text_model(hass: HomeAssistant) -> str:
    """Get text model from config entry."""
    config_entry = hass.data.get(DOMAIN, {}).get("config_entry")
    if config_entry:
        return config_entry.data.get("text_model", DEFAULT_TEXT_MODEL)
    return DEFAULT_TEXT_MODEL


def _z4_make_prompt(high_recall: bool = True, small_only: bool = False, exclude: str | None = None) -> str:
    base = """
Identify ALL distinct objects visible in the image (high recall). For EACH object category, provide:
- name: common noun label, lowercase, singular (e.g., "person", "chair", "bottle")
- description: a short visual description (e.g., color/material/shape/context). Must be a NON-empty string; if unsure use "unknown".
- quantity: integer count of visible instances
- coordinates: bounding boxes in pixel coords [x_min, y_min, x_max, y_max], one box per instance
- condition: observable state (e.g., "new", "used", "damaged", "partially occluded", "unknown").
  IMPORTANT: condition MUST be a NON-empty string; if unsure set exactly "unknown" (never empty/null).

Perform a multi-pass visual analysis:
Pass 1: Identify large, central, and foreground objects.
Pass 2: Scan the entire image edge-to-edge for small, background, low-contrast, or partially occluded objects.
Pass 3: Re-check reflective, transparent, and repetitive regions (e.g., shelves, tables, walls, floors).
Pass 4: Verify no detected object category is missing instances.

Self-verification gate BEFORE returning:
- Confirm no small/background object with clear edges was omitted.
- Confirm repeated objects were not undercounted.
- If anything is found, update the object list before returning.

Rules:
- Do not invent details. If uncertain, use "unknown".
- If you cannot provide a box for an instance, omit that instance from coordinates and reduce quantity accordingly.
- Output MUST be valid JSON and MUST follow the exact schema below.
- No markdown. No extra text. No comments. No trailing commas.

Return ONLY this JSON shape:
{
  "image_analysis": {
    "objects": [
      {
        "name": "string",
        "description": "string",
        "quantity": 0,
        "coordinates": [[0,0,0,0]],
        "condition": "string"
      }
    ]
  }
}
""".strip()

    if exclude:
        base += f'\n\nExclude these items: {exclude}.'

    if high_recall:
        base += (
            "\n\nFavor recall over precision. It is acceptable to include uncertain objects "
            'with description "unknown" and condition "unknown" rather than omitting them.'
        )

    if small_only:
        base += (
            "\n\nSecond pass mode: Focus ONLY on small/background/edge/corner objects that might have been missed. "
            "Do not repeat obvious large foreground objects unless you are adding missing instances/boxes. "
            "Return the same JSON schema."
        )

    return base




def _coerce_quick_items(payload: dict | list, original_width: int = 3024, original_height: int = 4032) -> list:
    if isinstance(payload, list):
        payload = {"items": payload}
    if not isinstance(payload, dict):
        return []

    if "image_analysis" in payload and isinstance(payload.get("image_analysis"), dict):
        sanitized = _z4_sanitize_output(payload)
        try:
            _z4_validate_schema(sanitized)
        except Exception:
            pass
        objects = sanitized.get("image_analysis", {}).get("objects", [])
        return _z4_objects_to_items(objects)

    items = payload.get("items") if isinstance(payload.get("items"), list) else None
    objects = payload.get("objects") if isinstance(payload.get("objects"), list) else None
    source = items or objects or []
    normalized = []
    for obj in source:
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        if not isinstance(name, str) or not name.strip():
            continue

        # Handle quantity - convert to int safely
        qty = obj.get("quantity", 1)
        try:
            quantity = int(qty) if qty else 1
        except (TypeError, ValueError):
            quantity = 1  # Default to 1 if quantity is invalid (e.g., "multiple")

        item = {
            "name": name.strip(),
            "description": obj.get("description", ""),
            "quantity": quantity,
            "condition": obj.get("condition", "unknown"),
        }
        coords = obj.get("coordinates") or obj.get("bbox")
        bboxes = []
        if isinstance(coords, list):
            # Handle single coordinate box [x1,y1,x2,y2]
            if len(coords) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in coords):
                coords = [coords]
            # Process each bounding box
            for box in coords:
                if isinstance(box, list) and len(box) == 4:
                    try:
                        x1, y1, x2, y2 = box
                        # Ensure all values are numeric
                        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in [x1, y1, x2, y2]):
                            # Convert from 0-1000 normalized space to actual pixels
                            x1 = (x1 / 1000.0) * original_width
                            y1 = (y1 / 1000.0) * original_height
                            x2 = (x2 / 1000.0) * original_width
                            y2 = (y2 / 1000.0) * original_height
                            bboxes.append(
                                [
                                    int(min(x1, x2)),
                                    int(min(y1, y2)),
                                    int(abs(x2 - x1)),
                                    int(abs(y2 - y1)),
                                ]
                            )
                    except (TypeError, ValueError):
                        # Skip invalid boxes
                        continue
        if bboxes:
            item["bboxes"] = bboxes
            item["bbox"] = bboxes[0]
        normalized.append(item)
    return normalized


def _z4_sanitize_output(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {"image_analysis": {"objects": []}}

    ia = payload.get("image_analysis")
    if not isinstance(ia, dict):
        ia = {}

    objs = ia.get("objects")
    if not isinstance(objs, list):
        objs = []

    cleaned = []
    for obj in objs:
        if not isinstance(obj, dict):
            continue

        name = obj.get("name")
        name = name.strip().lower() if isinstance(name, str) else "unknown"
        if not name:
            name = "unknown"

        desc = obj.get("description")
        desc = desc.strip() if isinstance(desc, str) else ""
        if not desc:
            desc = "unknown"

        cond = obj.get("condition")
        cond = cond.strip().lower() if isinstance(cond, str) else ""
        if not cond:
            cond = "unknown"

        coords_in = obj.get("coordinates")
        coords_out = []
        if isinstance(coords_in, list):
            for box in coords_in:
                if (
                    isinstance(box, list)
                    and len(box) == 4
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box)
                ):
                    coords_out.append([float(v) for v in box])

        qty = obj.get("quantity")
        if isinstance(qty, bool):
            qty = None
        if isinstance(qty, int) and qty >= 0:
            quantity = qty
        else:
            quantity = len(coords_out)
        if coords_out:
            quantity = len(coords_out)

        cleaned.append(
            {
                "name": name,
                "description": desc,
                "quantity": int(quantity),
                "coordinates": coords_out,
                "condition": cond,
            }
        )

    return {"image_analysis": {"objects": cleaned}}


def _z4_validate_schema(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise ValueError("Top-level JSON must be an object")

    ia = payload.get("image_analysis")
    if not isinstance(ia, dict):
        raise ValueError('Missing or invalid "image_analysis" object')

    objs = ia.get("objects")
    if not isinstance(objs, list):
        raise ValueError('Missing or invalid "image_analysis.objects" array')

    for i, obj in enumerate(objs):
        if not isinstance(obj, dict):
            raise ValueError(f"objects[{i}] must be an object")
        name = obj.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f'objects[{i}].name must be a non-empty string')
        desc = obj.get("description")
        if not isinstance(desc, str) or not desc.strip():
            raise ValueError(f'objects[{i}].description must be a non-empty string')
        qty = obj.get("quantity")
        if not isinstance(qty, int) or qty < 0:
            raise ValueError(f"objects[{i}].quantity must be a non-negative integer")
        coords = obj.get("coordinates")
        if not isinstance(coords, list):
            raise ValueError(f"objects[{i}].coordinates must be an array")
        for j, box in enumerate(coords):
            if (
                not isinstance(box, list)
                or len(box) != 4
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box)
            ):
                raise ValueError(
                    f"objects[{i}].coordinates[{j}] must be [x_min,y_min,x_max,y_max] numbers"
                )
        cond = obj.get("condition")
        if not isinstance(cond, str) or not cond.strip():
            raise ValueError(f'objects[{i}].condition must be a non-empty string')


def _z4_merge_results(a: dict, b: dict) -> dict:
    out = {"image_analysis": {"objects": []}}
    index = {}

    def better_text(current: str, new: str) -> str:
        cur = (current or "").strip()
        nxt = (new or "").strip()
        if cur.lower() == "unknown" and nxt and nxt.lower() != "unknown":
            return nxt
        if nxt.lower() != "unknown" and len(nxt) > len(cur) and cur.lower() != "unknown":
            return nxt
        return cur if cur else (nxt if nxt else "unknown")

    def add(obj: dict) -> None:
        name = obj["name"].strip().lower() if isinstance(obj.get("name"), str) else "unknown"
        if not name:
            name = "unknown"

        coords = obj.get("coordinates", [])
        desc = obj.get("description", "unknown")
        cond = obj.get("condition", "unknown")

        if name not in index:
            index[name] = {
                "name": name,
                "description": desc if isinstance(desc, str) and desc.strip() else "unknown",
                "quantity": 0,
                "coordinates": [],
                "condition": cond if isinstance(cond, str) and cond.strip() else "unknown",
            }

        entry = index[name]

        if isinstance(coords, list):
            entry["coordinates"].extend(coords)

        if isinstance(desc, str):
            entry["description"] = better_text(entry.get("description", "unknown"), desc)
        if isinstance(cond, str):
            entry["condition"] = better_text(entry.get("condition", "unknown"), cond).lower()

        if entry["coordinates"]:
            entry["quantity"] = len(entry["coordinates"])
        else:
            q = obj.get("quantity", 0)
            if isinstance(q, int) and q >= 0:
                entry["quantity"] = max(entry["quantity"], q)

    for obj in a.get("image_analysis", {}).get("objects", []):
        add(obj)
    for obj in b.get("image_analysis", {}).get("objects", []):
        add(obj)

    out["image_analysis"]["objects"] = list(index.values())
    out["image_analysis"]["objects"].sort(key=lambda x: x["name"])
    return out


def _z4_objects_to_items(objects: list) -> list:
    items = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        item = {
            "name": name.strip(),
            "description": obj.get("description", ""),
            "quantity": int(obj.get("quantity", 1) or 1),
            "condition": obj.get("condition", "unknown"),
        }
        coords = obj.get("coordinates", [])
        bboxes = []
        if isinstance(coords, list):
            for box in coords:
                if isinstance(box, list) and len(box) == 4:
                    x1, y1, x2, y2 = box
                    bboxes.append(
                        [
                            int(min(x1, x2)),
                            int(min(y1, y2)),
                            int(abs(x2 - x1)),
                            int(abs(y2 - y1)),
                        ]
                    )
        if bboxes:
            item["bboxes"] = bboxes
            item["bbox"] = bboxes[0]
        items.append(item)
    return items

# Service schema
SERVICE_ANALYZE_IMAGE_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Optional("image_path"): cv.string,
    vol.Optional("bin_name"): cv.string,
    vol.Optional("existing_items"): [cv.string],
})
SERVICE_ANALYZE_AND_REMOVE_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Optional("image_path"): cv.string,
    vol.Optional("bin_name"): cv.string,
    vol.Optional("existing_items"): [cv.string],
})
SERVICE_APPEND_IMAGE_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Required("filename"): cv.string,
})
SERVICE_REMOVE_ITEM_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Optional("item_name"): cv.string,
})
SERVICE_REMOVE_IMAGE_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Required("filename"): cv.string,
})
SERVICE_UPDATE_ITEM_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Required("item_name"): cv.string,
    vol.Optional("new_name"): cv.string,
    vol.Optional("description"): cv.string,
    vol.Optional("quantity"): vol.Coerce(int),
    vol.Optional("condition"): cv.string,
})
SERVICE_ADD_ITEM_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
    vol.Required("item_name"): cv.string,
    vol.Optional("description", default=""): cv.string,
    vol.Optional("quantity", default=1): vol.Coerce(int),
    vol.Optional("condition", default="good"): cv.string,
})
SERVICE_CLEAR_INVENTORY_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
})
SERVICE_CLEAR_IMAGES_SCHEMA = vol.Schema({
    vol.Required("bin_id"): cv.string,
})
SERVICE_SEARCH_ITEMS_SCHEMA = vol.Schema({
    vol.Required("query"): cv.string,
})



def _get_bin_entry(hass: HomeAssistant, bin_id: str) -> dict:
    data = hass.data[DOMAIN]["data"]
    bins = data.setdefault("bins", {})
    entry = bins.setdefault(bin_id, {})
    entry.setdefault("images", [])
    entry.setdefault("history", [])
    entry.setdefault(
        "analysis_status",
        {"state": "idle", "message": "Ready.", "updated": datetime.now().isoformat()},
    )
    inventory = entry.get("inventory")
    if not isinstance(inventory, dict) or "items" not in inventory:
        entry["inventory"] = {"items": []}
    return entry


def _set_analysis_status(entry: dict, state: str, message: str) -> None:
    entry["analysis_status"] = {
        "state": state,
        "message": message,
        "updated": datetime.now().isoformat(),
    }


def _merge_inventory_update(existing: dict, incoming: dict) -> dict:
    existing_items = existing.get("items", []) if isinstance(existing, dict) else []
    incoming_items = incoming.get("items", []) if isinstance(incoming, dict) else []
    merged = []
    index = {}

    for item in existing_items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        normalized = {
            "name": name,
            "quantity": int(item.get("quantity", 0) or 0),
            "condition": item.get("condition", "good"),
        }
        if "description" in item:
            normalized["description"] = item["description"]
        if "bbox" in item:
            normalized["bbox"] = item["bbox"]
        if "bboxes" in item:
            normalized["bboxes"] = item["bboxes"]
        if "image_filename" in item:
            normalized["image_filename"] = item["image_filename"]
        index[key] = len(merged)
        merged.append(normalized)

    for item in incoming_items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        try:
            quantity = int(item.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            quantity = 1
        condition = item.get("condition", "good")
        description = item.get("description")
        bbox = item.get("bbox")
        bboxes = item.get("bboxes")
        image_filename = item.get("image_filename")
        if key in index:
            existing_item = merged[index[key]]
            existing_item["quantity"] = quantity
            existing_item["condition"] = condition or existing_item.get("condition")
            if description:
                existing_item["description"] = description
            if bbox:
                existing_item["bbox"] = bbox
            if bboxes:
                existing_item["bboxes"] = bboxes
            if image_filename:
                existing_item["image_filename"] = image_filename
        else:
            new_item = {"name": name, "quantity": quantity, "condition": condition}
            if description:
                new_item["description"] = description
            if bbox:
                new_item["bbox"] = bbox
            if bboxes:
                new_item["bboxes"] = bboxes
            if image_filename:
                new_item["image_filename"] = image_filename
            merged.append(new_item)
            index[key] = len(merged) - 1

    return {"items": merged}


def _log_history(entry: dict, action: str, items: list, image_filename: str = None) -> None:
    """Log a history entry for add/remove operations."""
    history = entry.setdefault("history", [])
    history_entry = {
        "timestamp": datetime.now().isoformat(),
        "action": action,  # "add" or "remove"
        "items": items,
        "image_filename": image_filename,
    }
    history.append(history_entry)
    # Keep only last 100 history entries per bin
    if len(history) > 100:
        entry["history"] = history[-100:]


def _item_count(inventory: dict) -> int:
    items = inventory.get("items", []) if isinstance(inventory, dict) else []
    total = 0
    for item in items:
        if isinstance(item, dict):
            total += int(item.get("quantity", 0))
    return total


def _merge_condition(existing: str | None, incoming: str | None) -> str | None:
    if not incoming:
        return existing
    if not existing:
        return incoming
    existing_key = str(existing).strip().lower()
    incoming_key = str(incoming).strip().lower()
    existing_rank = CONDITION_RANK.get(existing_key, 0)
    incoming_rank = CONDITION_RANK.get(incoming_key, 0)
    return incoming if incoming_rank >= existing_rank else existing


def _merge_inventory(existing: dict, incoming: dict) -> dict:
    existing_items = existing.get("items", []) if isinstance(existing, dict) else []
    merged_items = []
    index = {}

    for item in existing_items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        normalized = {
            "name": name,
            "quantity": int(item.get("quantity", 0) or 0),
            "condition": item.get("condition", "good"),
        }
        # Preserve description, bbox and image_filename if present
        if "description" in item:
            normalized["description"] = item["description"]
        if "bbox" in item:
            normalized["bbox"] = item["bbox"]
        if "image_filename" in item:
            normalized["image_filename"] = item["image_filename"]
        index[key] = len(merged_items)
        merged_items.append(normalized)

    for item in incoming.get("items", []) if isinstance(incoming, dict) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        try:
            quantity = int(item.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            quantity = 1
        condition = item.get("condition", "good")
        description = item.get("description")
        bbox = item.get("bbox")
        image_filename = item.get("image_filename")
        if key in index:
            existing_item = merged_items[index[key]]
            existing_item["quantity"] = existing_item.get("quantity", 0) + quantity
            existing_item["condition"] = _merge_condition(
                existing_item.get("condition"), condition
            )
            # Update description, bbox and image_filename if new data provided
            if description:
                existing_item["description"] = description
            if bbox:
                existing_item["bbox"] = bbox
            if image_filename:
                existing_item["image_filename"] = image_filename
        else:
            new_item = {"name": name, "quantity": quantity, "condition": condition}
            if description:
                new_item["description"] = description
            if bbox:
                new_item["bbox"] = bbox
            if image_filename:
                new_item["image_filename"] = image_filename
            merged_items.append(new_item)
            index[key] = len(merged_items) - 1

    return {"items": merged_items}


def _subtract_inventory(existing: dict, to_remove: dict) -> dict:
    """Subtract items from inventory. Removes matching items by name and decreases quantities."""
    existing_items = existing.get("items", []) if isinstance(existing, dict) else []
    result_items = []

    # Create index of items to remove
    remove_index = {}
    for item in to_remove.get("items", []) if isinstance(to_remove, dict) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        try:
            quantity = int(item.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            quantity = 1
        remove_index[key] = quantity

    # Process existing items
    for item in existing_items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        current_qty = int(item.get("quantity", 0) or 0)

        if key in remove_index:
            # Subtract the quantity
            new_qty = current_qty - remove_index[key]
            if new_qty > 0:
                # Keep item with reduced quantity
                result_items.append({
                    "name": name,
                    "quantity": new_qty,
                    "condition": item.get("condition", "good"),
                })
            # If new_qty <= 0, item is completely removed
        else:
            # Item not in removal list, keep it
            result_items.append({
                "name": name,
                "quantity": current_qty,
                "condition": item.get("condition", "good"),
            })

    return {"items": result_items}


async def _update_input_text_summaries(hass: HomeAssistant, bin_id: str, entry: dict) -> None:
    """Update legacy input_text entities if they exist (backward compatibility)."""
    # This is optional - only updates if user has created these entities manually
    latest_filename = entry.get("images", [])[-1] if entry.get("images") else ""
    inventory = entry.get("inventory", {"items": []})
    summary = f"items: {_item_count(inventory)}"

    images_entity = f"input_text.{bin_id}_images"
    inventory_entity = f"input_text.{bin_id}_inventory"

    # Only update if entities exist (backward compatibility with old setup)
    try:
        if hass.states.get(images_entity):
            await hass.services.async_call(
                "input_text",
                "set_value",
                {"entity_id": images_entity, "value": latest_filename},
                blocking=False,
            )
        if hass.states.get(inventory_entity):
            await hass.services.async_call(
                "input_text",
                "set_value",
                {"entity_id": inventory_entity, "value": summary},
                blocking=False,
            )
    except Exception as e:
        # Silently ignore errors - these entities are optional
        LOGGER.debug(f"Could not update legacy input_text entities for {bin_id}: {e}")


async def _save_and_refresh(hass: HomeAssistant) -> None:
    store: Store = hass.data[DOMAIN]["store"]
    data = hass.data[DOMAIN]["data"]
    await store.async_save(data)
    for entity in hass.data[DOMAIN]["entities"]:
        entity.async_write_ha_state()


def _list_bin_images(folder: Path) -> list[str]:
    if not folder.exists():
        return []
    files = []
    for entry in folder.iterdir():
        if entry.is_file() and entry.suffix.lower() in ALLOWED_IMAGE_EXTS:
            try:
                files.append((entry.name, entry.stat().st_mtime))
            except OSError:
                continue
    files.sort(key=lambda item: item[1])
    return [name for name, _mtime in files]


def _issue_upload_token(hass: HomeAssistant, bin_id: str) -> str:
    tokens = hass.data[DOMAIN]["upload_tokens"]
    token = secrets.token_urlsafe(32)
    tokens[token] = {
        "bin_id": bin_id,
        "expires_at": time.time() + UPLOAD_TOKEN_TTL,
    }
    return token


def _pop_valid_upload_token(hass: HomeAssistant, token: str | None) -> dict | None:
    if not token:
        return None
    tokens = hass.data[DOMAIN]["upload_tokens"]
    entry = tokens.get(token)
    if not entry:
        return None
    if entry.get("expires_at", 0) < time.time():
        tokens.pop(token, None)
        return None
    tokens.pop(token, None)
    return entry


class SmartBinUploadView(HomeAssistantView):
    """Handle authenticated image uploads for smart bins."""

    url = "/api/smartbin_ai/upload"
    name = "api:smartbin_ai:upload"
    requires_auth = False  # Custom auth handling via token or Authorization header

    async def post(self, request: web.Request) -> web.Response:
        """Accept multipart uploads and save to /config/www/bins."""
        hass: HomeAssistant = request.app["hass"]
        LOGGER.info(
            "Upload request: content_type=%s remote=%s has_auth=%s",
            request.content_type,
            request.remote,
            bool(request.headers.get("Authorization")),
        )

        if not request.content_type.startswith("multipart/"):
            LOGGER.warning(
                "Upload rejected: expected multipart/form-data, got %s from %s",
                request.content_type,
                request.remote,
            )
            return web.json_response(
                {"success": False, "error": "Expected multipart/form-data"},
                status=400,
            )

        reader = await request.multipart()
        bin_id = "smartbin_001"
        filename: str | None = None
        image_bytes = b""
        upload_token = None
        mode = "add"  # Default mode is "add", can be "remove"
        part_names = []

        while True:
            part = await reader.next()
            if part is None:
                break
            part_names.append(part.name)

            if part.name == "bin_id":
                bin_id = (await part.text()).strip() or bin_id
            elif part.name == "filename":
                filename = (await part.text()).strip() or filename
            elif part.name in ("upload_token", "token"):
                upload_token = (await part.text()).strip() or upload_token
            elif part.name == "mode":
                mode = (await part.text()).strip() or mode
            elif part.name in ("file", "image", "upload", "image_file"):
                if not filename:
                    filename = part.filename
                image_bytes = await part.read(decode=False)
            elif part.name == "image_data":
                raw = (await part.text()).strip()
                if raw:
                    if "," in raw:
                        raw = raw.split(",", 1)[1]
                    image_bytes = base64.b64decode(raw)

        LOGGER.info(
            "Upload parsed: bin_id=%s filename=%s mode=%s parts=%s bytes=%d token=%s",
            bin_id,
            filename,
            mode,
            ",".join(part_names),
            len(image_bytes or b""),
            f"{upload_token[:8]}..." if upload_token else "none",
        )

        token_entry = None
        if not request.headers.get("Authorization"):
            token_entry = _pop_valid_upload_token(hass, upload_token)
            if not token_entry:
                LOGGER.warning(
                    "Upload unauthorized: no valid token (bin_id=%s token=%s)",
                    bin_id,
                    f"{upload_token[:8]}..." if upload_token else "none",
                )
                return web.json_response(
                    {"success": False, "error": "Unauthorized upload"},
                    status=401,
                )

        if token_entry:
            token_bin = token_entry.get("bin_id")
            if token_bin and bin_id != token_bin:
                LOGGER.warning(
                    "Upload token/bin mismatch: token_bin=%s bin_id=%s",
                    token_bin,
                    bin_id,
                )
                return web.json_response(
                    {"success": False, "error": "Token/bin mismatch"},
                    status=401,
                )

        if not image_bytes:
            LOGGER.warning(
                "Upload failed: no image data (bin_id=%s, filename=%s, remote=%s)",
                bin_id,
                filename,
                request.remote,
            )
            return web.json_response(
                {"success": False, "error": "No image data received"},
                status=400,
            )

        normalized_bytes = _normalize_image_orientation(image_bytes)
        if isinstance(normalized_bytes, (bytes, bytearray)) and normalized_bytes:
            if normalized_bytes != image_bytes:
                image_bytes = normalized_bytes
                LOGGER.debug("Normalized image orientation for upload (bin_id=%s)", bin_id)
        else:
            LOGGER.warning(
                "Image normalization returned invalid bytes; using original upload (bin_id=%s)",
                bin_id,
            )

        if not isinstance(image_bytes, (bytes, bytearray)):
            LOGGER.error(
                "Upload failed: image bytes invalid type %s (bin_id=%s, filename=%s)",
                type(image_bytes),
                bin_id,
                filename,
            )
            return web.json_response(
                {"success": False, "error": "Invalid image data"},
                status=400,
            )

        folder_id = bin_id.replace("smartbin_", "")
        target_dir = Path(hass.config.path("www/bins")) / folder_id
        await hass.async_add_executor_job(
            partial(target_dir.mkdir, parents=True, exist_ok=True)
        )

        if not filename:
            filename = f"{bin_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"

        filename = os.path.basename(filename)
        if not filename.lower().endswith((".jpg", ".jpeg", ".png")):
            filename += ".jpg"

        # Normalize image orientation before saving so coordinates match display
        image_bytes = await hass.async_add_executor_job(_normalize_image_orientation, image_bytes)

        target_path = target_dir / filename
        await hass.async_add_executor_job(target_path.write_bytes, image_bytes)

        LOGGER.info(
            "Saved upload: bin_id=%s filename=%s bytes=%d mode=%s remote=%s",
            bin_id,
            filename,
            len(image_bytes),
            mode,
            request.remote,
        )

        # Append image to bin's image list
        await hass.services.async_call(
            DOMAIN,
            "append_image",
            {"bin_id": bin_id, "filename": filename},
            blocking=True,
        )
        LOGGER.info(
            "Appended image: bin_id=%s filename=%s",
            bin_id,
            filename,
        )

        # Trigger analysis based on mode
        if mode == "remove":
            # Analyze and remove items
            hass.async_create_task(
                hass.services.async_call(
                    DOMAIN,
                    "analyze_and_remove",
                    {"bin_id": bin_id, "image_path": str(target_path)},
                    blocking=False,
                )
            )
            LOGGER.info("Queued analyze_and_remove: bin_id=%s", bin_id)
        else:
            # Standard analysis to add items
            hass.async_create_task(
                hass.services.async_call(
                    DOMAIN,
                    "analyze_image",
                    {"bin_id": bin_id, "image_path": str(target_path)},
                    blocking=False,
                )
            )
            LOGGER.info("Queued analyze_image: bin_id=%s", bin_id)

        return web.json_response(
            {
                "success": True,
                "bin_id": bin_id,
                "filename": filename,
                "path": str(target_path),
                "size": len(image_bytes),
            }
        )


class SmartBinAnalysisLogView(HomeAssistantView):
    """Serve the analysis debug log."""

    url = "/api/smartbin_ai/analysis_log"
    name = "api:smartbin_ai:analysis_log"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        log_path = Path(hass.config.path("ANALYSIS_DEBUG.log"))
        if not log_path.exists():
            return web.Response(text="Log is empty.\n", content_type="text/plain")

        content = await hass.async_add_executor_job(log_path.read_text)
        return web.Response(text=content, content_type="text/plain")


class SmartBinLaunchView(HomeAssistantView):
    """Launch smart bin upload - redirects to fancy launcher with token."""

    url = "/smartbin_ai/launch"
    name = "smartbin_ai:launch"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        bin_id = request.query.get("bin", "smartbin_001")
        token = _issue_upload_token(hass, bin_id)

        # Use JavaScript redirect for better app compatibility
        redirect_url = f"/local/smartbin_ai_upload_launcher.html?bin={bin_id}&upload_token={token}&v=2.9"
        html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0;url={redirect_url}">
    <script>window.location.href = '{redirect_url}';</script>
</head>
<body>
    <p>Redirecting to smart bin upload...</p>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")


class SmartBinUploadTokenView(HomeAssistantView):
    """Issue an upload token for the frontend."""

    url = "/api/smartbin_ai/upload_token"
    name = "api:smartbin_ai:upload_token"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        bin_id = request.query.get("bin", "smartbin_001")
        token = _issue_upload_token(hass, bin_id)
        LOGGER.info("Issued upload token: bin_id=%s token=%s...", bin_id, token[:8])
        return web.json_response({"bin_id": bin_id, "upload_token": token})


class SmartBinLaunchRemoveView(HomeAssistantView):
    """Launch smart bin removal - take photo to remove items."""

    url = "/smartbin_ai/launch_remove"
    name = "smartbin_ai:launch_remove"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        bin_id = request.query.get("bin", "smartbin_001")
        token = _issue_upload_token(hass, bin_id)

        # Use JavaScript redirect for better app compatibility
        redirect_url = f"/local/smartbin_ai_remove_launcher.html?bin={bin_id}&upload_token={token}&v=1.0"
        html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0;url={redirect_url}">
    <script>window.location.href = '{redirect_url}';</script>
</head>
<body>
    <p>Redirecting to item removal...</p>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")


class SmartBinLaunchSimpleView(HomeAssistantView):
    """Simple launcher view (original version)."""

    url = "/smartbin_ai/launch_simple"
    name = "smartbin_ai:launch_simple"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        bin_id = request.query.get("bin", "smartbin_001")
        token = _issue_upload_token(hass, bin_id)

        html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>Smart Bin Upload</title>
  <style>
    :root {{
      --bg: #111318;
      --panel: #1b1f26;
      --panel-2: #232936;
      --accent: #ff8f2b;
      --accent-2: #f5c06a;
      --text: #f4f6f9;
      --muted: #a4acba;
      --border: #2a313d;
      --danger: #d45345;
      --success: #4caf50;
      --shadow: 0 18px 45px rgba(0, 0, 0, 0.4);
      --font-body: "Trebuchet MS", "Lucida Sans Unicode", sans-serif;
      --font-display: "Impact", "Arial Black", sans-serif;
      --button-text: #1a1a1a;
    }}
    * {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}
    body {{
      min-height: 100vh;
      color: var(--text);
      font-family: var(--font-body);
      background:
        linear-gradient(135deg, rgba(255, 143, 43, 0.08), transparent 40%),
        linear-gradient(225deg, rgba(76, 88, 110, 0.4), transparent 50%),
        #0e1014;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }}
    .panel {{
      width: min(520px, 100%);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      box-shadow: var(--shadow);
      text-align: center;
    }}
    h1 {{
      font-family: var(--font-display);
      font-size: 28px;
      margin-bottom: 16px;
      color: var(--accent);
    }}
    .status {{
      margin: 12px 0 20px;
      color: var(--muted);
      font-size: 14px;
    }}
    .upload-button {{
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
      color: var(--button-text);
      border: none;
      padding: 18px 24px;
      font-size: 18px;
      font-weight: 900;
      font-family: var(--font-display);
      letter-spacing: 0.06em;
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
    }}
    .file-input {{
      position: absolute;
      left: -9999px;
      width: 1px;
      height: 1px;
      opacity: 0;
    }}
    .preview {{
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-top: 16px;
      display: none;
    }}
  </style>
</head>
<body>
  <div class="panel">
    <h1>Smart Bin Upload</h1>
    <div class="status" id="status">Bin: {bin_id}</div>
    <button class="upload-button" id="uploadBtn" type="button">TAKE PHOTO</button>
    <input type="file" id="fileInput" class="file-input" accept="image/*" capture="environment">
    <img id="preview" class="preview" alt="Preview">
  </div>
  <script>
    const binId = {json.dumps(bin_id)};
    const uploadToken = {json.dumps(token)};

    const statusEl = document.getElementById('status');
    const preview = document.getElementById('preview');

    function showStatus(text) {{
      statusEl.textContent = text;
    }}

    function uploadImage(file) {{
      showStatus('Uploading image...');
      const formData = new FormData();
      const filename = `${{binId}}_${{Date.now()}}.jpg`;
      formData.append('bin_id', binId);
      formData.append('filename', filename);
      formData.append('upload_token', uploadToken);
      formData.append('file', file, filename);
      formData.append('timestamp', new Date().toISOString());

      fetch('/api/smartbin_ai/upload', {{
        method: 'POST',
        body: formData
      }})
      .then(async response => {{
        if (!response.ok) {{
          const body = await response.text();
          throw new Error(`Upload failed: HTTP ${{response.status}} ${{body}}`);
        }}
        return response.json();
      }})
      .then(data => {{
        showStatus(`Uploaded: ${{data.filename}}`);
      }})
      .catch(error => {{
        showStatus('Upload failed: ' + error.message);
      }});
    }}

    document.getElementById('fileInput').addEventListener('change', (event) => {{
      const file = event.target.files && event.target.files[0];
      if (!file) {{
        return;
      }}
      const reader = new FileReader();
      reader.onload = (e) => {{
        preview.src = e.target.result;
        preview.style.display = 'block';
      }};
      reader.readAsDataURL(file);
      uploadImage(file);
    }});

    document.getElementById('uploadBtn').addEventListener('click', (event) => {{
      event.preventDefault();
      document.getElementById('fileInput').click();
    }});
  </script>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")


async def analyze_bin_image_service(call: ServiceCall) -> None:
    """Service to analyze a bin image with AI vision."""
    hass = call.hass
    bin_id = call.data["bin_id"]
    image_path = call.data.get("image_path")
    bin_name = call.data.get("bin_name") or bin_id
    existing_items = call.data.get("existing_items") or []
    api_key, api_url, model = _get_api_config(hass)

    if not image_path:
        entry = _get_bin_entry(hass, bin_id)
        images = entry.get("images", [])
        if not images:
            LOGGER.warning("No images available to analyze for %s", bin_id)
            return
        folder_id = bin_id.replace("smartbin_", "")
        image_path = f"{hass.config.path('www/bins')}/{folder_id}/{images[-1]}"

    LOGGER.info("Analyzing image for %s: %s (existing items: %d)", bin_id, image_path, len(existing_items))

    # Debug log file
    debug_log = hass.config.path("ANALYSIS_DEBUG.log")

    def log_debug(msg):
        try:
            with open(debug_log, "a") as f:
                f.write(f"[{datetime.now()}] {msg}\n")
        except:
            pass

    log_debug(f"=== ANALYSIS STARTED: {bin_id} ===")

    async def coerce_json_from_text(text: str) -> dict | None:
        prompt = (
            "EXTRACT all items from the text below and return ONLY valid JSON in this EXACT format:\n"
            '{"items": [{"name": "Samsung Phone", "description": "blue with Samsung logo", "quantity": 1, "condition": "good", "bbox": [10, 20, 30, 40]}]}\n\n'
            "RULES:\n"
            "1. Extract EVERY item mentioned in the text\n"
            "2. Use the item names from the text (clean up if needed)\n"
            "3. Extract any color, brand, or distinguishing features into description field\n"
            "4. Set quantity to 1 for each item unless specified\n"
            "5. Set condition to 'good' unless specified\n"
            "6. Extract bbox coordinates if mentioned, otherwise estimate or use [0, 0, 100, 100]\n"
            "7. bbox format: [x, y, width, height] in PIXELS (absolute coordinates)\n"
            "8. Return ONLY the JSON object, NO explanations or markdown\n"
            "9. If no items found, return: {\"items\": []}\n\n"
            f"TEXT TO CONVERT:\n{text}\n\n"
            "JSON OUTPUT:"
        )
        payload = {
            "model": _get_text_model(hass),  # Use fast text model for extraction
            "messages": [
                {"role": "system", "content": "You are a JSON converter. Extract items from text and return ONLY valid JSON. No markdown, no explanations."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 2000,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }
        api_key, api_url, model = _get_api_config(hass)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                api_url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json=payload,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as response:
                if not response.ok:
                    error_text = await response.text()
                    raise Exception(
                        f"Z.AI JSON repair error: {response.status} - {error_text}"
                    )
                data = await response.json()
        choices = data.get("choices", [])
        if not choices:
            return None
        message = choices[0].get("message", {})
        content = message.get("content", "")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        if not content:
            return None
        content = content.strip()
        if content.startswith("```json"):
            content = content[7:]
        if content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()
        return json.loads(content)

    try:
        entry = _get_bin_entry(hass, bin_id)
        _set_analysis_status(entry, "quick_running", "Quick scan running (approximate).")
        await _save_and_refresh(hass)

        log_debug("Step 1: Reading image file...")
        # Read and encode image
        image_bytes = await hass.async_add_executor_job(
            Path(image_path).read_bytes
        )
        log_debug(f"Step 2: Image read, size={len(image_bytes)} bytes")

        # Prepare image for AI: normalize orientation and send full resolution
        from PIL import Image, ImageOps
        import io
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        original_width, original_height = img.size
        log_debug(f"Step 2b: Original image dimensions: {original_width}x{original_height}")

        # Send full resolution image
        # NOTE: z.ai API returns coordinates in 0-1000 normalized space, not actual pixels
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=85, optimize=True)
        image_bytes = buffer.getvalue()
        img_width, img_height = original_width, original_height
        log_debug(
            f"Step 2c: Sending full resolution {img_width}x{img_height} to AI"
        )

        # DEBUG: Save a copy of what we're sending to the AI
        debug_image_path = hass.config.path(f"www/bins/DEBUG_ai_input_{os.path.basename(image_path)}")
        await hass.async_add_executor_job(Path(debug_image_path).write_bytes, image_bytes)
        log_debug(f"Step 2d: Saved debug copy of AI input image to {debug_image_path}")

        image_base64 = base64.b64encode(image_bytes).decode('utf-8')
        log_debug(f"Step 3: Image base64 encoded, length={len(image_base64)}")

        # Build quick scan prompt (z2.py approach - simple and fast)
        prompt_quick = (
            "Identify all objects in the image and list their names. "
            "For each object, provide description, quantity, coordinates as "
            "[x_min,y_min,x_max,y_max] in pixels, and condition. "
            "Return ONLY valid JSON."
        )
        if existing_items:
            existing_list = ", ".join(existing_items)
            prompt_quick += f" Exclude these items: {existing_list}."

        log_debug(f"Excluding {len(existing_items)} existing items from analysis")

        def build_payload(prompt_text: str, system_prompt: str) -> dict:
            return {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": system_prompt,
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                            },
                            {"type": "text", "text": prompt_text},
                        ],
                    },
                ],
                "temperature": 0.0,
                "response_format": {"type": "json_object"},
            }

        def extract_content(response_data: dict) -> str:
            choices = response_data.get("choices", [])
            if not choices:
                raise Exception(f"No choices in API response: {response_data}")
            message = choices[0].get("message", {})
            content = message.get("content", "")
            reasoning_content = message.get("reasoning_content", "")
            if isinstance(content, list):
                content = "".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
            if not content and reasoning_content:
                content = reasoning_content
            if not content:
                raise Exception(f"No content in API response: {response_data}")
            content = content.strip()
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            return content.strip()

        async def call_api(
            prompt_text: str,
            timeout_seconds: int,
            system_prompt: str,
        ) -> dict:
            payload = build_payload(prompt_text, system_prompt)
            log_debug(
                f"Request: model={model} image_path={image_path} "
                f"prompt={prompt_text.replace(chr(10), ' ')}"
            )
            log_debug(f"Request system prompt: {system_prompt}")
            log_debug("Request response_format: json_object")
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    api_url,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=timeout_seconds),
                ) as response:
                    log_debug(f"Step 5: API response status={response.status}")
                    if not response.ok:
                        error_text = await response.text()
                        log_debug(f"API ERROR: {error_text}")
                        raise Exception(f"Z.AI API error: {response.status} - {error_text}")
                    data = await response.json()
            content = extract_content(data)
            log_debug(f"Step 7: FULL AI Response: {content[:2000]}")
            LOGGER.info("AI Response content: %s", content[:500])
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as json_err:
                raise Exception(f"JSON parse error: {json_err}")
            return parsed

        log_debug("Step 4: Calling Z.AI API (quick pass)...")
        quick_system = "You are a High-Precision Vision Annotation Engine. Return ONLY valid JSON."
        quick_data = await call_api(
            prompt_quick,
            timeout_seconds=180,
            system_prompt=quick_system,
        )
        quick_items = _coerce_quick_items(quick_data, original_width, original_height)
        result = {"items": quick_items}
        log_debug(f"Step 6: Quick item count: {len(result.get('items', []))}")

        log_debug("Step 8: Parsing JSON...")
        parse_ok = True
        if not isinstance(result, dict) or "items" not in result:
            result = {"items": []}
            parse_ok = False
        log_debug(f"Step 9: JSON parsed successfully, found {len(result.get('items', []))} items")

        result_json = json.dumps(result)
        log_debug(f"Step 10: Result JSON: {result_json}")

        entry = _get_bin_entry(hass, bin_id)
        if not parse_ok:
            log_debug("Step 11: JSON parse failed; preserving existing inventory.")
            _set_analysis_status(entry, "error", "Quick scan failed. Try re-analyze.")
            await _save_and_refresh(hass)
            return
        incoming_items = result.get("items", []) if isinstance(result, dict) else []
        if not incoming_items:
            log_debug("Step 11: No items detected; preserving existing inventory.")
            _set_analysis_status(entry, "error", "Quick scan found no items. Try re-analyze.")
            await _save_and_refresh(hass)
            return

        # Normalize AI coordinates into bbox [x, y, width, height]
        # z.ai returns coordinates in 0-1000 normalized space, convert to actual pixels
        LOGGER.warning(f"BBOX DEBUG: Processing {len(incoming_items)} items")
        for item in incoming_items:
            if not isinstance(item, dict):
                continue
            coords = item.get("coordinates")
            LOGGER.warning(f"BBOX DEBUG: Item {item.get('name')} has coords: {coords}, type: {type(coords)}")
            if coords:
                bboxes = []
                try:
                    if isinstance(coords, list) and len(coords) == 4 and all(
                        isinstance(v, (int, float)) and not isinstance(v, bool) for v in coords
                    ):
                        coords = [coords]
                    if isinstance(coords, list):
                        for box in coords:
                            if (
                                isinstance(box, list)
                                and len(box) == 4
                                and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box)
                            ):
                                x1, y1, x2, y2 = box
                                LOGGER.warning(f"BBOX DEBUG: Original coords [{x1}, {y1}, {x2}, {y2}] on {original_width}x{original_height}")
                                # Convert from 0-1000 normalized space to actual pixels
                                x1 = (x1 / 1000.0) * original_width
                                y1 = (y1 / 1000.0) * original_height
                                x2 = (x2 / 1000.0) * original_width
                                y2 = (y2 / 1000.0) * original_height
                                LOGGER.warning(f"BBOX DEBUG: After conversion [{x1}, {y1}, {x2}, {y2}]")
                                x_min = min(x1, x2)
                                y_min = min(y1, y2)
                                x_max = max(x1, x2)
                                y_max = max(y1, y2)
                                bboxes.append(
                                    [
                                        int(x_min),
                                        int(y_min),
                                        int(x_max - x_min),
                                        int(y_max - y_min),
                                    ]
                                )
                    if bboxes:
                        item["bboxes"] = bboxes
                        item["bbox"] = bboxes[0]
                        LOGGER.warning(f"BBOX DEBUG: Successfully converted {len(bboxes)} bboxes for {item.get('name')}")
                        log_debug(f"Converted coordinates {coords} to bbox list ({len(bboxes)}), scaled to {original_width}x{original_height}")
                except Exception as e:
                    LOGGER.error(f"BBOX ERROR: Exception processing coords for {item.get('name')}: {e}, coords: {coords}")
                    log_debug(f"Invalid coordinates for item {item.get('name')}: {coords}")

        # Filter out items that already exist in inventory (only add NEW items)
        existing_inventory = entry.get("inventory", {"items": []})
        existing_names = {str(item.get("name", "")).strip().lower()
                         for item in existing_inventory.get("items", [])
                         if isinstance(item, dict)}

        filtered_items = []
        skipped_items = []
        for item in incoming_items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            if name.lower() in existing_names:
                skipped_items.append(name)
            else:
                filtered_items.append(item)

        if skipped_items:
            log_debug(f"Step 11a: Skipped {len(skipped_items)} existing items: {', '.join(skipped_items)}")

        if not filtered_items:
            log_debug("Step 11b: All detected items already exist; no changes to inventory.")
            return

        log_debug(f"Step 11c: Adding {len(filtered_items)} new items: {[item.get('name') for item in filtered_items]}")

        # Extract image filename and attach to each item
        # (bboxes already converted from 0-1000 space to actual pixels above)
        image_filename = image_path.split('/')[-1] if image_path else None
        if image_filename:
            for item in filtered_items:
                if isinstance(item, dict):
                    item["image_filename"] = image_filename
                    bbox = item.get("bbox")
                    if bbox and len(bbox) == 4:
                        bbox_xyxy = [
                            bbox[0],
                            bbox[1],
                            bbox[0] + bbox[2],
                            bbox[1] + bbox[3],
                        ]
                        log_debug(
                            f"BBox xyxy {bbox_xyxy} on {original_width}x{original_height}"
                        )
                    log_debug(f"Attached image {image_filename} to item {item.get('name')}, bbox: {bbox}")

        # Only merge the filtered (new) items
        filtered_result = {"items": filtered_items}
        entry["inventory"] = _merge_inventory(existing_inventory, filtered_result)
        _log_history(entry, "add", filtered_items, image_filename)
        log_debug(f"Step 12: Logged history entry (add) with {len(filtered_items)} items")

        _set_analysis_status(
            entry,
            "done",
            "Analysis complete.",
        )

        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

        LOGGER.info(
            "Updated %s inventory with %d items (quick pass)", bin_id, len(result.get("items", []))
        )

        # Deep analysis disabled by default (can take 1-10 minutes)
        # Uncomment to enable comprehensive multi-pass analysis and change status to "deep_pending" above
        # hass.async_create_task(
        #     _analyze_bin_image_deep(
        #         hass=hass,
        #         bin_id=bin_id,
        #         image_path=image_path,
        #         bin_name=bin_name,
        #         existing_items=existing_items,
        #         debug_log=debug_log,
        #     )
        # )

    except Exception as e:
        log_debug(f"ERROR: Analysis failed: {str(e)}")
        LOGGER.error("Analysis failed for %s: %s", bin_id, str(e))
        LOGGER.error("Exception details:", exc_info=True)


async def _analyze_bin_image_deep(
    *,
    hass: HomeAssistant,
    bin_id: str,
    image_path: str,
    bin_name: str,
    existing_items: list[str],
    debug_log: str,
) -> None:
    entry = _get_bin_entry(hass, bin_id)
    _set_analysis_status(entry, "deep_running", "Deep analysis running (10 minutes max).")
    await _save_and_refresh(hass)

    def log_debug(msg):
        try:
            with open(debug_log, "a") as f:
                f.write(f"[{datetime.now()}] {msg}\n")
        except:
            pass

    try:
        log_debug(f"=== DEEP ANALYSIS STARTED: {bin_id} ===")
        image_bytes = await hass.async_add_executor_job(Path(image_path).read_bytes)
        from PIL import Image, ImageOps
        import io
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        original_width, original_height = img.size

        # Send full resolution image
        # NOTE: z.ai API returns coordinates in 0-1000 normalized space, not actual pixels
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=85, optimize=True)
        image_bytes = buffer.getvalue()
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")

        existing_list = ", ".join(existing_items) if existing_items else None
        prompt_full = _z4_make_prompt(high_recall=True, small_only=False, exclude=existing_list)
        prompt_small = _z4_make_prompt(high_recall=True, small_only=True, exclude=existing_list)

        async def call_api(prompt_text: str) -> dict:
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a High-Precision Vision Annotation Engine. "
                            "Return ONLY valid JSON. No markdown, no extra text. "
                            'All strings must be non-empty; use "unknown" when unsure.'
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                            },
                            {"type": "text", "text": prompt_text},
                        ],
                    },
                ],
                "temperature": 0.0,
                "response_format": {"type": "json_object"},
            }
            log_debug(f"Deep API call: prompt={prompt_text[:100]}...")
            api_key, api_url, model = _get_api_config(hass)
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    api_url,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=600),
                ) as response:
                    if not response.ok:
                        error_text = await response.text()
                        log_debug(f"Deep API error: {response.status} - {error_text}")
                        raise Exception(f"Z.AI API error: {response.status} - {error_text}")
                    data = await response.json()

            # Extract content from response
            message = data.get("choices", [{}])[0].get("message", {})
            content = message.get("content", "")
            reasoning_content = message.get("reasoning_content", "")
            finish_reason = data.get("choices", [{}])[0].get("finish_reason", "")

            # Handle list-based content (raw API quirk)
            if isinstance(content, list):
                content = "".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )

            # Fallback to reasoning_content if main content is empty (raw API quirk)
            if not content and reasoning_content:
                content = reasoning_content
                log_debug("Using reasoning_content as fallback")

            # Check for token limit hit
            if finish_reason == "length":
                log_debug(f"Warning: Response truncated (hit token limit). Content length: {len(content)}")

            # Validate content exists (like z4.py)
            if not content or not isinstance(content, str):
                log_debug(f"Model returned empty content: {data}")
                raise ValueError("Model returned empty content")

            # Clean markdown formatting
            content = content.strip()
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

            log_debug(f"Deep API response content: {content[:500]}...")

            # Parse JSON (like z4.py)
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as e:
                log_debug(f"JSON parse error: {e}")
                raise ValueError(f"Model did not return valid JSON: {e}\nRaw:\n{content[:500]}") from e

            parsed = _z4_sanitize_output(parsed)
            _z4_validate_schema(parsed)
            return parsed

        log_debug("Deep analysis: pass A")
        result_a = await call_api(prompt_full)
        log_debug("Deep analysis: pass B")
        result_b = await call_api(prompt_small)
        merged = _z4_merge_results(result_a, result_b)
        merged = _z4_sanitize_output(merged)
        _z4_validate_schema(merged)
        items = _z4_objects_to_items(merged.get("image_analysis", {}).get("objects", []))

        # Convert bboxes from 0-1000 normalized space to actual pixels
        # Note: _z4_objects_to_items already converted from xyxy to xywh format
        for item in items:
            bboxes = item.get("bboxes") or ([] if not item.get("bbox") else [item.get("bbox")])
            if not bboxes:
                continue
            mapped_bboxes = []
            for bbox in bboxes:
                if not bbox or len(bbox) != 4:
                    continue
                x, y, w, h = bbox
                # Convert from 0-1000 normalized space to actual pixels
                mapped_x = (x / 1000.0) * original_width
                mapped_y = (y / 1000.0) * original_height
                mapped_w = (w / 1000.0) * original_width
                mapped_h = (h / 1000.0) * original_height
                # Clamp to image bounds
                mapped_x = max(0, min(original_width, mapped_x))
                mapped_y = max(0, min(original_height, mapped_y))
                mapped_w = max(0, min(original_width - mapped_x, mapped_w))
                mapped_h = max(0, min(original_height - mapped_y, mapped_h))
                mapped_bboxes.append(
                    [int(mapped_x), int(mapped_y), int(mapped_w), int(mapped_h)]
                )
            if mapped_bboxes:
                item["bboxes"] = mapped_bboxes
                item["bbox"] = mapped_bboxes[0]

        image_filename = image_path.split("/")[-1] if image_path else None
        if image_filename:
            for item in items:
                if isinstance(item, dict):
                    item["image_filename"] = image_filename

        existing_inventory = entry.get("inventory", {"items": []})
        entry["inventory"] = _merge_inventory_update(existing_inventory, {"items": items})

        _set_analysis_status(entry, "deep_done", "Deep analysis complete.")
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

        LOGGER.info("Deep analysis updated %s with %d items", bin_id, len(items))
    except Exception as err:
        log_debug(f"DEEP ANALYSIS ERROR: {err}")
        _set_analysis_status(entry, "error", "Deep analysis failed. Try re-analyze.")
        await _save_and_refresh(hass)
        LOGGER.error("Deep analysis failed for %s: %s", bin_id, err)


async def analyze_and_remove_items_service(call: ServiceCall) -> None:
    """Service to analyze a bin image and REMOVE identified items from inventory."""
    hass = call.hass
    bin_id = call.data["bin_id"]
    image_path = call.data.get("image_path")
    bin_name = call.data.get("bin_name") or bin_id
    existing_items = call.data.get("existing_items") or []

    if not image_path:
        entry = _get_bin_entry(hass, bin_id)
        images = entry.get("images", [])
        if not images:
            LOGGER.warning("No images available to analyze for %s", bin_id)
            return
        folder_id = bin_id.replace("smartbin_", "")
        image_path = f"{hass.config.path('www/bins')}/{folder_id}/{images[-1]}"

    LOGGER.info("Analyzing image for REMOVAL in %s: %s (existing items: %d)", bin_id, image_path, len(existing_items))

    # Debug log file
    debug_log = hass.config.path("ANALYSIS_DEBUG.log")

    def log_debug(msg):
        try:
            with open(debug_log, "a") as f:
                f.write(f"[{datetime.now()}] {msg}\n")
        except:
            pass

    log_debug(f"=== REMOVAL ANALYSIS STARTED: {bin_id} ===")

    try:
        log_debug("Step 1: Reading image file...")
        # Read and encode image
        image_bytes = await hass.async_add_executor_job(
            Path(image_path).read_bytes
        )
        log_debug(f"Step 2: Image read, size={len(image_bytes)} bytes")

        # Get image dimensions and compress if needed using PIL
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(image_bytes))
        original_width, original_height = img.size
        log_debug(f"Step 2b: Original image dimensions: {original_width}x{original_height}")

        # Compress large images to reduce API processing time
        MAX_WIDTH = 2048
        scale_factor = 1.0  # Track scaling for bounding box coordinates
        if original_width > MAX_WIDTH:
            # Calculate new dimensions maintaining aspect ratio
            scale_factor = original_width / MAX_WIDTH
            new_width = MAX_WIDTH
            new_height = int(original_height / scale_factor)
            log_debug(f"Step 2c: Resizing image to {new_width}x{new_height} for faster processing (scale: {scale_factor:.2f})")
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            # Re-encode to JPEG with quality 85
            buffer = io.BytesIO()
            img.save(buffer, format='JPEG', quality=85, optimize=True)
            image_bytes = buffer.getvalue()
            log_debug(f"Step 2d: Compressed image size: {len(image_bytes)} bytes (from original)")
        else:
            log_debug(f"Step 2c: Image size is acceptable, no compression needed")

        image_base64 = base64.b64encode(image_bytes).decode('utf-8')
        log_debug(f"Step 3: Image base64 encoded, length={len(image_base64)}")

        # Prepare AI request with prompt that focuses on existing items
        if existing_items:
            existing_list = ", ".join(existing_items)
            prompt = f"""RETURN ONLY VALID JSON. List items to REMOVE. Inventory: {existing_list}

FORMAT (copy exactly):
{{"items": [{{"name": "Item Name", "quantity": 1, "condition": "good"}}]}}

RULES:
- ONLY JSON, NO text or explanations
- Match item names from inventory list
- Each item needs: name, quantity, condition"""
            log_debug(f"Looking for {len(existing_items)} items from inventory to remove")
        else:
            prompt = """RETURN ONLY VALID JSON. List all items you see.

FORMAT (copy exactly):
{"items": [{"name": "Item Name", "quantity": 1, "condition": "good"}]}

RULES:
- ONLY JSON output, NO explanations
- Include ALL visible items
- Each item: name, quantity (1 if not specified), condition (good/fair/needs replacement)"""

        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a JSON-only API. Return ONLY valid JSON. NO explanations, NO markdown, NO narrative text."
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}
                        },
                        {"type": "text", "text": prompt}
                    ]
                }
            ],
            "max_tokens": 800,
            "temperature": 0.0,
            "response_format": {"type": "json_object"}
        }
        log_debug(
            f"Request: model={model} image_path={image_path} mode=REMOVE"
        )

        # Call z.ai API
        log_debug("Step 4: Calling Z.AI API...")
        api_key, api_url, model = _get_api_config(hass)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                api_url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json=payload,
                timeout=aiohttp.ClientTimeout(total=180)
            ) as response:
                log_debug(f"Step 5: API response status={response.status}")
                if not response.ok:
                    error_text = await response.text()
                    log_debug(f"API ERROR: {error_text}")
                    raise Exception(f"Z.AI API error: {response.status} - {error_text}")

                data = await response.json()
        log_debug("Step 6: API response received")

        # Extract result
        choices = data.get("choices", [])
        if not choices:
            raise Exception(f"No choices in API response: {data}")

        message = choices[0].get("message", {})
        content = message.get("content", "")

        # Handle list content
        if isinstance(content, list):
            content = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )

        if not content:
            raise Exception(f"No content in API response: {data}")

        # Clean up markdown formatting
        content = content.strip()
        if content.startswith('```json'):
            content = content[7:]
        if content.startswith('```'):
            content = content[3:]
        if content.endswith('```'):
            content = content[:-3]
        content = content.strip()

        log_debug(f"Step 7: FULL AI Response: {content}")
        LOGGER.info("AI Response content (removal): %s", content[:500])

        # Parse JSON
        log_debug("Step 8: Parsing JSON...")
        try:
            result = json.loads(content)
            if 'items' not in result:
                result = {'items': []}
            log_debug(f"Step 9: JSON parsed successfully, found {len(result.get('items', []))} items to REMOVE")
        except json.JSONDecodeError as json_err:
            log_debug(f"Step 9: JSON parse FAILED: {json_err}")
            LOGGER.warning("Could not parse JSON from response: %s", content)
            result = {'items': []}

        result_json = json.dumps(result)
        log_debug(f"Step 10: Result JSON: {result_json}")

        entry = _get_bin_entry(hass, bin_id)
        incoming_items = result.get("items", []) if isinstance(result, dict) else []
        if not incoming_items:
            log_debug("Step 11: No items detected; no changes to inventory.")
            return

        # Filter to only items that exist in inventory
        existing_inventory = entry.get("inventory", {"items": []})
        existing_items_map = {str(item.get("name", "")).strip().lower(): item
                             for item in existing_inventory.get("items", [])
                             if isinstance(item, dict)}

        filtered_items = []
        skipped_items = []
        for item in incoming_items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            if name.lower() in existing_items_map:
                filtered_items.append(item)
            else:
                skipped_items.append(name)

        if skipped_items:
            log_debug(f"Step 11a: Skipped {len(skipped_items)} non-existent items: {', '.join(skipped_items)}")

        if not filtered_items:
            log_debug("Step 11b: None of the detected items exist in inventory; no changes.")
            return

        log_debug(f"Step 11c: Removing {len(filtered_items)} items: {[item.get('name') for item in filtered_items]}")

        # SUBTRACT items instead of merging (only filtered items)
        filtered_result = {"items": filtered_items}
        entry["inventory"] = _subtract_inventory(existing_inventory, filtered_result)

        # Log history entry (only for items that were actually removed)
        image_filename = image_path.split('/')[-1] if image_path else None
        _log_history(entry, "remove", filtered_items, image_filename)
        log_debug(f"Step 12: Logged history entry (remove) with {len(filtered_items)} items")

        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

        LOGGER.info(
            "Removed %d item types from %s inventory", len(result.get("items", [])), bin_id
        )
        log_debug(f"=== REMOVAL COMPLETE ===")

    except Exception as e:
        log_debug(f"ERROR: Removal analysis failed: {str(e)}")
        LOGGER.error("Removal analysis failed for %s: %s", bin_id, str(e))
        LOGGER.error("Exception details:", exc_info=True)


class SmartBinStorageBinsView(HomeAssistantView):
    """Serve the SmartBin AI Command Center dashboard."""

    url = "/storage-bins/{tail:.*}"
    name = "smartbin_ai:storage_bins"
    requires_auth = False

    async def get(self, request: web.Request, tail: str = "") -> web.Response:
        """Redirect to the dashboard."""
        redirect_url = "/local/smartbin_ai_dashboard.html"
        html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0;url={redirect_url}">
    <script>window.location.href = '{redirect_url}';</script>
</head>
<body>
    <p>Loading SmartBin AI Command Center...</p>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")


class SmartBinConfigView(HomeAssistantView):
    """Provide bin configuration for frontend (HACS-compatible)."""

    url = "/api/smartbin_ai/config"
    name = "api:smartbin_ai:config"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        """Get bin configuration."""
        hass: HomeAssistant = request.app["hass"]
        active_bin = hass.data[DOMAIN].get("active_bin", "smartbin_001")
        bins_data = hass.data[DOMAIN]["data"].get("bins", {})

        bins = {}
        for bin_id, bin_data in bins_data.items():
            bins[bin_id] = {
                "name": bin_data.get("name", bin_id),
                "id": bin_id,
            }

        return web.json_response({
            "active_bin": active_bin,
            "bins": bins
        })

    async def post(self, request: web.Request) -> web.Response:
        """Update bin configuration."""
        hass: HomeAssistant = request.app["hass"]
        data = await request.json()
        bins_data = hass.data[DOMAIN]["data"].setdefault("bins", {})
        updated = False

        # Update active bin
        if "active_bin" in data:
            hass.data[DOMAIN]["active_bin"] = data["active_bin"]
            # Persist to storage
            updated = True

        # Update bin names
        if "bins" in data:
            for bin_id, bin_info in data["bins"].items():
                if bin_id not in bins_data:
                    bins_data[bin_id] = {}
                if "name" in bin_info:
                    bins_data[bin_id]["name"] = bin_info["name"]
            updated = True

        added_bins = []

        # Add bins (expects list of {id, name})
        if "add_bins" in data:
            for bin_info in data["add_bins"]:
                if not isinstance(bin_info, dict):
                    continue
                bin_id = bin_info.get("id")
                if not bin_id:
                    continue
                if bin_id not in bins_data:
                    bins_data[bin_id] = {}
                    added_bins.append(bin_id)
                name = bin_info.get("name")
                if name:
                    bins_data[bin_id]["name"] = name
                updated = True

        # Remove bins (expects list of ids)
        removed_entities = []
        if "remove_bins" in data:
            for bin_id in data["remove_bins"]:
                if bin_id in bins_data:
                    bins_data.pop(bin_id, None)
                    updated = True
                for entity in list(hass.data[DOMAIN].get("entities", [])):
                    if getattr(entity, "_bin_id", None) == bin_id:
                        removed_entities.append(entity)
                        hass.data[DOMAIN]["entities"].remove(entity)

        active_bin = hass.data[DOMAIN].get("active_bin")
        if active_bin and active_bin not in bins_data:
            next_bin = sorted(bins_data.keys())[0] if bins_data else ""
            hass.data[DOMAIN]["active_bin"] = next_bin
            updated = True

        if updated:
            if added_bins:
                add_entities = hass.data[DOMAIN].get("add_entities")
                if add_entities:
                    from .sensor import SmartBinDataSensor
                    new_entities = [SmartBinDataSensor(hass, bin_id) for bin_id in added_bins]
                    hass.data[DOMAIN]["entities"].extend(new_entities)
                    add_entities(new_entities)
            for entity in removed_entities:
                await entity.async_remove()
            hass.data[DOMAIN]["data"]["bins_initialized"] = True
            store = hass.data[DOMAIN]["store"]
            await store.async_save(hass.data[DOMAIN]["data"])

        return web.json_response({"success": True})


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the smart bin upload endpoint."""
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict):
        data = {}
    data.setdefault("bins", {})
    hass.data[DOMAIN] = {
        "store": store,
        "data": data,
        "entities": [],
        "upload_tokens": {},
    }

    hass.http.register_view(SmartBinUploadView())
    hass.http.register_view(SmartBinAnalysisLogView())
    hass.http.register_view(SmartBinLaunchView())
    hass.http.register_view(SmartBinUploadTokenView())
    hass.http.register_view(SmartBinLaunchRemoveView())
    hass.http.register_view(SmartBinLaunchSimpleView())
    hass.http.register_view(SmartBinStorageBinsView())
    hass.http.register_view(SmartBinConfigView())
    LOGGER.info(
        "Smart bin upload endpoint registered at %s",
        SmartBinUploadView.url,
    )

    # Register AI analysis services
    hass.services.async_register(
        DOMAIN,
        "analyze_image",
        analyze_bin_image_service,
        schema=SERVICE_ANALYZE_IMAGE_SCHEMA,
    )
    LOGGER.info("Smart bin analyze_image service registered")

    hass.services.async_register(
        DOMAIN,
        "analyze_and_remove",
        analyze_and_remove_items_service,
        schema=SERVICE_ANALYZE_AND_REMOVE_SCHEMA,
    )
    LOGGER.info("Smart bin analyze_and_remove service registered")

    async def append_image_service(call: ServiceCall) -> None:
        bin_id = call.data["bin_id"]
        filename = os.path.basename(call.data["filename"])
        entry = _get_bin_entry(hass, bin_id)
        images = entry.get("images", [])
        if filename not in images:
            images.append(filename)
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def remove_item_service(call: ServiceCall) -> None:
        bin_id = call.data["bin_id"]
        item_name = (call.data.get("item_name") or "").strip().lower()
        entry = _get_bin_entry(hass, bin_id)
        inventory = entry.get("inventory", {"items": []})
        items = list(inventory.get("items", []))
        if item_name:
            kept = []
            removed = False
            for item in items:
                name = str(item.get("name", "")).lower()
                if not removed and name == item_name:
                    removed = True
                else:
                    kept.append(item)
            inventory = {"items": kept}
        else:
            inventory = {"items": items[:-1] if items else []}
        entry["inventory"] = inventory
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def remove_image_service(call: ServiceCall) -> None:
        """Remove a specific image from a bin."""
        bin_id = call.data["bin_id"]
        filename = os.path.basename(call.data["filename"])
        entry = _get_bin_entry(hass, bin_id)
        images = entry.get("images", [])
        if filename in images:
            images.remove(filename)
            # Also delete the physical file
            folder_id = bin_id.replace("smartbin_", "")
            file_path = Path(f"{hass.config.path('www/bins')}/{folder_id}/{filename}")
            if file_path.exists():
                await hass.async_add_executor_job(file_path.unlink)
                LOGGER.info("Deleted image file: %s", file_path)
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def update_item_service(call: ServiceCall) -> None:
        """Update an existing inventory item."""
        bin_id = call.data["bin_id"]
        item_name = call.data["item_name"].strip().lower()
        new_name = call.data.get("new_name")
        description = call.data.get("description")
        quantity = call.data.get("quantity")
        condition = call.data.get("condition")

        entry = _get_bin_entry(hass, bin_id)
        inventory = entry.get("inventory", {"items": []})
        items = inventory.get("items", [])

        for item in items:
            if str(item.get("name", "")).lower() == item_name:
                if new_name is not None:
                    item["name"] = new_name
                if description is not None:
                    item["description"] = description
                if quantity is not None:
                    item["quantity"] = quantity
                if condition is not None:
                    item["condition"] = condition
                break

        entry["inventory"] = inventory
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def add_item_service(call: ServiceCall) -> None:
        """Add a new item to inventory manually."""
        bin_id = call.data["bin_id"]
        item_name = call.data["item_name"]
        description = call.data.get("description", "")
        quantity = call.data.get("quantity", 1)
        condition = call.data.get("condition", "good")

        entry = _get_bin_entry(hass, bin_id)
        inventory = entry.get("inventory", {"items": []})
        items = inventory.get("items", [])

        # Check if item already exists
        found = False
        for item in items:
            if str(item.get("name", "")).lower() == item_name.lower():
                # Update existing item quantity
                item["quantity"] = item.get("quantity", 0) + quantity
                # Update description if provided
                if description:
                    item["description"] = description
                found = True
                break

        if not found:
            new_item = {
                "name": item_name,
                "quantity": quantity,
                "condition": condition
            }
            if description:
                new_item["description"] = description
            items.append(new_item)

        entry["inventory"] = inventory
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def clear_inventory_service(call: ServiceCall) -> None:
        """Clear all inventory items from a bin."""
        bin_id = call.data["bin_id"]
        entry = _get_bin_entry(hass, bin_id)
        entry["inventory"] = {"items": []}
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)

    async def clear_images_service(call: ServiceCall) -> None:
        """Clear all images from a bin."""
        bin_id = call.data["bin_id"]
        entry = _get_bin_entry(hass, bin_id)
        images = entry.get("images", [])

        # Delete physical files
        folder_id = bin_id.replace("smartbin_", "")
        for filename in images:
            file_path = Path(f"{hass.config.path('www/bins')}/{folder_id}/{filename}")
            if file_path.exists():
                await hass.async_add_executor_job(file_path.unlink)

        entry["images"] = []
        await _update_input_text_summaries(hass, bin_id, entry)
        await _save_and_refresh(hass)
        LOGGER.info("Cleared all images from %s", bin_id)

    async def search_items_service(call: ServiceCall) -> None:
        """Search for items across all bins."""
        query = call.data["query"].strip().lower()
        results = []

        data = hass.data[DOMAIN]["data"]
        bins = data.get("bins", {})

        for bin_id, entry in bins.items():
            inventory = entry.get("inventory", {"items": []})
            items = inventory.get("items", [])
            bin_name_state = hass.states.get(f"input_text.{bin_id}_name")
            bin_name = bin_name_state.state if bin_name_state else bin_id

            for item in items:
                item_name = str(item.get("name", ""))
                item_description = str(item.get("description", ""))
                # Search in both name and description
                if query in item_name.lower() or query in item_description.lower():
                    results.append({
                        "bin_id": bin_id,
                        "bin_name": bin_name,
                        "item_name": item_name,
                        "description": item_description,
                        "quantity": item.get("quantity", 0),
                        "condition": item.get("condition", "unknown")
                    })

        # Store results in a sensor attribute (we'll create this sensor)
        hass.states.async_set(
            "sensor.smartbin_ai_search_results",
            len(results),
            {
                "results": results,
                "query": query,
                "friendly_name": "Smart Bin Search Results"
            }
        )
        LOGGER.info("Search for '%s' found %d results", query, len(results))

    hass.services.async_register(
        DOMAIN,
        "append_image",
        append_image_service,
        schema=SERVICE_APPEND_IMAGE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "remove_item",
        remove_item_service,
        schema=SERVICE_REMOVE_ITEM_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "remove_image",
        remove_image_service,
        schema=SERVICE_REMOVE_IMAGE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "update_item",
        update_item_service,
        schema=SERVICE_UPDATE_ITEM_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "add_item",
        add_item_service,
        schema=SERVICE_ADD_ITEM_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "clear_inventory",
        clear_inventory_service,
        schema=SERVICE_CLEAR_INVENTORY_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "clear_images",
        clear_images_service,
        schema=SERVICE_CLEAR_IMAGES_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "search_items",
        search_items_service,
        schema=SERVICE_SEARCH_ITEMS_SCHEMA,
    )

    async def migrate_from_input_text(_event) -> None:
        changed = False
        for bin_id in DEFAULT_BINS:
            entry = _get_bin_entry(hass, bin_id)
            if entry.get("images") or entry.get("inventory", {}).get("items"):
                continue

            images_state = hass.states.get(f"input_text.{bin_id}_images")
            inventory_state = hass.states.get(f"input_text.{bin_id}_inventory")

            images = []
            if images_state and images_state.state not in ["unknown", "unavailable", ""]:
                images = [s for s in images_state.state.split(",") if s]

            inventory = {"items": []}
            if inventory_state and inventory_state.state not in ["unknown", "unavailable", ""]:
                try:
                    parsed = json.loads(inventory_state.state)
                    if isinstance(parsed, dict) and "items" in parsed:
                        inventory = parsed
                except json.JSONDecodeError:
                    pass

            if images or inventory.get("items"):
                entry["images"] = images
                entry["inventory"] = inventory
                await _update_input_text_summaries(hass, bin_id, entry)
                changed = True

        if changed:
            await _save_and_refresh(hass)

    async def sync_images_from_disk(_event) -> None:
        changed = False
        for bin_id in DEFAULT_BINS:
            entry = _get_bin_entry(hass, bin_id)
            folder_id = bin_id.replace("smartbin_", "")
            folder = Path(hass.config.path("www/bins")) / folder_id
            if not folder.exists():
                continue
            files = await hass.async_add_executor_job(_list_bin_images, folder)
            if entry.get("images") != files:
                entry["images"] = files
                await _update_input_text_summaries(hass, bin_id, entry)
                changed = True

        if changed:
            await _save_and_refresh(hass)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_START, migrate_from_input_text)
    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_START, sync_images_from_disk)

    return True
