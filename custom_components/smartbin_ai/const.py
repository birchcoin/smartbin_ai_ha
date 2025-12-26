"""Constants for SmartBin AI integration."""

DOMAIN = "smartbin_ai"
STORAGE_VERSION = 1
STORAGE_KEY = DOMAIN
DEFAULT_BINS = [f"smartbin_{i:03d}" for i in range(1, 6)]
ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
CONDITION_RANK = {"good": 0, "fair": 1, "needs replacement": 2}
UPLOAD_TOKEN_TTL = 300

# Default AI API configuration
DEFAULT_API_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"
DEFAULT_MODEL = "glm-4.6v"
DEFAULT_TEXT_MODEL = "glm-4.5-air"
