(() => {
  const THEME_NAME = window.SMARTBIN_AI_DASHBOARD_THEME || "Dashboard";
  const app = document.getElementById("app");
  if (!app) {
    return;
  }
  const SELECTED_BIN_STORAGE_KEY = "smartbin_ai_selected_bin";

  const urlParams = new URLSearchParams(window.location.search);
  const debugEnabled = urlParams.get("debug") === "1";

  // Get bin from URL parameter if provided
  const binFromUrl = urlParams.get("bin");
  const initialBin = binFromUrl || "";

  const uiState = {
    searchQuery: "",
    selectedBin: initialBin,
    itemName: "",
    quantity: "1",
    condition: "good",
    newName: "",
    newBinName: "",
    newBinId: "",
    imageFilename: "",
    status: "",
    statusLevel: "neutral",
    binStatus: {},
    bins: {},
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
      (entityId === "sensor.smartbin_ai_search_results" ||
        entityId.startsWith("sensor.smartbin_") ||
        entityId.startsWith("sensor.smart_bin_") ||
        entityId.startsWith("input_text.smartbin_") ||
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
    if (
      (entityId.startsWith("sensor.smartbin_") ||
        entityId.startsWith("sensor.smart_bin_")) &&
      entityId.endsWith("_data")
    ) {
      return JSON.stringify({
        inventory: state.attributes?.inventory || {},
        images: state.attributes?.images || [],
      });
    }
    if (
      (entityId.startsWith("sensor.smartbin_") ||
        entityId.startsWith("sensor.smart_bin_")) &&
      (entityId.endsWith("_item_count") || entityId.endsWith("_image_count"))
    ) {
      return JSON.stringify({ value: state.state });
    }
    if (
      entityId.startsWith("input_text.smartbin_") ||
      entityId.startsWith("input_text.smartbin_ai_")
    ) {
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

  async function loadConfig() {
    try {
      const response = await fetch("/api/smartbin_ai/config", {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        throw new Error("Failed to load bin config");
      }
      const data = await response.json();
      uiState.bins = data.bins || {};
      const bins = availableBins();
      let nextSelected = uiState.selectedBin;
      let storedSelected = "";
      try {
        storedSelected = localStorage.getItem(SELECTED_BIN_STORAGE_KEY) || "";
      } catch (error) {
        storedSelected = "";
      }
      if (binFromUrl && bins.includes(binFromUrl)) {
        nextSelected = binFromUrl;
      } else if (nextSelected && bins.includes(nextSelected)) {
        // keep current selection
      } else if (storedSelected && bins.includes(storedSelected)) {
        nextSelected = storedSelected;
      } else if (data.active_bin && bins.includes(data.active_bin)) {
        nextSelected = data.active_bin;
      } else if (bins.length) {
        nextSelected = bins[0];
      } else {
        nextSelected = "all";
      }
      uiState.selectedBin = nextSelected;
      scheduleRender();
    } catch (error) {
      setStatus(`Failed to load bins: ${error.message}`, "error");
    }
  }

  async function updateConfig(payload) {
    const response = await fetch("/api/smartbin_ai/config", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Config update failed");
    }
    await loadConfig();
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

  function resolveBinEntityId(binId, suffix) {
    const direct = `sensor.${binId}_${suffix}`;
    if (hassState.has(direct)) {
      return direct;
    }
    const altBinId = binId.replace("smartbin_", "smart_bin_");
    const alternate = `sensor.${altBinId}_${suffix}`;
    if (hassState.has(alternate)) {
      return alternate;
    }
    return direct;
  }

  function binName(binId) {
    const name = uiState.bins?.[binId]?.name;
    if (name) {
      return name;
    }
    const binNum = binId.replace("smartbin_", "");
    return `SmartBin ${binNum}`;
  }

  function sortedBinIds(bins) {
    return Object.keys(bins || {}).sort((a, b) => {
      const aNum = parseInt(a.replace("smartbin_", ""), 10);
      const bNum = parseInt(b.replace("smartbin_", ""), 10);
      if (Number.isNaN(aNum) || Number.isNaN(bNum)) {
        return a.localeCompare(b);
      }
      return aNum - bNum;
    });
  }

  function availableBins() {
    return sortedBinIds(uiState.bins);
  }

  function normalizeBinId(value) {
    if (!value) {
      return "";
    }
    const trimmed = String(value).trim();
    if (trimmed.startsWith("smartbin_")) {
      return trimmed;
    }
    const digits = trimmed.replace(/[^\d]/g, "");
    if (!digits) {
      return "";
    }
    return `smartbin_${digits.padStart(3, "0")}`;
  }

  function nextBinId() {
    const ids = availableBins();
    const taken = new Set(
      ids
        .map((id) => parseInt(id.replace("smartbin_", ""), 10))
        .filter((num) => !Number.isNaN(num))
    );
    let next = 1;
    while (taken.has(next)) {
      next += 1;
    }
    return `smartbin_${String(next).padStart(3, "0")}`;
  }

  function binFolder(binId) {
    return binId.replace("smartbin_", "");
  }

  function binInventory(binId) {
    const inventory = getAttr(resolveBinEntityId(binId, "data"), "inventory");
    if (inventory && typeof inventory === "object" && Array.isArray(inventory.items)) {
      return inventory.items;
    }
    return [];
  }

  function binImages(binId) {
    const images = getAttr(resolveBinEntityId(binId, "data"), "images");
    return Array.isArray(images) ? images : [];
  }

  function binItemCount(binId) {
    const count =
      getAttr(resolveBinEntityId(binId, "data"), "item_count") ??
      getState(resolveBinEntityId(binId, "item_count"));
    return count ?? "0";
  }

  function binImageCount(binId) {
    const count =
      getAttr(resolveBinEntityId(binId, "data"), "image_count") ??
      getState(resolveBinEntityId(binId, "image_count"));
    return count ?? "0";
  }

  function binHistory(binId) {
    const history = getAttr(resolveBinEntityId(binId, "data"), "history");
    return Array.isArray(history) ? history : [];
  }

  function binAnalysisStatus(binId) {
    const status = getAttr(resolveBinEntityId(binId, "data"), "analysis_status");
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
    try {
      if (binId) {
        localStorage.setItem(SELECTED_BIN_STORAGE_KEY, binId);
      }
    } catch (error) {
      // Ignore storage failures in restricted contexts.
    }
    if (binId && binId !== "all") {
      updateConfig({ active_bin: binId }).catch((error) => {
        setStatus(`Failed to save active bin: ${error.message}`, "warning");
      });
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
          const response = await fetch("/api/smartbin_ai/analysis_log", {
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
          await callService("smartbin_ai", "search_items", {
            query: uiState.searchQuery.trim(),
          });
          setStatus("Search completed.", "success");
        } catch (error) {
          setStatus(`Search failed: ${error.message}`, "error");
        }
      },
      "add-bin": async () => {
        const nameInput = uiState.newBinName.trim();
        const idInput = normalizeBinId(uiState.newBinId);
        const binId = idInput || nextBinId();
        if (availableBins().includes(binId)) {
          setStatus(`Bin ${binId} already exists.`, "warning");
          return;
        }
        const name = nameInput || `SmartBin ${binId.replace("smartbin_", "")}`;
        setStatus(`Adding ${name}...`, "neutral");
        try {
          await updateConfig({
            add_bins: [{ id: binId, name }],
            active_bin: binId,
          });
          uiState.newBinName = "";
          uiState.newBinId = "";
          setStatus(`Added ${name}.`, "success");
        } catch (error) {
          setStatus(`Add bin failed: ${error.message}`, "error");
        }
      },
      "remove-bin": async (binId) => {
        const resolved = requireBin(binId, "Remove Bin");
        if (!resolved) {
          return;
        }
        if (!confirm(`Remove ${binName(resolved)}? This hides the bin from the UI.`)) {
          return;
        }
        setStatus(`Removing ${binName(resolved)}...`, "neutral");
        try {
          await updateConfig({
            remove_bins: [resolved],
          });
          setStatus(`Removed ${binName(resolved)}.`, "success");
        } catch (error) {
          setStatus(`Remove bin failed: ${error.message}`, "error");
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
          await callService("smartbin_ai", "add_item", {
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
          await callService("smartbin_ai", "update_item", payload);
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
          await callService("smartbin_ai", "remove_item", {
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
          await callService("smartbin_ai", "remove_item", {
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
          await callService("smartbin_ai", "clear_inventory", {
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
          await callService("smartbin_ai", "clear_images", {
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
          await callService("smartbin_ai", "remove_image", {
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
            await callService("smartbin_ai", serviceName, {
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
          await callService("smartbin_ai", serviceName, {
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
        const url = `/smartbin_ai/launch?bin=${encodeURIComponent(resolved)}`;
        window.location.href = url;
      },
      "remove": (binId) => {
        const resolved = requireBin(binId, "Open Remove");
        if (!resolved) {
          return;
        }
        const url = `/smartbin_ai/launch_remove?bin=${encodeURIComponent(resolved)}`;
        window.location.href = url;
      },
      "nfc-tag": (binId) => {
        const resolved = requireBin(binId, "Generate NFC Tag");
        if (!resolved) {
          return;
        }
        showNFCModal(resolved);
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
          await callService("smartbin_ai", "update_item", {
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

  function showNFCModal(binId) {
    const baseUrl = window.location.origin;
    const uploadUrl = `${baseUrl}/smartbin_ai/launch?bin=${binId}`;
    const removeUrl = `${baseUrl}/smartbin_ai/launch_remove?bin=${binId}`;

    // Check if Web NFC is supported
    const nfcSupported = 'NDEFReader' in window;

    // Detect iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const modalHtml = `
      <div class="modal-overlay" id="nfcModal" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.9); display: flex; align-items: center; justify-content: center; z-index: 10000;">
        <div class="nfc-modal-content" style="background: var(--panel); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border); border-radius: 20px; padding: 32px; max-width: 600px; width: 90%; box-shadow: var(--shadow), 0 0 60px rgba(255, 102, 0, 0.2);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <h2 style="margin: 0; color: var(--accent); font-family: var(--font-display); text-transform: uppercase; letter-spacing: -0.02em;">NFC Tag Generator</h2>
            <button class="btn ghost small" onclick="document.getElementById('nfcModal').remove()" style="font-size: 24px; padding: 4px 12px;">×</button>
          </div>

          <div style="margin-bottom: 24px;">
            <div style="font-size: 14px; color: var(--muted); margin-bottom: 16px;">
              <strong style="color: var(--text);">Bin:</strong> ${escapeHtml(binName(binId))} (${escapeHtml(binId)})
            </div>

            <div style="margin-bottom: 16px;">
              <label style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 8px;">Tag Mode</label>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <button class="mode-select-btn" data-mode="upload" onclick="selectNFCMode('upload')" style="padding: 16px; border: 2px solid var(--accent); border-radius: 12px; background: rgba(255, 102, 0, 0.15); color: var(--accent); font-weight: 700; cursor: pointer; font-family: var(--font-display); text-transform: uppercase;">
                  ➕ Add Items
                </button>
                <button class="mode-select-btn" data-mode="remove" onclick="selectNFCMode('remove')" style="padding: 16px; border: 2px solid var(--border); border-radius: 12px; background: transparent; color: var(--text); font-weight: 700; cursor: pointer; font-family: var(--font-display); text-transform: uppercase;">
                  ➖ Remove Items
                </button>
              </div>
            </div>

            <div style="background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 12px; margin-bottom: 16px;">
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 8px;">URL TO WRITE</div>
              <div id="nfcUrlDisplay" style="font-family: monospace; font-size: 13px; color: var(--accent-2); word-break: break-all;">${escapeHtml(uploadUrl)}</div>
              <button class="btn ghost small" onclick="copyNFCUrl()" style="margin-top: 12px; width: 100%;">📋 Copy URL</button>
            </div>

            ${isIOS ? `
              <div style="background: rgba(255, 143, 43, 0.15); border: 2px solid var(--accent); padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                <div style="display: flex; align-items: start; gap: 12px; margin-bottom: 16px;">
                  <div style="font-size: 32px;">📱</div>
                  <div>
                    <div style="font-weight: 700; font-size: 16px; color: var(--accent); margin-bottom: 8px; font-family: var(--font-display); text-transform: uppercase;">iPhone Users: Follow These Steps</div>
                    <div style="font-size: 14px; color: var(--text); line-height: 1.6;">
                      Apple doesn't allow websites to write NFC tags. You'll need a free app from the App Store.
                    </div>
                  </div>
                </div>

                <div style="background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                  <div style="font-weight: 700; margin-bottom: 12px; color: var(--accent-2); font-size: 14px;">📲 STEP 1: Download a FREE NFC App</div>
                  <div style="font-size: 13px; color: var(--text); margin-bottom: 8px;">Open the App Store and download one of these free apps:</div>
                  <ul style="margin: 8px 0 0 20px; font-size: 13px; line-height: 1.8; color: var(--text);">
                    <li><strong>"NFC Tools"</strong> (Recommended - easiest to use)</li>
                    <li><strong>"NFC TagWriter by NXP"</strong> (Official, reliable)</li>
                    <li><strong>"GoToTags"</strong> (Simple and free)</li>
                  </ul>
                </div>

                <div style="background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                  <div style="font-weight: 700; margin-bottom: 12px; color: var(--accent-2); font-size: 14px;">📋 STEP 2: Copy the URL</div>
                  <div style="font-size: 13px; color: var(--text); margin-bottom: 8px;">
                    Tap the "📋 Copy URL" button above. The URL is now on your clipboard.
                  </div>
                </div>

                <div style="background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                  <div style="font-weight: 700; margin-bottom: 12px; color: var(--accent-2); font-size: 14px;">✍️ STEP 3: Write the Tag</div>
                  <div style="font-size: 13px; color: var(--text); line-height: 1.6;">
                    <strong>In your NFC app:</strong>
                    <ol style="margin: 8px 0 0 20px; line-height: 1.8;">
                      <li>Tap <strong>"Write"</strong> or <strong>"New Tag"</strong></li>
                      <li>Select <strong>"URL"</strong> or <strong>"Web Address"</strong></li>
                      <li><strong>Paste</strong> the URL you copied (long-press in text field)</li>
                      <li>Tap <strong>"Write"</strong> and hold your phone near the NFC sticker</li>
                      <li>Wait for confirmation ✅</li>
                    </ol>
                  </div>
                </div>

                <div style="background: rgba(76, 175, 80, 0.15); border: 1px solid #4caf50; padding: 12px; border-radius: 8px; font-size: 13px; color: #9ef0c2;">
                  <strong>💡 Tip:</strong> Test the tag by holding your iPhone near it. Your phone should show a notification to open the URL.
                </div>
              </div>
            ` : nfcSupported ? `
              <button class="btn" id="writeNFCBtn" onclick="writeNFCTag()" style="width: 100%; padding: 16px; font-size: 16px; margin-bottom: 16px;">
                📱 Write to NFC Tag
              </button>
              <div id="nfcStatus" style="padding: 12px; border-radius: 8px; display: none; margin-bottom: 16px; text-align: center;"></div>
            ` : `
              <div style="background: rgba(212, 83, 69, 0.2); border: 1px solid var(--danger); padding: 16px; border-radius: 12px; margin-bottom: 16px; font-size: 14px;">
                ⚠️ NFC writing not supported in this browser. Use Chrome on Android or follow the instructions below.
              </div>
            `}

            <div style="text-align: center;">
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-bottom: 12px;">${isIOS ? 'OPTIONAL: TEST WITH QR CODE' : 'SCAN QR CODE'}</div>
              <div id="qrcodeContainer" style="display: inline-block; padding: 16px; background: white; border-radius: 12px;"></div>
              <div style="font-size: 12px; color: var(--muted); margin-top: 12px; line-height: 1.6;">
                ${isIOS ?
                  'Scan this QR code with your iPhone camera to test the URL before writing it to your NFC tag.' :
                  'Scan with your phone\'s camera to open the URL'
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Generate QR code
    generateQRCode(uploadUrl);

    // Store URLs for mode switching
    window.nfcModalState = {
      binId,
      uploadUrl,
      removeUrl,
      currentMode: 'upload',
      currentUrl: uploadUrl
    };
  }

  function selectNFCMode(mode) {
    const state = window.nfcModalState;
    if (!state) return;

    state.currentMode = mode;
    state.currentUrl = mode === 'upload' ? state.uploadUrl : state.removeUrl;

    // Update button styles
    document.querySelectorAll('.mode-select-btn').forEach(btn => {
      const btnMode = btn.dataset.mode;
      if (btnMode === mode) {
        btn.style.border = '2px solid var(--accent)';
        btn.style.background = 'rgba(255, 102, 0, 0.15)';
        btn.style.color = 'var(--accent)';
      } else {
        btn.style.border = '2px solid var(--border)';
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text)';
      }
    });

    // Update URL display
    const urlDisplay = document.getElementById('nfcUrlDisplay');
    if (urlDisplay) {
      urlDisplay.textContent = state.currentUrl;
    }

    // Update QR code
    generateQRCode(state.currentUrl);
  }

  function generateQRCode(url) {
    const container = document.getElementById('qrcodeContainer');
    if (!container) return;

    container.innerHTML = '';

    // Use a simple QR code generation approach
    // For production, you might want to include a QR library
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
    container.innerHTML = `<img src="${qrApiUrl}" alt="QR Code" style="display: block; width: 200px; height: 200px;">`;
  }

  async function writeNFCTag() {
    const state = window.nfcModalState;
    if (!state) return;

    const statusEl = document.getElementById('nfcStatus');
    const btnEl = document.getElementById('writeNFCBtn');

    if (!('NDEFReader' in window)) {
      if (statusEl) {
        statusEl.textContent = '❌ NFC not supported in this browser';
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(212, 83, 69, 0.2)';
        statusEl.style.border = '1px solid var(--danger)';
        statusEl.style.color = 'var(--danger)';
      }
      return;
    }

    try {
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '📱 Hold your phone near the NFC tag...';
      }

      if (statusEl) {
        statusEl.textContent = '📡 Ready to write. Hold your phone near the NFC tag...';
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(255, 143, 43, 0.2)';
        statusEl.style.border = '1px solid var(--accent)';
        statusEl.style.color = 'var(--accent-2)';
      }

      const ndef = new NDEFReader();
      await ndef.write({
        records: [{ recordType: "url", data: state.currentUrl }]
      });

      if (statusEl) {
        statusEl.textContent = '✅ NFC tag written successfully!';
        statusEl.style.background = 'rgba(76, 175, 80, 0.2)';
        statusEl.style.border = '1px solid #4caf50';
        statusEl.style.color = '#9ef0c2';
      }

      if (btnEl) {
        btnEl.textContent = '✅ Tag Written!';
        setTimeout(() => {
          btnEl.disabled = false;
          btnEl.textContent = '📱 Write to NFC Tag';
        }, 3000);
      }
    } catch (error) {
      console.error('NFC write error:', error);
      if (statusEl) {
        statusEl.textContent = `❌ Error: ${error.message}`;
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(212, 83, 69, 0.2)';
        statusEl.style.border = '1px solid var(--danger)';
        statusEl.style.color = 'var(--danger)';
      }

      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '📱 Write to NFC Tag';
      }
    }
  }

  function copyNFCUrl() {
    const state = window.nfcModalState;
    if (!state) return;

    navigator.clipboard.writeText(state.currentUrl).then(() => {
      const btnEl = event.target;
      const originalText = btnEl.textContent;
      btnEl.textContent = '✅ Copied!';
      setTimeout(() => {
        btnEl.textContent = originalText;
      }, 2000);
    }).catch(err => {
      console.error('Copy failed:', err);
      alert('Failed to copy URL');
    });
  }

  // Make functions available globally for onclick handlers
  window.selectNFCMode = selectNFCMode;
  window.writeNFCTag = writeNFCTag;
  window.copyNFCUrl = copyNFCUrl;

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
          <button class="btn" data-action="nfc-tag" data-bin="${binId}">📱 NFC Tag</button>
          <button class="btn" data-action="upload" data-bin="${binId}">Upload</button>
          <button class="btn danger" data-action="remove" data-bin="${binId}">Remove</button>
          <button class="btn" data-action="analyze-all" data-bin="${binId}">Analyze All</button>
          <button class="btn danger ghost" data-action="remove-last" data-bin="${binId}">Remove Last</button>
          <button class="btn danger ghost" data-action="remove-bin" data-bin="${binId}">Remove Bin</button>
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
    const bins = availableBins();
    const hasBins = bins.length > 0;
    // Ensure selected bin is valid
    if (!bins.includes(uiState.selectedBin) && uiState.selectedBin !== "all") {
      uiState.selectedBin = hasBins ? bins[0] : "all";
    }

    const binOptions = [
      `<option value="all" ${uiState.selectedBin === "all" ? "selected" : ""}>All</option>`,
      ...bins
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
        ? hasBins
          ? bins.map(renderBinCard).join("")
          : `<div class="card"><h3>No bins yet</h3><p class="muted">Add a bin to start tracking inventory.</p></div>`
        : focusedBinId
          ? renderBinCard(focusedBinId)
          : "";

    const focusState = captureFocusState();
    renderCount += 1;
    app.innerHTML = `
      <div class="hero">
        <div>
          <div class="eyebrow"><img src="/local/SmartBin_AI.svg" alt="SmartBin AI" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 8px; object-fit: contain;">SmartBin AI Management</div>
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

      <section class="card">
        <h2>Manage Bins</h2>
        <p class="muted">Add or remove bins to match your actual storage setup.</p>
        <div class="grid-2">
          <div class="stack">
            <label class="label">New Bin Name</label>
            <input class="input" type="text" data-model="newBinName" placeholder="e.g. Pantry Overflow" value="${escapeHtml(
              uiState.newBinName
            )}">
          </div>
          <div class="stack">
            <label class="label">Bin ID (optional)</label>
            <input class="input" type="text" data-model="newBinId" placeholder="smartbin_006" value="${escapeHtml(
              uiState.newBinId
            )}">
          </div>
        </div>
        <div class="row actions">
          <button class="btn" data-action="add-bin">Add Bin</button>
        </div>
        <p class="muted">Remove a bin from its card in the section below.</p>
      </section>

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
  loadConfig().finally(() => {
    render();
    initDebugPanel();
    connectWebsocket();
  });
})();
