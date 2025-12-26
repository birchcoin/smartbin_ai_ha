# Release Notes

## v1.0.0 - Initial HACS Release (2024-12-26)

### Features
- Complete AI-powered smart bin inventory management
- Mobile-friendly photo upload interface (iOS optimized)
- NFC tag integration for quick access
- Automatic image analysis using Z.AI vision API
- Multiple dashboard themes (Industrial, Warm, Tech)
- Search functionality across all bins
- History tracking for add/remove operations
- Configurable API key via UI setup wizard

### Installation
1. Install via HACS (recommended) or manual installation
2. Add integration in Home Assistant
3. Enter Z.AI API key during setup
4. Configure smart bins and NFC tags
5. Add dashboard to view inventory

### Documentation
- Full documentation available at: https://github.com/birchcoin/smartbin_ai_ha
- Setup guide included in README

### Known Issues
- Deep analysis currently disabled (can be re-enabled in code)
- API key must be configured during initial setup
- Brand icon pending approval in home-assistant/brands

### Requirements
- Home Assistant 2023.12.0 or later
- HACS 0.20.0 or later
- Z.AI API account
- Python packages: aiohttp>=3.8.0, pillow>=10.0.0

### Breaking Changes
None - This is the initial release

### Upgrade Notes
N/A - Initial release

### Credits
- AI Vision: Z.AI (GLM-4.6v model)
- Platform: Home Assistant
- Distribution: HACS
