#!/usr/bin/env python3
"""
PitchPrice Hotel Rate Scraper

Scrapes hotel rates from Booking.com for FIFA 2026 World Cup dates
in Toronto and Vancouver.
"""

import json
import os
import random
import re
import sys
import time
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus

# Suppress deprecation warning from playwright_stealth's use of pkg_resources
warnings.filterwarnings("ignore", message="pkg_resources is deprecated")

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from playwright_stealth import stealth_sync


# Paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "config" / "hotels.json"
DATA_DIR = PROJECT_ROOT / "data" / "scrapes"


def load_config():
    """Load the hotels configuration file."""
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


def generate_dates(start_date: str, end_date: str) -> list[str]:
    """Generate list of dates between start and end (inclusive)."""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    dates = []
    current = start
    while current <= end:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return dates


def build_booking_url(hotel_name: str, city: str, check_in: str, check_out: str) -> str:
    """
    Build a Booking.com search URL for a specific hotel and date.

    Args:
        hotel_name: Name of the hotel
        city: City name (e.g., "Toronto" or "Vancouver")
        check_in: Check-in date in YYYY-MM-DD format
        check_out: Check-out date in YYYY-MM-DD format

    Returns:
        Booking.com search URL
    """
    query = f"{hotel_name} {city}"
    encoded_query = quote_plus(query)

    url = (
        f"https://www.booking.com/searchresults.html"
        f"?ss={encoded_query}"
        f"&checkin={check_in}"
        f"&checkout={check_out}"
        f"&group_adults=2"
        f"&no_rooms=1"
        f"&group_children=0"
        f"&selected_currency=CAD"
    )

    return url


def dismiss_cookie_popup(page):
    """Dismiss Booking.com cookie consent popup if present."""
    try:
        cookie_selectors = [
            'button:has-text("Accept")',
            'button:has-text("OK")',
            '#onetrust-accept-btn-handler',
            '[data-testid="accept-btn"]',
        ]
        for selector in cookie_selectors:
            try:
                btn = page.locator(selector).first
                if btn.is_visible(timeout=2000):
                    btn.click()
                    time.sleep(0.5)
                    return
            except:
                continue
    except:
        pass


def extract_rate_from_booking(page, hotel_name: str, num_nights: int = 1) -> dict:
    """
    Extract rate information from Booking.com search results.

    Finds the specific hotel card and extracts pricing information.
    Returns the TOTAL price for the stay, not per-night.

    Args:
        page: Playwright page object
        hotel_name: Name of hotel to find
        num_nights: Number of nights in the booking (for proper price extraction)

    Returns:
        Dict with rate (total for stay), currency, availability_status
    """
    result = {
        "rate": None,
        "currency": "CAD",
        "availability_status": "unknown",
        "error": None
    }

    try:
        # Dismiss cookie popup if present
        dismiss_cookie_popup(page)

        # Find property cards
        property_cards = page.locator('[data-testid="property-card"]').all()

        # Search for matching hotel card
        hotel_name_lower = hotel_name.lower()
        # Get key words from hotel name for matching
        key_words = [w.lower() for w in hotel_name.split() if len(w) > 3][:3]

        for card in property_cards[:15]:
            try:
                card_text = card.inner_text(timeout=2000)
                card_text_lower = card_text.lower()

                # Check if this card matches the hotel
                matches = sum(1 for word in key_words if word in card_text_lower)
                if matches < 2:
                    continue

                # Found the hotel card - check availability
                is_sold_out = (
                    'no availability' in card_text_lower or
                    'unavailable' in card_text_lower or
                    'this property is unavailable' in card_text_lower
                )

                if is_sold_out:
                    result["availability_status"] = "sold_out"
                    # Don't try to extract prices for sold out - alternative dates shown
                    break

                # Extract all CAD prices from the card
                all_prices = re.findall(r'(?:CA\$|CAD|C\$)\s*([\d,]+)', card_text)
                if all_prices:
                    prices_int = [int(p.replace(',', '')) for p in all_prices]

                    # Look for the most commonly appearing price (standard rate)
                    # Special deals usually appear once, standard rate appears multiple times
                    from collections import Counter
                    price_counts = Counter(prices_int)

                    if num_nights == 1:
                        # For single night, look for reasonable per-night rates
                        single_night_prices = [p for p in prices_int if 150 <= p <= 2500]
                        if single_night_prices:
                            # Prefer price that appears multiple times (standard rate)
                            repeated = [p for p in single_night_prices if price_counts[p] > 1]
                            if repeated:
                                result["rate"] = min(repeated)
                            else:
                                # If no repeats, take the median to avoid outliers
                                sorted_prices = sorted(single_night_prices)
                                result["rate"] = sorted_prices[len(sorted_prices) // 2]
                            result["availability_status"] = "available"
                    else:
                        # For multi-night, look for totals
                        # Multi-night totals are typically $300+ for 2 nights
                        min_total = 300 * num_nights
                        max_total = 3000 * num_nights
                        total_prices = [p for p in prices_int if min_total <= p <= max_total]

                        if total_prices:
                            # Prefer price that appears multiple times (standard rate)
                            repeated = [p for p in total_prices if price_counts[p] > 1]
                            if repeated:
                                result["rate"] = min(repeated)
                            else:
                                # Take median to avoid promotional outliers
                                sorted_prices = sorted(total_prices)
                                result["rate"] = sorted_prices[len(sorted_prices) // 2]
                            result["availability_status"] = "available"
                        elif prices_int:
                            # Fallback: look for any reasonable total
                            reasonable = [p for p in prices_int if p >= 400 * num_nights]
                            if reasonable:
                                result["rate"] = min(reasonable)
                                result["availability_status"] = "available"

                break  # Found our hotel, stop searching

            except Exception:
                continue

        # If we didn't find the specific hotel, try page-wide price extraction
        if result["rate"] is None and result["availability_status"] not in ["sold_out"]:
            page_text = page.inner_text("body")

            # Check for general sold out
            if "no availability" in page_text.lower() or "sold out" in page_text.lower():
                result["availability_status"] = "sold_out"
            else:
                result["availability_status"] = "not_found"
                result["error"] = "Hotel not found in results"

    except PlaywrightTimeout:
        result["error"] = "Page load timeout"
        result["availability_status"] = "error"
    except Exception as e:
        result["error"] = str(e)
        result["availability_status"] = "error"

    return result


def fetch_booking_rate(page, hotel_name: str, city_name: str, check_in: str, check_out: str) -> dict:
    """
    Fetch rate from Booking.com for a specific date range.

    Returns:
        Dict with rate (TOTAL for the stay) and availability_status
    """
    url = build_booking_url(hotel_name, city_name, check_in, check_out)

    # Calculate number of nights
    check_in_dt = datetime.strptime(check_in, "%Y-%m-%d")
    check_out_dt = datetime.strptime(check_out, "%Y-%m-%d")
    num_nights = (check_out_dt - check_in_dt).days

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        time.sleep(4)
        page.wait_for_load_state("networkidle", timeout=30000)
        time.sleep(1)

        return extract_rate_from_booking(page, hotel_name, num_nights)

    except Exception as e:
        return {"rate": None, "availability_status": "error", "error": str(e)}


def calculate_rate_from_multi_night(page, hotel: dict, city_name: str, target_date: str) -> dict:
    """
    Calculate single-night rate when there's a 2-night minimum.

    Uses the formula:
    - Get Fri+Sat 2-night total, get Fri 1-night rate
    - Saturday Rate = (Fri+Sat total) - Friday rate

    Verifies with:
    - Get Sat+Sun 2-night total, get Sun 1-night rate
    - Saturday Rate = (Sat+Sun total) - Sunday rate

    Returns:
        Dict with calculated rate and verification info
    """
    target_dt = datetime.strptime(target_date, "%Y-%m-%d")
    prev_day = (target_dt - timedelta(days=1)).strftime("%Y-%m-%d")
    next_day = (target_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    day_after_next = (target_dt + timedelta(days=2)).strftime("%Y-%m-%d")

    result = {
        "rate": None,
        "currency": "CAD",
        "availability_status": "unknown",
        "rate_calculation": None,
        "verification": None,
        "error": None
    }

    hotel_name = hotel["name"]

    # Method 1: (Prev + Target) 2-night total minus Prev 1-night
    # e.g., (Fri+Sat) - Fri = Sat
    print(f"    Trying 2-night calculation (prev+target)...")

    # Get 2-night rate: prev_day to next_day (2 nights)
    two_night_1 = fetch_booking_rate(page, hotel_name, city_name, prev_day, next_day)
    time.sleep(2)

    # Get 1-night rate for prev_day (if available)
    one_night_prev = fetch_booking_rate(page, hotel_name, city_name, prev_day, target_date)
    time.sleep(2)

    calculated_rate_1 = None
    if two_night_1.get("rate") and one_night_prev.get("rate"):
        # Target rate = 2-night total - prev night rate
        calculated_rate_1 = two_night_1["rate"] - one_night_prev["rate"]
        print(f"      2-night (prev+target): ${two_night_1['rate']}")
        print(f"      1-night prev: ${one_night_prev['rate']}")
        print(f"      Calculated target rate: ${calculated_rate_1}")
        result["rate_calculation"] = {
            "method": "prev+target minus prev",
            "two_night_total": two_night_1["rate"],
            "prev_night_rate": one_night_prev["rate"],
            "calculated": calculated_rate_1
        }

    # Method 2: (Target + Next) 2-night total minus Next 1-night
    # e.g., (Sat+Sun) - Sun = Sat
    print(f"    Verifying with 2-night calculation (target+next)...")

    # Get 2-night rate: target_date to day_after_next (2 nights)
    two_night_2 = fetch_booking_rate(page, hotel_name, city_name, target_date, day_after_next)
    time.sleep(2)

    # Get 1-night rate for next_day
    one_night_next = fetch_booking_rate(page, hotel_name, city_name, next_day, day_after_next)
    time.sleep(2)

    calculated_rate_2 = None
    if two_night_2.get("rate") and one_night_next.get("rate"):
        # Target rate = 2-night total - next night rate
        calculated_rate_2 = two_night_2["rate"] - one_night_next["rate"]
        print(f"      2-night (target+next): ${two_night_2['rate']}")
        print(f"      1-night next: ${one_night_next['rate']}")
        print(f"      Calculated target rate: ${calculated_rate_2}")
        result["verification"] = {
            "method": "target+next minus next",
            "two_night_total": two_night_2["rate"],
            "next_night_rate": one_night_next["rate"],
            "calculated": calculated_rate_2
        }

    # Determine final rate
    if calculated_rate_1 and calculated_rate_2:
        # Both methods worked - check if they match
        diff = abs(calculated_rate_1 - calculated_rate_2)
        avg = (calculated_rate_1 + calculated_rate_2) / 2
        if diff <= 50:  # Within $50 tolerance
            result["rate"] = int(round(avg))
            result["availability_status"] = "available_calculated"
            print(f"      VERIFIED: Both methods agree (~${result['rate']})")
        else:
            # Use the average but note discrepancy
            result["rate"] = int(round(avg))
            result["availability_status"] = "available_calculated"
            result["error"] = f"Calculation methods differ by ${diff}"
            print(f"      WARNING: Methods differ by ${diff}, using average ${result['rate']}")
    elif calculated_rate_1:
        result["rate"] = calculated_rate_1
        result["availability_status"] = "available_calculated"
        print(f"      Using first method: ${calculated_rate_1}")
    elif calculated_rate_2:
        result["rate"] = calculated_rate_2
        result["availability_status"] = "available_calculated"
        print(f"      Using second method: ${calculated_rate_2}")
    else:
        result["error"] = "Could not calculate rate from multi-night bookings"
        result["availability_status"] = "not_found"
        print(f"      ERROR: Could not calculate rate")

    return result


def scrape_hotel_rate(page, hotel: dict, city_name: str, check_in: str) -> dict:
    """
    Scrape the rate for a single hotel on a single date from Booking.com.

    If the date has a minimum stay requirement (shows as sold out for 1 night),
    calculates the rate from 2-night bookings.

    Args:
        page: Playwright page object
        hotel: Hotel configuration dict
        city_name: City name
        check_in: Check-in date (YYYY-MM-DD)

    Returns:
        Dict with scrape results
    """
    check_out = (datetime.strptime(check_in, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    result = {
        "hotel_id": hotel["id"],
        "hotel_name": hotel["name"],
        "city": city_name,
        "segment": hotel["segment"],
        "proximity": hotel["proximity"],
        "check_in_date": check_in,
        "check_out_date": check_out,
        "rate": None,
        "currency": "CAD",
        "availability_status": "unknown",
        "scrape_timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "error": None
    }

    try:
        # First, try single-night booking
        rate_info = fetch_booking_rate(page, hotel["name"], city_name, check_in, check_out)

        if rate_info.get("availability_status") == "sold_out" or (
            rate_info.get("availability_status") == "available" and rate_info.get("rate") is None
        ):
            # Likely 2-night minimum - try multi-night calculation
            print(f"    Single night unavailable, trying 2-night calculation...")
            rate_info = calculate_rate_from_multi_night(page, hotel, city_name, check_in)

        result.update(rate_info)

    except PlaywrightTimeout:
        result["error"] = "Navigation timeout"
        result["availability_status"] = "error"
    except Exception as e:
        result["error"] = str(e)
        result["availability_status"] = "error"

    return result


def run_scraper(cities: list[str] = None, dry_run: bool = False):
    """
    Run the scraper for specified cities.

    Args:
        cities: List of city keys to scrape (e.g., ["toronto", "vancouver"]).
                If None, scrapes all cities.
        dry_run: If True, only print what would be scraped without actually scraping.
    """
    config = load_config()
    settings = config["scrape_settings"]

    # Determine which cities to scrape
    if cities is None:
        cities = list(config["cities"].keys())

    # Prepare output directory
    now = datetime.now(timezone.utc)
    scrape_date = now.strftime("%Y-%m-%d")
    scrape_timestamp = now.strftime("%Y%m%d_%H%M%S")
    output_dir = DATA_DIR / scrape_date
    output_dir.mkdir(parents=True, exist_ok=True)

    all_results = []
    errors = []

    print(f"PitchPrice Hotel Rate Scraper")
    print(f"==============================")
    print(f"Scrape date: {scrape_date}")
    print(f"Cities: {', '.join(cities)}")
    print()

    if dry_run:
        print("DRY RUN - Not actually scraping")
        print()
        for city_key in cities:
            city_config = config["cities"][city_key]
            dates = generate_dates(
                city_config["date_range"]["start"],
                city_config["date_range"]["end"]
            )
            print(f"{city_config['name']}: {len(city_config['hotels'])} hotels x {len(dates)} dates = {len(city_config['hotels']) * len(dates)} requests")
        return

    with sync_playwright() as p:
        # Launch browser with stealth settings
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
            ]
        )

        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale='en-CA',
            timezone_id='America/Toronto',
        )

        page = context.new_page()

        # Apply stealth
        stealth_sync(page)

        for city_key in cities:
            city_config = config["cities"][city_key]
            city_name = city_config["name"]

            print(f"\nScraping {city_name}")
            print("-" * 40)

            dates = generate_dates(
                city_config["date_range"]["start"],
                city_config["date_range"]["end"]
            )

            for hotel in city_config["hotels"]:
                print(f"\nHotel: {hotel['name']}")

                for check_in in dates:
                    result = scrape_hotel_rate(page, hotel, city_name, check_in)
                    all_results.append(result)

                    if result["error"]:
                        errors.append({
                            "hotel": hotel["name"],
                            "date": check_in,
                            "error": result["error"]
                        })
                        print(f"    {check_in}: ERROR - {result['error']}")
                    elif result["rate"]:
                        print(f"    {check_in}: ${result['rate']} {result['currency']}")
                    else:
                        print(f"    {check_in}: {result['availability_status']}")

                    # Random delay between requests
                    delay = random.uniform(
                        settings["delay_min_seconds"],
                        settings["delay_max_seconds"]
                    )
                    time.sleep(delay)

        browser.close()

    # Save results
    output_file = output_dir / f"scrape_{scrape_timestamp}.json"
    output_data = {
        "scrape_metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "cities_scraped": cities,
            "total_results": len(all_results),
            "errors_count": len(errors)
        },
        "results": all_results,
        "errors": errors
    }

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\n\nScrape complete!")
    print(f"Results saved to: {output_file}")
    print(f"Total results: {len(all_results)}")
    print(f"Errors: {len(errors)}")

    # Also update the latest.json symlink/copy for dashboard
    latest_file = DATA_DIR / "latest.json"
    with open(latest_file, "w") as f:
        json.dump(output_data, f, indent=2)
    print(f"Latest data updated: {latest_file}")

    # Update the aggregated data file for the dashboard
    update_aggregated_data()

    return output_data


def update_aggregated_data():
    """
    Aggregate all historical scrape data into a single file for the dashboard.
    This allows the dashboard to show trends over time.
    """
    all_scrapes = []

    # Find all scrape files
    for date_dir in sorted(DATA_DIR.iterdir()):
        if date_dir.is_dir() and re.match(r'\d{4}-\d{2}-\d{2}', date_dir.name):
            for scrape_file in sorted(date_dir.glob("scrape_*.json")):
                with open(scrape_file, "r") as f:
                    data = json.load(f)
                    all_scrapes.append({
                        "scrape_date": date_dir.name,
                        "file": scrape_file.name,
                        "metadata": data.get("scrape_metadata", {}),
                        "results": data.get("results", [])
                    })

    # Save aggregated data
    aggregated_file = DATA_DIR / "aggregated.json"
    with open(aggregated_file, "w") as f:
        json.dump({
            "last_updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "total_scrapes": len(all_scrapes),
            "scrapes": all_scrapes
        }, f, indent=2)

    print(f"Aggregated data updated: {aggregated_file}")


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="PitchPrice Hotel Rate Scraper")
    parser.add_argument(
        "--cities",
        nargs="+",
        choices=["toronto", "vancouver"],
        help="Cities to scrape (default: all)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be scraped without actually scraping"
    )

    args = parser.parse_args()

    run_scraper(cities=args.cities, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
