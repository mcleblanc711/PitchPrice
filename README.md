# PitchPrice

FIFA World Cup 2026 Hotel Rate Tracker for Toronto and Vancouver.

## Overview

PitchPrice tracks hotel room rates for the FIFA World Cup 2026 game dates in Toronto and Vancouver. The tool consists of two components:

1. **Scraper**: Automated Python script that collects hotel rates from Google Hotels
2. **Dashboard**: Static web visualization hosted on GitHub Pages

## Features

- Tracks 20 hotels (10 per city) across market segments (luxury, upscale, midscale, economy)
- Monitors rates for all dates in the FIFA 2026 tournament window
- Visualizes rate evolution over time
- Compares rates across hotels by segment and stadium proximity
- Lead-time analysis showing how rates change as game dates approach
- Availability tracking

## Project Structure

```
PitchPrice/
├── config/
│   └── hotels.json          # Hotel configuration and date ranges
├── scraper/
│   ├── scraper.py           # Main scraping script
│   └── requirements.txt     # Python dependencies
├── dashboard/
│   ├── index.html           # Dashboard HTML
│   ├── css/
│   │   └── styles.css       # Dark mode styling
│   └── js/
│       └── app.js           # Dashboard application logic
├── data/
│   └── scrapes/             # Collected rate data (JSON)
├── .github/
│   └── workflows/
│       └── scrape.yml       # GitHub Actions workflow
└── README.md
```

## Game Dates

### Toronto (BMO Field)
- June 12, 17, 20, 23, 26, 2026
- July 2, 2026

### Vancouver (BC Place)
- June 13, 18, 21, 24, 26, 2026
- July 2, 7, 2026

## Setup

### Prerequisites

- Python 3.11+
- Node.js (optional, for local dashboard development)

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/PitchPrice.git
   cd PitchPrice
   ```

2. Install Python dependencies:
   ```bash
   cd scraper
   pip install -r requirements.txt
   playwright install chromium
   ```

3. Run the scraper:
   ```bash
   python scraper.py --dry-run  # Preview what will be scraped
   python scraper.py            # Run actual scrape
   python scraper.py --cities toronto  # Scrape specific city
   ```

4. View the dashboard:
   ```bash
   cd dashboard
   python -m http.server 8000
   # Open http://localhost:8000 in your browser
   ```

### GitHub Actions

The scraper runs automatically via GitHub Actions:
- **Schedule**: Monday and Thursday at 6 AM UTC
- **Manual trigger**: Go to Actions > Scrape Hotel Rates > Run workflow

To enable:
1. Push the repository to GitHub
2. Enable GitHub Actions in repository settings
3. Enable GitHub Pages (Settings > Pages > Source: Deploy from a branch > `main` / `dashboard`)

## Configuration

Edit `config/hotels.json` to modify:

- **Hotels**: Add or remove hotels, update segments and proximity
- **Date ranges**: Adjust scrape date windows per city
- **Game dates**: Update game dates for chart highlighting
- **Scrape settings**: Adjust delays and retry behavior

### Hotel Configuration Structure

```json
{
  "id": "tor-hotel-x",
  "name": "Hotel X Toronto",
  "segment": "upscale",
  "proximity": "near",
  "address": "111 Princes' Blvd, Toronto, ON",
  "notes": "Directly at Exhibition Place"
}
```

**Segments**: `luxury`, `upscale`, `midscale`, `economy`

**Proximity**: `near`, `medium`, `far` (relative to stadium)

## Data Format

Scrape results are stored as JSON in `data/scrapes/`:

```json
{
  "scrape_metadata": {
    "timestamp": "2024-12-14T10:00:00Z",
    "cities_scraped": ["toronto", "vancouver"],
    "total_results": 520,
    "errors_count": 2
  },
  "results": [
    {
      "hotel_id": "tor-hotel-x",
      "hotel_name": "Hotel X Toronto",
      "city": "Toronto",
      "segment": "upscale",
      "proximity": "near",
      "check_in_date": "2026-06-12",
      "check_out_date": "2026-06-13",
      "rate": 459,
      "currency": "CAD",
      "availability_status": "available",
      "scrape_timestamp": "2024-12-14T10:05:23Z"
    }
  ]
}
```

## Limitations

- Scraping may occasionally fail due to anti-bot measures
- Rates shown are the lowest available at scrape time
- Currency is assumed to be CAD

## Future Enhancements

- CSV export for historical data
- Additional cities/events
- Price alert notifications
- Demand curve modeling

## License

MIT License - see [LICENSE](LICENSE)

## Disclaimer

This tool is for informational purposes only. Hotel rates are collected from publicly available sources. Always verify rates directly with hotels before booking.
