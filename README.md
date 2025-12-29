<p align="center">
  <img src="SmartBin_AI.svg" alt="SmartBin AI Logo" width="300"/>
</p>

# SmartBin AI

A complete NFC-triggered, AI-powered SmartBin inventory management system for Home Assistant.

## Features

- **AI-Powered Image Analysis**: Automatically identify items in your SmartBins using vision AI
- **NFC Tag Integration**: Tap NFC tags on bins to launch photo upload interface
- **Mobile-Friendly**: iOS-optimized camera interface for easy photo uploads
- **Inventory Management**: Track items, quantities, and conditions automatically
- **Multiple Dashboard Themes**: Choose from industrial, warm, or tech visual styles
- **Search Functionality**: Find items across all bins quickly
- **History Tracking**: See all add/remove operations with timestamps

## Installation

### Via HACS (Recommended)

1. Go to HACS → Integrations → Browse
2. Search for "SmartBin AI"
3. Click "Download"
4. Restart Home Assistant

### Manual Installation

1. Copy the `custom_components/smartbin_ai` directory to your Home Assistant `custom_components` folder
2. Restart Home Assistant
3. Go to Settings → Devices & Services → Add Integration
4. Search for "SmartBin AI"
5. Enter your Z.AI API key (get one from https://z.ai)

## Configuration

### API Setup

You'll need a Z.AI API key for image analysis:

1. Visit https://z.ai
2. Sign up and get an API key
3. Enter the API key during integration setup

### Adding SmartBins

The integration creates 5 default bins (smartbin_001 through smartbin_005). To add more:

1. Create entities in Home Assistant UI (see Entities section below)
2. Create folder: `/config/www/bins/bin_XXX/` where XXX is your bin number
3. Map NFC tags in automations

### NFC Tag Setup

#### Easy Way: Use the Built-in NFC Tag Generator

1. Open the SmartBin AI Dashboard
2. Find your bin in the bins section
3. Click the **"📱 NFC Tag"** button
4. Follow the on-screen instructions for your device

The dashboard will automatically:
- Generate the correct URL for your bin
- Show step-by-step instructions for iPhone or Android
- Display a QR code for testing
- Let you write the tag directly (Android) or copy the URL (iPhone)

#### Manual Setup

For each bin, write an NFC tag with a URL in this format:

**For Upload (Add Items):**
```
https://YOUR_HA_URL/smartbin_ai/launch?bin=smartbin_001
```

**For Remove Items:**
```
https://YOUR_HA_URL/smartbin_ai/launch_remove?bin=smartbin_001
```

Replace:
- `YOUR_HA_URL` with your Home Assistant URL (e.g., `homeassistant.local:8123` or `https://your-domain.com`)
- `smartbin_001` with your actual bin ID (smartbin_001, smartbin_002, etc.)

#### iPhone Users

iPhones cannot write NFC tags from websites. Follow these steps:

1. **Download a free NFC app** from the App Store:
   - "NFC Tools" (Recommended)
   - "NFC TagWriter by NXP"
   - "GoToTags"

2. **Get the URL** from the SmartBin AI dashboard:
   - Click "📱 NFC Tag" button on your bin
   - Click "📋 Copy URL" button

3. **Write the tag** in your NFC app:
   - Open the app → Tap "Write" → Select "URL"
   - Paste the URL → Hold iPhone near NFC sticker
   - Wait for confirmation

4. **Test the tag**: Hold your iPhone near the tag - it should show a notification to open the URL

#### Android Users

Android users can write tags directly from the dashboard:
1. Click "📱 NFC Tag" button on your bin
2. Select mode (Add Items or Remove Items)
3. Click "Write to NFC Tag"
4. Hold your phone near a blank NFC sticker
5. Done!

## Usage

### Adding Items to a Bin

1. Tap NFC tag on SmartBin
2. Tap "TAKE PHOTO" in the upload interface
3. Take or select a photo from your phone
4. Image uploads automatically and AI analysis begins
5. View detected items in the dashboard

### Viewing Inventory

1. Go to SmartBin AI Dashboard (add as webpage dashboard in HA)
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
| `smartbin_ai.analyze_image` | Analyze an image with AI |
| `smartbin_ai.append_image` | Add image to bin list |
| `smartbin_ai.remove_item` | Remove item from inventory |
| `smartbin_ai.update_item` | Update existing item |
| `smartbin_ai.add_item` | Manually add item |
| `smartbin_ai.clear_inventory` | Remove all items |
| `smartbin_ai.search_items` | Search across all bins |

## Dashboard Setup

### Add SmartBin AI Dashboard

1. Settings → Dashboards → Add Dashboard
2. Select "Webpage"
3. Enter `/local/smartbin_ai_dashboard.html`
4. Name it "SmartBin AI"

Note: The integration copies its frontend files from `custom_components/smartbin_ai/frontend/` into `/config/www/`
on startup, so they are served from `/local/` and remain fully HACS-packageable.

## Troubleshooting

### NFC Tag Not Working or 404 Error

**iPhone Users:**
1. Make sure you wrote the tag using an NFC app (not the website)
2. Test the URL first by clicking "📋 Copy URL" and pasting it in Safari
3. Verify the URL includes your Home Assistant address

**All Users:**
1. Check the tag has the correct URL format: `https://YOUR_HA_URL/smartbin_ai/launch?bin=smartbin_001`
2. Test endpoints directly: Visit `/local/smartbin_ai_nfc_test.html`
3. Verify the bin ID exists (smartbin_001, smartbin_002, etc.)
4. Check Home Assistant logs for errors

**iPhone Tag Reading Issues:**
- Make sure NFC is enabled: Settings → General → NFC
- Hold the top of your iPhone near the tag for 1-2 seconds
- iOS 13 or later required for background NFC reading

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
- Inventory data stored in: `/config/.storage/smartbin_ai`
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
