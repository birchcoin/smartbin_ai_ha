# Smart Bin HACS Integration

A complete NFC-triggered, AI-powered smart bin inventory management system for Home Assistant.

## Features

- **AI-Powered Image Analysis**: Automatically identify items in your smart bins using vision AI
- **NFC Tag Integration**: Tap NFC tags on bins to launch photo upload interface
- **Mobile-Friendly**: iOS-optimized camera interface for easy photo uploads
- **Inventory Management**: Track items, quantities, and conditions automatically
- **Multiple Dashboard Themes**: Choose from industrial, warm, or tech visual styles
- **Search Functionality**: Find items across all bins quickly
- **History Tracking**: See all add/remove operations with timestamps

## Installation

### Via HACS (Recommended)

1. Go to HACS → Integrations → Browse
2. Search for "Smart Bin HA"
3. Click "Download"
4. Restart Home Assistant

### Manual Installation

1. Copy the `custom_components/smartbin_ai_upload` directory to your Home Assistant `custom_components` folder
2. Restart Home Assistant
3. Go to Settings → Devices & Services → Add Integration
4. Search for "Smart Bin Upload"
5. Enter your Z.AI API key (get one from https://z.ai)

## Configuration

### API Setup

You'll need a Z.AI API key for image analysis:

1. Visit https://z.ai
2. Sign up and get an API key
3. Enter the API key during integration setup

### Adding Smart Bins

The integration creates 5 default bins (smartbin_ai_001 through smartbin_ai_005). To add more:

1. Create entities in Home Assistant UI (see Entities section below)
2. Create folder: `/config/www/bins/bin_XXX/` where XXX is your bin number
3. Map NFC tags in automations

### NFC Tag Setup

For each bin, create an NFC tag with this URL format:

```
homeassistant://navigate/smartbin_ai_upload/launch?bin=smartbin_ai_001
```

Replace `smartbin_ai_001` with your actual bin ID.

For iOS Beta/Dev apps:
- Beta: `homeassistant-beta://navigate/...`
- Dev: `homeassistant-dev://navigate/...`

## Usage

### Adding Items to a Bin

1. Tap NFC tag on smart bin
2. Tap "TAKE PHOTO" in the upload interface
3. Take or select a photo from your phone
4. Image uploads automatically and AI analysis begins
5. View detected items in the dashboard

### Viewing Inventory

1. Go to Smart Bin Dashboard (add as webpage dashboard in HA)
2. Select a bin to view its contents
3. Click on item names to see highlighted bounding boxes in images

### Searching for Items

1. Use the search box in the dashboard
2. Enter item name or description
3. Click "Search All Bins"
4. View results showing which bin contains the item

### Manual Inventory Management

You can also:
- Add items manually without photos
- Update quantities and conditions
- Remove specific items or images
- Clear entire inventory or image list

## Entities

The integration creates these entities per bin:

### Input Text Entities
- `input_text.smartbin_ai_XXX_name` - Bin name/label
- `input_text.smartbin_ai_XXX_images` - Summary (latest filename)
- `input_text.smartbin_ai_XXX_inventory` - Summary (item count)

### Sensors
- `sensor.smartbin_ai_XXX_data` - Full data (images, inventory, history)
- `sensor.smartbin_ai_XXX_item_count` - Total quantity of all items
- `sensor.smartbin_ai_XXX_image_count` - Number of images
- `sensor.smartbin_ai_XXX_latest_image` - Path to most recent image

## Services

The integration provides these services:

| Service | Description |
|----------|-------------|
| `smartbin_ai_upload.analyze_image` | Analyze an image with AI |
| `smartbin_ai_upload.append_image` | Add image to bin list |
| `smartbin_ai_upload.remove_item` | Remove item from inventory |
| `smartbin_ai_upload.update_item` | Update existing item |
| `smartbin_ai_upload.add_item` | Manually add item |
| `smartbin_ai_upload.clear_inventory` | Remove all items |
| `smartbin_ai_upload.search_items` | Search across all bins |

## Dashboard Setup

### Add Smart Bin Dashboard

1. Settings → Dashboards → Add Dashboard
2. Select "Webpage"
3. Enter `/local/custom_components/smartbin_ai_upload/frontend/smartbin_ai_dashboard_industrial.html`
4. Name it "Smart Bins"

### Alternative Themes

Replace the URL with:
- Industrial: `.../smartbin_ai_dashboard_industrial.html`
- Warm: `.../smartbin_ai_dashboard_warm.html`
- Tech: `.../smartbin_ai_dashboard_tech.html`

## Troubleshooting

### Upload Fails with "Not authenticated"

Use the NFC tag deep link instead of direct URL:
```
homeassistant://navigate/smartbin_ai_upload/launch?bin=smartbin_ai_001
```

### iOS Camera Shows Blank Screen

This integration uses the native file picker, not WebView camera:
1. Tap "TAKE PHOTO"
2. iOS presents native camera interface
3. No blank screen issues

### AI Analysis Not Running

1. Check API key in integration settings
2. Verify internet connectivity
3. Check Home Assistant logs for errors
4. Visit `/config/ANALYSIS_DEBUG.log` for detailed logs

### Images Not Appearing

1. Check directory permissions: `ls -la /config/www/bins/`
2. Verify images exist on disk
3. Restart Home Assistant to sync file system

## Data Storage

- Images stored in: `/config/www/bins/bin_XXX/`
- Inventory data stored in: `/config/.storage/smartbin_ai_upload`
- Analysis logs: `/config/ANALYSIS_DEBUG.log`

## License

MIT License - See LICENSE file for details

## Support

- **Issues**: https://github.com/birchcoin/smartbin_ai_ha/issues
- **Documentation**: https://github.com/birchcoin/smartbin_ai_ha

## Credits

- AI Vision: Z.AI (GLM-4.6v model)
- Platform: Home Assistant
- HACS: Home Assistant Community Store
