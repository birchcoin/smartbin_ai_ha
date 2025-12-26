(() => {
  const BIN_IDS = [
    "smartbin_ai_001",
    "smartbin_ai_002",
    "smartbin_ai_003",
    "smartbin_ai_004",
    "smartbin_ai_005",
  ];
  const THEME_NAME = window.SMARTBIN_AI_DASHBOARD_THEME || "Dashboard";
  const app = document.getElementById("app");
  if (!app) {
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const debugEnabled = urlParams.get("debug") === "1";

  const uiState = {
    searchQuery: "",
    selectedBin: BIN_IDS[0],
    itemName: "",
    quantity: "1",
    condition: "good",
    newName: "",
    imageFilename: "",
    status: "",
    statusLevel: "neutral",
    binStatus: {},
    editingItem: null, // {binId, itemName, newName, description, quantity, condition}
    modalImageUrl: null,
    modalBbox: null, // [x, y, width, height] as percentages
    modalItemName: null,
    analysisLogExpanded: false,
    analysisLogContent: "",
  };

  const hassState = new Map();
  const hassDigest = new Map();
  let ws;
  let renderScheduled = false;
  let authed = false;
  let renderCount = 0;
  let wsOpenCount = 0;
  let wsCloseCount = 0;
  let wsMessageCount = 0;
  let debugEl;

  function updateDebugPanel() {
    if (!debugEnabled || !debugEl) {
      return;
    }
    const navEntry = performance.getEntriesByType("navigation")[0];
    const navType = navEntry ? navEntry.type : "unknown";
    debugEl.textContent =
      `debug on | renders ${renderCount} | ws open ${wsOpenCount} | ws close ${wsCloseCount} | ws msg ${wsMessageCount} | nav ${navType}`;
  }

  function initDebugPanel() {
    if (!debugEnabled) {
      return;
    }
    debugEl = document.createElement("div");
    debugEl.style.position = "fixed";
    debugEl.style.bottom = "12px";
    debugEl.style.right = "12px";
    debugEl.style.padding = "6px 10px";
    debugEl.style.borderRadius = "10px";
    debugEl.style.background = "rgba(0, 0, 0, 0.65)";
    debugEl.style.color = "#fff";
    debugEl.style.fontSize = "12px";
    debugEl.style.zIndex = "9999";
    debugEl.style.pointerEvents = "none";
    document.body.appendChild(debugEl);
    updateDebugPanel();
  }

  function isRelevantEntity(entityId) {
    return (
      entityId &&
      (entityId.startsWith("sensor.smartbin_ai_") ||
        entityId.startsWith("input_text.smartbin_ai_"))
    );
  }

  function extractRelevantData(entityId, state) {
    if (!entityId || !state) {
      return null;
    }
    if (entityId === "sensor.smartbin_ai_search_results") {
      return JSON.stringify({
        results: state.attributes?.results || [],
        query: state.attributes?.query || "",
      });
    }
    if (entityId.startsWith("sensor.smartbin_ai_") && entityId.endsWith("_data")) {
      return JSON.stringify({
        inventory: state.attributes?.inventory || {},
        images: state.attributes?.images || [],
      });
    }
    if (
      entityId.startsWith("sensor.smartbin_ai_") &&
      (entityId.endsWith("_item_count") || entityId.endsWith("_image_count"))
    ) {
      return JSON.stringify({ value: state.state });
    }
    if (entityId.startsWith("input_text.smartbin_ai_")) {
      return JSON.stringify({ value: state.state });
    }
    return JSON.stringify({
      state: state.state,
      attributes: state.attributes || {},
    });
  }

  function shouldUpdateEntity(entityId, state) {
    const digest = extractRelevantData(entityId, state);
    if (digest === null) {
      return false;
    }
    const previous = hassDigest.get(entityId);
    if (previous === digest) {
      return false;
    }
    hassDigest.set(entityId, digest);
    return true;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getAuthToken() {
    try {
      const tokens = localStorage.getItem("hassTokens");
      if (tokens) {
        return JSON.parse(tokens).access_token;
      }
    } catch (error) {
      console.warn("Storage token read failed", error);
    }
    return null;
  }

  function getAuthTokenFromHassContext(root) {
    try {
      const hass = root?.hass || root?.document?.querySelector("home-assistant")?.hass;
      return hass?.auth?.accessToken || null;
    } catch (error) {
      return null;
    }
  }

  const authToken =
    getAuthToken() ||
    getAuthTokenFromHassContext(window) ||
    getAuthTokenFromHassContext(window.parent);

  if (!authToken) {
    app.innerHTML = `
      <div class="card error">
        <h2>Authentication required</h2>
        <p>Open this panel from inside Home Assistant so it can access your auth token.</p>
      </div>
    `;
    return;
  }

  function getEntity(entityId) {
    return hassState.get(entityId);
  }

  function getState(entityId) {
    return getEntity(entityId)?.state;
  }

  function getAttr(entityId, key) {
    return getEntity(entityId)?.attributes?.[key];
  }

  function binName(binId) {
    return getState(`input_text.${binId}_name`) || binId;
  }

  function binFolder(binId) {
    return binId.replace("smartbin_", "");
  }

  function binInventory(binId) {
    const inventory = getAttr(`sensor.${binId}_data`, "inventory");
    if (inventory && typeof inventory === "object" && Array.isArray(inventory.items)) {
      return inventory.items;
    }
    return [];
  }

  function binImages(binId) {
    const images = getAttr(`sensor.${binId}_data`, "images");
    return Array.isArray(images) ? images : [];
  }

  function binItemCount(binId) {
    const count = getState(`sensor.${binId}_item_count`);
    return count ?? "0";
  }

  function binImageCount(binId) {
    const count = getState(`sensor.${binId}_image_count`);
    return count ?? "0";
  }

  function binHistory(binId) {
    const history = getAttr(`sensor.${binId}_data`, "history");
    return Array.isArray(history) ? history : [];
  }

  function binAnalysisStatus(binId) {
    const status = getAttr(`sensor.${binId}_data`, "analysis_status");
    return status && typeof status === "object" ? status : null;
  }

  function scheduleRender() {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function captureFocusState() {
    const active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.model) {
      return null;
    }
    const state = {
      model: active.dataset.model,
      type: active.tagName,
    };
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      state.selectionStart = active.selectionStart;
      state.selectionEnd = active.selectionEnd;
    }
    return state;
  }

  function restoreFocusState(state) {
    if (!state) {
      return;
    }
    const selector = `[data-model="${CSS.escape(state.model)}"]`;
    const target = app.querySelector(selector);
    if (!target) {
      return;
    }
    target.focus();
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      typeof state.selectionStart === "number" &&
      typeof state.selectionEnd === "number"
    ) {
      target.setSelectionRange(state.selectionStart, state.selectionEnd);
    }
  }

  function setStatus(message, level = "neutral") {
    uiState.status = message;
    uiState.statusLevel = level;
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status ${level}`;
    }
  }

  function setBinStatus(binId, message, level = "neutral") {
    uiState.binStatus[binId] = { message, level };
    const statusEl = document.getElementById(`bin-status-${binId}`);
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status ${level}`;
    }
  }

  async function callService(domain, service, data) {
    const response = await fetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data || {}),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Service call failed");
    }
    return response;
  }

  function updateSelectedBin(binId) {
    uiState.selectedBin = binId;
    if (binId !== "all") {
      callService("input_text", "set_value", {
        entity_id: "input_text.smartbin_ai_mgmt_selected_bin",
        value: binId,
      }).catch(() => {});
    }
    scheduleRender();
  }

  function actionHandlers() {
    const requireBin = (binId, actionLabel) => {
      if (binId === "all") {
        setStatus(`Select a bin before running "${actionLabel}".`, "warning");
        return null;
      }
      return binId;
    };
    return {
      "toggle-log": async () => {
        if (uiState.analysisLogExpanded) {
          uiState.analysisLogExpanded = false;
          scheduleRender();
          return;
        }

        uiState.analysisLogExpanded = true;
        uiState.analysisLogContent = "Loading...";
        scheduleRender();

        try {
          const response = await fetch("/api/smartbin_ai_upload/analysis_log", {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          });
          if (!response.ok) {
            const message = await response.text();
            throw new Error(message || "Log fetch failed");
          }
          const text = await response.text();
          uiState.analysisLogContent = text || "No log entries yet.";
        } catch (error) {
          uiState.analysisLogContent = `Error loading log: ${error.message}`;
        }
        scheduleRender();
      },
      "search": async () => {
        if (!uiState.searchQuery.trim()) {
          setStatus("Enter a search query first.", "warning");
          return;
        }
        setStatus("Searching...", "neutral");
        try {
          await callService("smartbin_ai_upload", "search_items", {
            query: uiState.searchQuery.trim(),
          });
          setStatus("Search completed.", "success");
        } catch (error) {
          setStatus(`Search failed: ${error.message}`, "error");
        }
      },
      "add-item": async (binId) => {
        const resolved = requireBin(binId, "Add Item");
        if (!resolved) {
          return;
        }
        if (!uiState.itemName.trim()) {
          setStatus("Item name is required.", "warning");
          return;
        }
        setStatus("Adding item...", "neutral");
        try {
          await callService("smartbin_ai_upload", "add_item", {
            bin_id: resolved,
            item_name: uiState.itemName.trim(),
            quantity: parseInt(uiState.quantity, 10) || 1,
            condition: uiState.condition || "good",
          });
          setStatus("Item added.", "success");
        } catch (error) {
          setStatus(`Add failed: ${error.message}`, "error");
        }
      },
      "update-item": async (binId) => {
        const resolved = requireBin(binId, "Update Item");
        if (!resolved) {
          return;
        }
        if (!uiState.itemName.trim()) {
          setStatus("Item name is required to update.", "warning");
          return;
        }
        const payload = {
          bin_id: resolved,
          item_name: uiState.itemName.trim(),
        };
        if (uiState.newName.trim()) {
          payload.new_name = uiState.newName.trim();
        }
        if (uiState.quantity.trim()) {
          payload.quantity = parseInt(uiState.quantity, 10) || 1;
        }
        if (uiState.condition.trim()) {
          payload.condition = uiState.condition.trim();
        }
        setStatus("Updating item...", "neutral");
        try {
          await callService("smartbin_ai_upload", "update_item", payload);
          setStatus("Item updated.", "success");
        } catch (error) {
          setStatus(`Update failed: ${error.message}`, "error");
        }
      },
      "remove-item": async (binId, itemName) => {
        const resolved = requireBin(binId, "Remove Item");
        if (!resolved) {
          return;
        }
        const name = (itemName || uiState.itemName).trim();
        if (!name) {
          setStatus("Item name is required to remove.", "warning");
          return;
        }
        setStatus("Removing item...", "neutral");
        try {
          await callService("smartbin_ai_upload", "remove_item", {
            bin_id: resolved,
            item_name: name,
          });
          setStatus("Item removed.", "success");
        } catch (error) {
          setStatus(`Remove failed: ${error.message}`, "error");
        }
      },
      "remove-last": async (binId) => {
        const resolved = requireBin(binId, "Remove Last");
        if (!resolved) {
          return;
        }
        setStatus("Removing last item...", "neutral");
        try {
          await callService("smartbin_ai_upload", "remove_item", {
            bin_id: resolved,
          });
          setStatus("Last item removed.", "success");
        } catch (error) {
          setStatus(`Remove failed: ${error.message}`, "error");
        }
      },
      "clear-inventory": async (binId) => {
        const resolved = requireBin(binId, "Clear Inventory");
        if (!resolved) {
          return;
        }
        if (!confirm("Clear all inventory from this bin?")) {
          return;
        }
        setStatus("Clearing inventory...", "neutral");
        try {
          await callService("smartbin_ai_upload", "clear_inventory", {
            bin_id: resolved,
          });
          setStatus("Inventory cleared.", "success");
        } catch (error) {
          setStatus(`Clear failed: ${error.message}`, "error");
        }
      },
      "clear-images": async (binId) => {
        const resolved = requireBin(binId, "Clear Images");
        if (!resolved) {
          return;
        }
        if (!confirm("Delete all photos from this bin?")) {
          return;
        }
        setStatus("Clearing images...", "neutral");
        try {
          await callService("smartbin_ai_upload", "clear_images", {
            bin_id: resolved,
          });
          setStatus("Images cleared.", "success");
        } catch (error) {
          setStatus(`Clear failed: ${error.message}`, "error");
        }
      },
      "remove-image": async (binId, filename) => {
        const resolved = requireBin(binId, "Remove Image");
        if (!resolved) {
          return;
        }
        const name = (filename || uiState.imageFilename).trim();
        if (!name) {
          setStatus("Image filename is required.", "warning");
          return;
        }
        setStatus("Removing image...", "neutral");
        try {
          await callService("smartbin_ai_upload", "remove_image", {
            bin_id: resolved,
            filename: name,
          });
          setStatus("Image removed.", "success");
        } catch (error) {
          setStatus(`Remove failed: ${error.message}`, "error");
        }
      },
      "analyze-all": async (binId) => {
        const resolved = requireBin(binId, "Analyze All");
        if (!resolved) {
          return;
        }
        const images = binImages(resolved);
        if (!images.length) {
          setStatus("No images to analyze.", "warning");
          return;
        }
        try {
          setBinStatus(resolved, `Analyzing 1 of ${images.length}...`, "neutral");
          for (let i = 0; i < images.length; i += 1) {
            const filename = images[i];
            const folder = binFolder(resolved);
            const imagePath = `/config/www/bins/${folder}/${filename}`;

            // Get existing inventory to pass to AI
            const inventory = binInventory(resolved);
            const existingItems = inventory.map(item => item.name);

            // Detect if this is an add or remove image based on filename
            const isRemove = filename.includes("_remove_");
            const serviceName = isRemove ? "analyze_and_remove" : "analyze_image";

            setBinStatus(
              resolved,
              `Analyzing ${i + 1} of ${images.length}...`,
              "neutral"
            );
            await callService("smartbin_ai_upload", serviceName, {
              bin_id: resolved,
              image_path: imagePath,
              bin_name: binName(resolved),
              existing_items: existingItems,
            });
          }
          setBinStatus(resolved, "Analysis complete.", "success");
        } catch (error) {
          setBinStatus(resolved, `Analyze failed: ${error.message}`, "error");
          setStatus(`Analyze failed: ${error.message}`, "error");
        }
      },
      "analyze-image": async (binId, filename) => {
        const resolved = requireBin(binId, "Analyze Image");
        if (!resolved) {
          return;
        }
        const name = (filename || "").trim();
        if (!name) {
          setStatus("Image filename is required to analyze.", "warning");
          return;
        }

        // Get existing inventory to pass to AI
        const inventory = binInventory(resolved);
        const existingItems = inventory.map(item => item.name);

        // Detect if this is an add or remove image based on filename
        const isRemove = name.includes("_remove_");
        const serviceName = isRemove ? "analyze_and_remove" : "analyze_image";

        const folder = binFolder(resolved);
        const imagePath = `/config/www/bins/${folder}/${name}`;
        setBinStatus(resolved, `Analyzing ${name}...`, "neutral");
        try {
          await callService("smartbin_ai_upload", serviceName, {
            bin_id: resolved,
            image_path: imagePath,
            bin_name: binName(resolved),
            existing_items: existingItems,
          });
          setBinStatus(resolved, `Analysis complete: ${name}`, "success");
        } catch (error) {
          setBinStatus(resolved, `Analyze failed: ${error.message}`, "error");
          setStatus(`Analyze failed: ${error.message}`, "error");
        }
      },
      "upload": (binId) => {
        const resolved = requireBin(binId, "Open Upload");
        if (!resolved) {
          return;
        }
        const url = `/local/smartbin_ai_upload.html?bin=${encodeURIComponent(resolved)}`;
        window.location.href = url;
      },
      "remove": (binId) => {
        const resolved = requireBin(binId, "Open Remove");
        if (!resolved) {
          return;
        }
        const url = `/smartbin_ai_upload/launch_remove?bin=${encodeURIComponent(resolved)}`;
        window.location.href = url;
      },
      "select-bin": (binId) => {
        updateSelectedBin(binId);
        setStatus(`Selected ${binName(binId)}.`, "neutral");
      },
      "edit-item": (binId, itemName) => {
        const resolved = requireBin(binId, "Edit Item");
        if (!resolved || !itemName) {
          return;
        }
        const items = binInventory(resolved);
        const item = items.find((i) => i.name === itemName);
        if (!item) {
          setStatus("Item not found.", "error");
          return;
        }
        uiState.editingItem = {
          binId: resolved,
          itemName: item.name,
          newName: item.name,
          description: item.description || "",
          quantity: String(item.quantity || 1),
          condition: item.condition || "good",
        };
        scheduleRender();
      },
      "save-edit": async () => {
        if (!uiState.editingItem) {
          return;
        }
        const { binId, itemName, newName, description, quantity, condition } = uiState.editingItem;
        setStatus("Saving changes...", "neutral");
        try {
          await callService("smartbin_ai_upload", "update_item", {
            bin_id: binId,
            item_name: itemName,
            new_name: newName !== itemName ? newName : undefined,
            description: description || undefined,
            quantity: parseInt(quantity, 10) || 1,
            condition: condition,
          });
          setStatus("Item updated.", "success");
          // Delay clearing edit state to allow websocket update to arrive
          setTimeout(() => {
            uiState.editingItem = null;
            scheduleRender();
          }, 800);
        } catch (error) {
          setStatus(`Save failed: ${error.message}`, "error");
        }
      },
      "cancel-edit": () => {
        uiState.editingItem = null;
        scheduleRender();
      },
      "show-image": (binId, filename) => {
        if (!filename) {
          return;
        }
        const folder = binFolder(binId);
        const src = `/local/bins/${folder}/${encodeURIComponent(filename)}`;
        uiState.modalImageUrl = src;
        uiState.modalBbox = null;
        scheduleRender();
      },
      "show-item-image": (binId, itemName) => {
        const resolved = requireBin(binId, "Show Item Image");
        if (!resolved || !itemName) {
          return;
        }
        const items = binInventory(resolved);
        const item = items.find((i) => i.name === itemName);
        if (!item || !item.image_filename || !item.bbox) {
          setStatus("No image data for this item.", "warning");
          return;
        }
        const folder = binFolder(resolved);
        const src = `/local/bins/${folder}/${encodeURIComponent(item.image_filename)}`;
        uiState.modalImageUrl = src;
        uiState.modalBbox = item.bbox;
        uiState.modalItemName = item.name;
        scheduleRender();
      },
      "close-modal": () => {
        uiState.modalImageUrl = null;
        uiState.modalBbox = null;
        uiState.modalItemName = null;
        scheduleRender();
      },
    };
  }

  function bindEvents() {
    app.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }
      const model = target.dataset.model;
      if (!model) {
        return;
      }
      // Handle editing item state
      if (model.startsWith("editingItem.")) {
        const field = model.split(".")[1];
        if (uiState.editingItem) {
          uiState.editingItem[field] = target.value;
        }
      } else {
        uiState[model] = target.value;
      }
    });

    app.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) {
        return;
      }
      const model = target.dataset.model;
      if (!model) {
        return;
      }
      // Handle editing item state
      if (model.startsWith("editingItem.")) {
        const field = model.split(".")[1];
        if (uiState.editingItem) {
          uiState.editingItem[field] = target.value;
        }
      } else {
        uiState[model] = target.value;
        if (model === "selectedBin") {
          updateSelectedBin(target.value);
        }
      }
    });

    app.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      const binId = button.dataset.bin || uiState.selectedBin;
      const itemName = button.dataset.itemName;
      const filename = button.dataset.filename;
      const handlers = actionHandlers();
      const handler = handlers[action];
      if (handler) {
        if (button.tagName === "A") {
          event.preventDefault();
        }
        handler(binId, itemName || filename);
      }
    });
  }

  function renderSearchResults() {
    const results = getAttr("sensor.smartbin_ai_search_results", "results") || [];
    const query =
      getAttr("sensor.smartbin_ai_search_results", "query") || uiState.searchQuery;
    if (!results.length) {
      return `<p class="muted">No results yet. Run a search to see matches.</p>`;
    }
    const rows = results
      .map(
        (result) => `
          <tr>
            <td><a href="#" data-action="select-bin" data-bin="${escapeHtml(
              result.bin_id
            )}">${escapeHtml(result.bin_name || result.bin_id)}</a></td>
            <td>${escapeHtml(result.item_name)}</td>
            <td>${escapeHtml(result.description || "")}</td>
            <td>${escapeHtml(result.quantity)}</td>
            <td>${escapeHtml(result.condition)}</td>
          </tr>`
      )
      .join("");
    return `
      <div class="search-results">
        <p class="muted">Found ${results.length} result(s) for "${escapeHtml(query)}".</p>
        <table class="table">
          <thead>
            <tr>
              <th>Bin</th>
              <th>Item</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Condition</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderInventory(binId) {
    const items = binInventory(binId);
    if (!items.length) {
      return `<p class="muted">No items in inventory.</p>`;
    }
    // Sort items alphabetically by name (case-insensitive)
    const sortedItems = [...items].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    if (debugEnabled) {
      console.groupCollapsed(`BBOX inventory: ${binId} (${sortedItems.length} items)`);
      sortedItems.forEach((item) => {
        console.log({
          name: item.name,
          bbox: item.bbox,
          bboxes: item.bboxes,
          image_filename: item.image_filename,
        });
      });
      console.groupEnd();
    }
    const rows = sortedItems
      .map((item) => {
        const isEditing =
          uiState.editingItem &&
          uiState.editingItem.binId === binId &&
          uiState.editingItem.itemName === item.name;

        if (isEditing) {
          return `
            <tr class="editing-row">
              <td>
                <input class="input-inline" type="text" data-model="editingItem.newName" value="${escapeHtml(uiState.editingItem.newName)}">
              </td>
              <td>
                <input class="input-inline" type="text" data-model="editingItem.description" value="${escapeHtml(uiState.editingItem.description)}" placeholder="color, brand, details...">
              </td>
              <td>
                <input class="input-inline" type="number" min="1" data-model="editingItem.quantity" value="${escapeHtml(uiState.editingItem.quantity)}">
              </td>
              <td>
                <select class="select-inline" data-model="editingItem.condition">
                  <option value="good" ${uiState.editingItem.condition === "good" ? "selected" : ""}>good</option>
                  <option value="fair" ${uiState.editingItem.condition === "fair" ? "selected" : ""}>fair</option>
                  <option value="needs replacement" ${uiState.editingItem.condition === "needs replacement" ? "selected" : ""}>needs replacement</option>
                </select>
              </td>
              <td>
                <button class="btn ghost small" data-action="save-edit">Save</button>
                <button class="btn ghost small" data-action="cancel-edit">Cancel</button>
              </td>
            </tr>
          `;
        }

        // Make name clickable if item has image and bbox
        let nameCell;
        if (item.image_filename && item.bbox) {
          nameCell = `<a href="#" class="item-link" data-action="show-item-image" data-bin="${binId}" data-item-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</a>`;
        } else {
          nameCell = escapeHtml(item.name);
        }

        return `
          <tr>
            <td>${nameCell}</td>
            <td>${escapeHtml(item.description || "")}</td>
            <td>${escapeHtml(item.quantity)}</td>
            <td>${escapeHtml(item.condition)}</td>
            <td>
              <button class="btn ghost small" data-action="edit-item" data-bin="${binId}" data-item-name="${escapeHtml(item.name)}">Edit</button>
              <button class="btn ghost small" data-action="remove-item" data-bin="${binId}" data-item-name="${escapeHtml(item.name)}">Remove</button>
            </td>
          </tr>
        `;
      })
      .join("");
    return `
      <table class="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Description</th>
            <th>Qty</th>
            <th>Condition</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderImages(binId) {
    const images = binImages(binId);
    if (!images.length) {
      return `<p class="muted">No photos available.</p>`;
    }
    const folder = binFolder(binId);
    const entries = images
      .map((image) => {
        const src = `/local/bins/${folder}/${encodeURIComponent(image)}`;
        return `
          <div class="image-row">
            <img class="thumb clickable" src="${src}" alt="${escapeHtml(image)}" loading="lazy" data-action="show-image" data-bin="${binId}" data-filename="${escapeHtml(image)}">
            <div class="image-meta">
              <div class="filename">${escapeHtml(image)}</div>
              <button class="btn ghost small" data-action="remove-image" data-bin="${binId}" data-filename="${escapeHtml(
                image
              )}">Remove</button>
              <button class="btn ghost small" data-action="analyze-image" data-bin="${binId}" data-filename="${escapeHtml(
                image
              )}">Analyze</button>
            </div>
          </div>
        `;
      })
      .join("");
    return `<div class="image-list">${entries}</div>`;
  }

  function renderHistory(binId) {
    const history = binHistory(binId);
    if (history.length === 0) {
      return '<p class="muted">No history yet.</p>';
    }
    // Reverse to show newest first
    const entries = [...history].reverse()
      .map((entry) => {
        const timestamp = new Date(entry.timestamp);
        const dateStr = timestamp.toLocaleDateString();
        const timeStr = timestamp.toLocaleTimeString();
        const actionClass = entry.action === 'add' ? 'action-add' : 'action-remove';
        const actionSymbol = entry.action === 'add' ? '➕' : '➖';
        const items = entry.items || [];
        const itemsText = items.map(item =>
          `${item.name} (×${item.quantity})`
        ).join(', ');

        return `
          <div class="history-entry">
            <div class="history-header">
              <span class="history-action ${actionClass}">${actionSymbol} ${escapeHtml(entry.action.toUpperCase())}</span>
              <span class="history-time">${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</span>
            </div>
            <div class="history-items">${escapeHtml(itemsText)}</div>
            ${entry.image_filename ? `<div class="history-image">📷 ${escapeHtml(entry.image_filename)}</div>` : ''}
          </div>
        `;
      })
      .join("");
    return `<div class="history-list">${entries}</div>`;
  }

  function renderBinCard(binId) {
    const binStatus = uiState.binStatus[binId];
    const analysis = binAnalysisStatus(binId);
    let analysisClass = "analysis-idle";
    if (analysis?.state === "deep_pending" || analysis?.state === "deep_running" || analysis?.state === "quick_running") {
      analysisClass = "analysis-pending";
    } else if (analysis?.state === "deep_done") {
      analysisClass = "analysis-done";
    } else if (analysis?.state === "error") {
      analysisClass = "analysis-error";
    }
    const analysisNotice = analysis?.message
      ? `<div class="analysis-notice ${analysisClass}">${escapeHtml(analysis.message)}</div>`
      : "";
    return `
      <div class="card bin-card">
        <div class="card-head">
          <div>
            <h3>${escapeHtml(binName(binId))}</h3>
            <div class="meta">${escapeHtml(binId)}</div>
          </div>
          <div class="stat">
            <span>${escapeHtml(binItemCount(binId))} items</span>
            <span>${escapeHtml(binImageCount(binId))} photos</span>
          </div>
        </div>
        <div id="bin-status-${binId}" class="status ${escapeHtml(
          binStatus?.level || "neutral"
        )}">${escapeHtml(binStatus?.message || "Ready.")}</div>
        ${analysisNotice}
        <div class="meta">
          <a href="#" data-action="toggle-log">
            ${uiState.analysisLogExpanded ? '▼' : '▶'} Analysis log
          </a>
        </div>
        ${uiState.analysisLogExpanded ? `
          <div class="analysis-log">
            <pre>${escapeHtml(uiState.analysisLogContent)}</pre>
          </div>
        ` : ''}
        <div class="bin-actions">
          <button class="btn ghost" data-action="select-bin" data-bin="${binId}">Manage</button>
          <button class="btn" data-action="upload" data-bin="${binId}">Upload</button>
          <button class="btn danger" data-action="remove" data-bin="${binId}">Remove</button>
          <button class="btn" data-action="analyze-all" data-bin="${binId}">Analyze All</button>
          <button class="btn danger ghost" data-action="remove-last" data-bin="${binId}">Remove Last</button>
        </div>
        <div class="bin-body">
          <div>
            <h4>Inventory</h4>
            ${renderInventory(binId)}
          </div>
          <div>
            <h4>Images</h4>
            ${renderImages(binId)}
          </div>
          <div>
            <h4>History</h4>
            ${renderHistory(binId)}
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    const availableBins = BIN_IDS.filter((binId) => {
      return getEntity(`sensor.${binId}_data`) || getEntity(`input_text.${binId}_name`);
    });
    if (!availableBins.length) {
      app.innerHTML = `<div class="card"><h2>No bins found.</h2></div>`;
      return;
    }
    const selectedFromState = getState("input_text.smartbin_ai_mgmt_selected_bin");
    if (
      uiState.selectedBin !== "all" &&
      selectedFromState &&
      availableBins.includes(selectedFromState)
    ) {
      uiState.selectedBin = selectedFromState;
    } else if (!availableBins.includes(uiState.selectedBin) && uiState.selectedBin !== "all") {
      uiState.selectedBin = availableBins[0];
    }

    const binOptions = [
      `<option value="all" ${uiState.selectedBin === "all" ? "selected" : ""}>All</option>`,
      ...availableBins
        .map(
          (binId) => `
          <option value="${binId}" ${
            binId === uiState.selectedBin ? "selected" : ""
          }>${escapeHtml(binName(binId))}</option>`
        )
    ]
      .join("");

    const focusedBinId = uiState.selectedBin;
    const binCards =
      focusedBinId === "all"
        ? availableBins.map(renderBinCard).join("")
        : focusedBinId
          ? renderBinCard(focusedBinId)
          : "";

    const focusState = captureFocusState();
    renderCount += 1;
    app.innerHTML = `
      <div class="hero">
        <div>
          <div class="eyebrow">Smart Bin Management</div>
          <h1>${escapeHtml(THEME_NAME)} Command Center</h1>
          <p class="sub">Live inventory, image control, and search across every bin.</p>
          <p class="notice">Quick scan results appear first. Deep analysis refines inventory after a longer pass.</p>
        </div>
        <div id="status" class="status ${escapeHtml(uiState.statusLevel)}">${
          escapeHtml(uiState.status) || "Ready."
        }</div>
      </div>

      <div class="layout">
        <section class="card">
          <h2>Search Inventory</h2>
          <p class="muted">Search across all bins and see matches immediately.</p>
          <div class="row">
            <input class="input" type="text" placeholder="Search item name" data-model="searchQuery" value="${escapeHtml(
              uiState.searchQuery
            )}">
            <button class="btn" data-action="search">Search</button>
          </div>
          ${renderSearchResults()}
        </section>

        <section class="card">
          <h2>Quick Actions</h2>
          <p class="muted">Apply updates to the selected bin.</p>
          <div class="stack">
            <label class="label">Selected Bin</label>
            <select class="select" data-model="selectedBin">${binOptions}</select>
          </div>
          <div class="grid-2">
            <div class="stack">
              <label class="label">Item Name</label>
              <input class="input" type="text" data-model="itemName" placeholder="e.g. Canned beans" value="${escapeHtml(
                uiState.itemName
              )}">
            </div>
            <div class="stack">
              <label class="label">New Name (optional)</label>
              <input class="input" type="text" data-model="newName" placeholder="Rename item" value="${escapeHtml(
                uiState.newName
              )}">
            </div>
            <div class="stack">
              <label class="label">Quantity</label>
              <input class="input" type="number" min="1" data-model="quantity" value="${escapeHtml(
                uiState.quantity
              )}">
            </div>
            <div class="stack">
              <label class="label">Condition</label>
              <select class="select" data-model="condition">
                <option value="good" ${
                  uiState.condition === "good" ? "selected" : ""
                }>good</option>
                <option value="fair" ${
                  uiState.condition === "fair" ? "selected" : ""
                }>fair</option>
                <option value="needs replacement" ${
                  uiState.condition === "needs replacement" ? "selected" : ""
                }>needs replacement</option>
              </select>
            </div>
          </div>
          <div class="row actions">
            <button class="btn" data-action="add-item">Add Item</button>
            <button class="btn ghost" data-action="update-item">Update Item</button>
            <button class="btn danger" data-action="remove-item">Remove Item</button>
            <button class="btn danger ghost" data-action="remove-last">Remove Last</button>
          </div>
          <div class="stack">
            <label class="label">Image Filename</label>
            <input class="input" type="text" data-model="imageFilename" placeholder="Exact filename to remove" value="${escapeHtml(
              uiState.imageFilename
            )}">
          </div>
          <div class="row actions">
            <button class="btn ghost" data-action="remove-image">Remove Image</button>
            <button class="btn ghost" data-action="analyze-all">Analyze All</button>
            <button class="btn ghost" data-action="upload">Open Upload</button>
          </div>
          <div class="row actions">
            <button class="btn danger" data-action="clear-inventory">Clear Inventory</button>
            <button class="btn danger" data-action="clear-images">Clear Images</button>
          </div>
        </section>
      </div>

      <section class="bins">
        <h2>${focusedBinId === "all" ? "All Bins" : "Focused Bin"}</h2>
        <div class="bins-grid">
          ${binCards}
        </div>
      </section>

      ${
        uiState.modalImageUrl
          ? `
        <div class="modal-overlay" data-action="close-modal">
          <div class="modal-content">
            <button class="modal-close" data-action="close-modal">&times;</button>
            ${uiState.modalItemName ? `<div class="modal-item-label">${escapeHtml(uiState.modalItemName)}</div>` : ''}
            <div class="modal-image-container" id="modal-image-container">
              <img class="modal-image" id="modal-image" src="${uiState.modalImageUrl}" alt="Full size image">
              ${uiState.modalBbox ? '<svg class="modal-bbox-overlay" id="modal-bbox-svg"></svg>' : ''}
            </div>
          </div>
        </div>
      `
          : ""
      }
    `;
    restoreFocusState(focusState);
    updateDebugPanel();

    // Draw bounding box if modal is open with bbox data
    if (uiState.modalImageUrl && uiState.modalBbox) {
      requestAnimationFrame(() => {
        const img = document.getElementById('modal-image');
        const svg = document.getElementById('modal-bbox-svg');
        if (img && svg) {
          const drawBbox = () => {
            const container = document.getElementById('modal-image-container');
            const imgRect = img.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const [x, y, width, height] = uiState.modalBbox;

            // DEBUG: Log all values
            console.log('=== BBOX DEBUG ===');
            console.log('Original bbox:', uiState.modalBbox);
            console.log('Image natural size:', img.naturalWidth, 'x', img.naturalHeight);
            console.log('Image displayed size:', imgRect.width, 'x', imgRect.height);
            console.log('Container rect:', containerRect);
            console.log('Image rect:', imgRect);

            // Bbox coords are now in absolute pixels on the original image
            const bboxX = x;
            const bboxY = y;
            const bboxW = width;
            const bboxH = height;

            // Scale to displayed size
            const scaleX = imgRect.width / img.naturalWidth;
            const scaleY = imgRect.height / img.naturalHeight;

            console.log('Scale factors:', scaleX, scaleY);

            const displayX = bboxX * scaleX;
            const displayY = bboxY * scaleY;
            const displayW = bboxW * scaleX;
            const displayH = bboxH * scaleY;

            console.log('Scaled bbox:', displayX, displayY, displayW, displayH);

            // Position SVG to match image position within container
            const offsetX = imgRect.left - containerRect.left;
            const offsetY = imgRect.top - containerRect.top;

            console.log('SVG offset:', offsetX, offsetY);
            console.log('Final rect position:', displayX, displayY, displayW, displayH);

            // Set SVG size and position to match image exactly
            svg.setAttribute('width', imgRect.width);
            svg.setAttribute('height', imgRect.height);
            svg.setAttribute('viewBox', `0 0 ${imgRect.width} ${imgRect.height}`);
            svg.style.left = `${offsetX}px`;
            svg.style.top = `${offsetY}px`;

            // Draw rectangle
            svg.innerHTML = `
              <rect
                x="${displayX}"
                y="${displayY}"
                width="${displayW}"
                height="${displayH}"
                fill="none"
                stroke="#ff8f2b"
                stroke-width="3"
                stroke-dasharray="5,5"
              />
            `;
          };

          if (img.complete) {
            drawBbox();
          } else {
            img.addEventListener('load', drawBbox, { once: true });
          }

          // Redraw on window resize to keep alignment
          const resizeHandler = () => drawBbox();
          window.addEventListener('resize', resizeHandler);

          // Clean up resize listener when modal closes
          const modalOverlay = document.querySelector('.modal-overlay');
          if (modalOverlay) {
            const closeHandler = () => {
              window.removeEventListener('resize', resizeHandler);
            };
            modalOverlay.addEventListener('click', closeHandler, { once: true });
          }
        }
      });
    }
  }

  function connectWebsocket() {
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/websocket`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      wsOpenCount += 1;
      updateDebugPanel();
    });

    ws.addEventListener("message", (event) => {
      wsMessageCount += 1;
      updateDebugPanel();
      const data = JSON.parse(event.data);
      if (data.type === "ping") {
        ws.send(
          JSON.stringify({
            type: "pong",
            id: data.id,
          })
        );
        return;
      }
      if (data.type === "auth_required") {
        ws.send(
          JSON.stringify({
            type: "auth",
            access_token: authToken,
          })
        );
        return;
      }
      if (data.type === "auth_ok") {
        authed = true;
        ws.send(JSON.stringify({ id: 1, type: "get_states" }));
        ws.send(
          JSON.stringify({
            id: 2,
            type: "subscribe_events",
            event_type: "state_changed",
          })
        );
        return;
      }
      if (data.type === "result" && data.id === 1 && data.success) {
        data.result.forEach((state) => {
          if (isRelevantEntity(state.entity_id) && shouldUpdateEntity(state.entity_id, state)) {
            hassState.set(state.entity_id, state);
          }
        });
        scheduleRender();
        return;
      }
      if (data.type === "event" && data.event?.data?.new_state) {
        const newState = data.event.data.new_state;
        if (
          isRelevantEntity(newState.entity_id) &&
          shouldUpdateEntity(newState.entity_id, newState)
        ) {
          hassState.set(newState.entity_id, newState);
          scheduleRender();
        }
      }
    });

    ws.addEventListener("close", () => {
      const wasAuthed = authed;
      authed = false;
      wsCloseCount += 1;
      updateDebugPanel();
      if (wasAuthed) {
        setStatus("Connection lost. Reconnecting...", "warning");
      }
      setTimeout(connectWebsocket, 3000);
    });
  }

  bindEvents();
  render();
  initDebugPanel();
  connectWebsocket();
})();
