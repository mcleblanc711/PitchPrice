#!/usr/bin/env python3
"""
PitchPrice Hotel Rate Scraper

Scrapes hotel rates from Booking.com for FIFA 2026 World Cup dates
in Toronto and Vancouver.
"""

import json
import logging
import os
import random
import re
import sys
import time
import traceback
import warnings
from collections import Counter
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import quote_plus

# Suppress deprecation warning from playwright_stealth's use of pkg_resources
warnings.filterwarnings("ignore", message="pkg_resources is deprecated")

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from playwright_stealth import stealth_sync


class BrowserCorruptionError(Exception):
    """Raised when browser/context is corrupted and needs restart."""
    pass


def is_browser_corruption_error(error: Exception) -> bool:
    """Check if an exception indicates browser/context corruption."""
    error_str = str(error).lower()
    error_type = type(error).__name__

    corruption_indicators = [
        "'dict' object has no attribute '_object'",
        "object has been collected",
        "target page, context or browser has been closed",
        "browser has been closed",
        "context has been closed",
        "page has been closed",
        "connection closed",
        "target closed",
    ]

    for indicator in corruption_indicators:
        if indicator.lower() in error_str.lower():
            return True

    return False


# Paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "config" / "hotels.json"
DATA_DIR = PROJECT_ROOT / "data" / "scrapes"
LOG_DIR = SCRIPT_DIR / "logs"

# Ensure log directory exists
LOG_DIR.mkdir(exist_ok=True)

# Configure logging
logger = logging.getLogger("pitchprice")
logger.setLevel(logging.DEBUG)

# File handler with rotation (5 MB, 5 backups)
file_handler = RotatingFileHandler(
    LOG_DIR / "scraper.log",
    maxBytes=5 * 1024 * 1024,
    backupCount=5
)
file_handler.setLevel(logging.DEBUG)
file_formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - %(message)s'
)
file_handler.setFormatter(file_formatter)

# Console handler
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - %(message)s'
)
console_handler.setFormatter(console_formatter)

logger.addHandler(file_handler)
logger.addHandler(console_handler)


def load_config():
    """Load the hotels configuration file."""
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


def get_event_cities(config: dict, event_id: str = "fifa_2026") -> dict:
    """
    Get cities configuration for an event.

    Supports both new events-based schema and legacy flat schema for backwards compatibility.

    Args:
        config: The full config dict
        event_id: Event identifier (default: fifa_2026)

    Returns:
        Dict of city configurations
    """
    # New schema: events.{event_id}.cities
    if "events" in config and event_id in config["events"]:
        return config["events"][event_id]["cities"]
    # Legacy schema: cities at root level
    elif "cities" in config:
        return config["cities"]
    else:
        raise ValueError("Invalid config format: no cities found")


def get_event_info(config: dict, event_id: str = "fifa_2026") -> dict:
    """Get event metadata."""
    if "events" in config and event_id in config["events"]:
        event = config["events"][event_id]
        return {
            "event_id": event_id,
            "event_name": event.get("name"),
            "event_type": event.get("event_type", "unknown")
        }
    return {
        "event_id": event_id,
        "event_name": "Unknown Event",
        "event_type": "unknown"
    }


def calculate_days_to_event(check_in_date: str, event_dates: list) -> dict:
    """
    Calculate days to nearest event date.

    Args:
        check_in_date: Check-in date in YYYY-MM-DD format
        event_dates: List of event dates in YYYY-MM-DD format

    Returns:
        Dict with days_to_event and nearest_event_date
    """
    if not event_dates:
        return {"days_to_event": None, "nearest_event_date": None}

    check_in = datetime.strptime(check_in_date, "%Y-%m-%d")

    # Find the nearest event date
    nearest = None
    min_days = float('inf')

    for event_date in event_dates:
        event_dt = datetime.strptime(event_date, "%Y-%m-%d")
        days = (event_dt - check_in).days
        if abs(days) < abs(min_days):
            min_days = days
            nearest = event_date

    return {
        "days_to_event": min_days,
        "nearest_event_date": nearest
    }


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
                logger.debug(f"Dismissed cookie popup using selector: {selector}")
                return True
        except PlaywrightTimeout:
            logger.debug(f"Cookie selector {selector} timed out")
            continue
        except Exception as e:
            logger.debug(f"Cookie dismiss failed with {selector}: {type(e).__name__}: {e}")
            continue
    return False


def capture_page_diagnostics(page, hotel_name: str, context: str) -> dict:
    """Capture diagnostic information from a page for debugging."""
    diagnostics = {
        "context": context,
        "hotel": hotel_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    try:
        diagnostics["page_title"] = page.title()
    except Exception:
        diagnostics["page_title"] = "Error getting title"

    try:
        diagnostics["page_url"] = page.url
    except Exception:
        diagnostics["page_url"] = "Error getting URL"

    try:
        property_cards = page.locator('[data-testid="property-card"]').count()
        diagnostics["property_card_count"] = property_cards
    except Exception:
        diagnostics["property_card_count"] = -1

    try:
        page_text = page.inner_text("body", timeout=5000)
        all_prices = re.findall(r'(?:CA\$|CAD|C\$)\s*([\d,]+)', page_text)
        diagnostics["all_prices_found"] = [int(p.replace(',', '')) for p in all_prices[:20]]
    except Exception:
        diagnostics["all_prices_found"] = []

    try:
        body_text = page.inner_text("body", timeout=5000).lower()
        diagnostics["has_no_availability"] = "no availability" in body_text
        diagnostics["has_sold_out"] = "sold out" in body_text
        diagnostics["has_captcha"] = "captcha" in body_text or "verify" in body_text
    except Exception:
        diagnostics["has_no_availability"] = None
        diagnostics["has_sold_out"] = None
        diagnostics["has_captcha"] = None

    return diagnostics


def format_exception(e: Exception) -> str:
    """Format exception with type and traceback for logging."""
    exc_type = type(e).__name__
    exc_tb = ''.join(traceback.format_exception(type(e), e, e.__traceback__))
    return f"{exc_type}: {e}\nTraceback:\n{exc_tb}"


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

    except PlaywrightTimeout as e:
        diagnostics = capture_page_diagnostics(page, hotel_name, "extraction_timeout")
        logger.error(f"Timeout extracting rate for {hotel_name}")
        logger.debug(f"Timeout diagnostics: {diagnostics}")
        result["error"] = "Page load timeout"
        result["availability_status"] = "error"
        result["diagnostics"] = diagnostics
    except Exception as e:
        diagnostics = capture_page_diagnostics(page, hotel_name, "extraction_error")
        logger.error(f"Error extracting rate for {hotel_name}: {type(e).__name__}: {e}")
        logger.debug(f"Error diagnostics: {diagnostics}")
        result["error"] = f"{type(e).__name__}: {e}"
        result["availability_status"] = "error"
        result["diagnostics"] = diagnostics

    return result


def fetch_booking_rate(page, hotel_name: str, city_name: str, check_in: str, check_out: str, max_retries: int = 3) -> dict:
    """
    Fetch rate from Booking.com for a specific date range with retry support.

    Returns:
        Dict with rate (TOTAL for the stay) and availability_status
    """
    url = build_booking_url(hotel_name, city_name, check_in, check_out)

    # Calculate number of nights
    check_in_dt = datetime.strptime(check_in, "%Y-%m-%d")
    check_out_dt = datetime.strptime(check_out, "%Y-%m-%d")
    num_nights = (check_out_dt - check_in_dt).days

    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            logger.debug(f"Attempt {attempt}/{max_retries}: {hotel_name} {check_in}")

            response = page.goto(url, wait_until="domcontentloaded", timeout=60000)

            # Capture HTTP status for diagnostics
            http_status = response.status if response else None
            logger.debug(f"HTTP status: {http_status} for {hotel_name}")

            if http_status and http_status >= 400:
                logger.warning(f"HTTP {http_status} for {hotel_name} on attempt {attempt}")

            time.sleep(4)
            page.wait_for_load_state("networkidle", timeout=30000)
            time.sleep(1)

            result = extract_rate_from_booking(page, hotel_name, num_nights)

            # If successful extraction, return
            if result.get("rate") is not None or result.get("availability_status") in ["sold_out", "not_found"]:
                if attempt > 1:
                    logger.info(f"Succeeded on attempt {attempt} for {hotel_name}")
                return result

            # If error but not a hard failure, might want to retry
            if result.get("availability_status") == "error":
                raise Exception(result.get("error", "Unknown extraction error"))

            return result

        except PlaywrightTimeout as e:
            last_error = e
            logger.warning(f"Timeout on attempt {attempt}/{max_retries} for {hotel_name}: {e}")
            if attempt < max_retries:
                backoff = 2 * attempt
                logger.debug(f"Backing off {backoff}s before retry")
                time.sleep(backoff)
        except Exception as e:
            last_error = e
            logger.warning(f"Error on attempt {attempt}/{max_retries} for {hotel_name}: {type(e).__name__}: {e}")

            # Check if this is a browser corruption error - don't retry, need context refresh
            if is_browser_corruption_error(e):
                logger.error(f"Browser corruption detected for {hotel_name}, need context refresh")
                raise BrowserCorruptionError(f"Browser corrupted: {type(e).__name__}: {e}") from e

            if attempt < max_retries:
                backoff = 2 * attempt
                logger.debug(f"Backing off {backoff}s before retry")
                time.sleep(backoff)

    # All retries exhausted
    logger.error(f"Failed after {max_retries} attempts for {hotel_name}: {type(last_error).__name__}: {last_error}")
    return {
        "rate": None,
        "availability_status": "error",
        "error": f"Failed after {max_retries} attempts: {type(last_error).__name__}: {last_error}"
    }


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
    logger.debug(f"Trying 2-night calculation (prev+target) for {hotel_name}")

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
        logger.debug(f"2-night (prev+target): ${two_night_1['rate']}, 1-night prev: ${one_night_prev['rate']}, Calculated: ${calculated_rate_1}")
        result["rate_calculation"] = {
            "method": "prev+target minus prev",
            "two_night_total": two_night_1["rate"],
            "prev_night_rate": one_night_prev["rate"],
            "calculated": calculated_rate_1
        }

    # Method 2: (Target + Next) 2-night total minus Next 1-night
    # e.g., (Sat+Sun) - Sun = Sat
    logger.debug(f"Verifying with 2-night calculation (target+next) for {hotel_name}")

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
        logger.debug(f"2-night (target+next): ${two_night_2['rate']}, 1-night next: ${one_night_next['rate']}, Calculated: ${calculated_rate_2}")
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
            logger.debug(f"VERIFIED: Both methods agree (~${result['rate']}) for {hotel_name}")
        else:
            # Use the average but note discrepancy
            result["rate"] = int(round(avg))
            result["availability_status"] = "available_calculated"
            result["error"] = f"Calculation methods differ by ${diff}"
            logger.warning(f"Methods differ by ${diff} for {hotel_name}, using average ${result['rate']}")
    elif calculated_rate_1:
        result["rate"] = calculated_rate_1
        result["availability_status"] = "available_calculated"
        logger.debug(f"Using first method: ${calculated_rate_1} for {hotel_name}")
    elif calculated_rate_2:
        result["rate"] = calculated_rate_2
        result["availability_status"] = "available_calculated"
        logger.debug(f"Using second method: ${calculated_rate_2} for {hotel_name}")
    else:
        result["error"] = "Could not calculate rate from multi-night bookings"
        result["availability_status"] = "not_found"
        logger.warning(f"Could not calculate rate from multi-night bookings for {hotel_name}")

    return result


def scrape_hotel_rate(page, hotel: dict, city_name: str, city_config: dict, event_info: dict, check_in: str) -> dict:
    """
    Scrape the rate for a single hotel on a single date from Booking.com.

    If the date has a minimum stay requirement (shows as sold out for 1 night),
    calculates the rate from 2-night bookings.

    Args:
        page: Playwright page object
        hotel: Hotel configuration dict
        city_name: City name
        city_config: City configuration dict (for event dates, city_type, etc.)
        event_info: Event metadata dict
        check_in: Check-in date (YYYY-MM-DD)

    Returns:
        Dict with scrape results
    """
    check_out = (datetime.strptime(check_in, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    # Get event dates for this city (empty for control cities)
    event_dates = city_config.get("event_dates", city_config.get("game_dates", []))

    # Calculate days to event
    lead_time = calculate_days_to_event(check_in, event_dates)

    # Get venue proximity (new name) or proximity (legacy)
    venue_proximity = hotel.get("venue_proximity", hotel.get("proximity"))

    result = {
        "hotel_id": hotel["id"],
        "hotel_name": hotel["name"],
        "city": city_name,
        "segment": hotel["segment"],
        "venue_proximity": venue_proximity,
        "proximity": venue_proximity,  # Keep for backwards compatibility
        "check_in_date": check_in,
        "check_out_date": check_out,
        "rate": None,
        "currency": "CAD",
        "availability_status": "unknown",
        "scrape_timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "error": None,
        # New fields for lead-time analysis
        "event_id": event_info.get("event_id"),
        "event_type": event_info.get("event_type"),
        "city_type": city_config.get("city_type", "event_host"),
        "control_for": city_config.get("control_for"),
        "days_to_event": lead_time["days_to_event"],
        "nearest_event_date": lead_time["nearest_event_date"]
    }

    try:
        # First, try single-night booking
        rate_info = fetch_booking_rate(page, hotel["name"], city_name, check_in, check_out)

        if rate_info.get("availability_status") == "sold_out" or (
            rate_info.get("availability_status") == "available" and rate_info.get("rate") is None
        ):
            # Likely 2-night minimum - try multi-night calculation
            logger.debug(f"Single night unavailable for {hotel['name']}, trying 2-night calculation")
            rate_info = calculate_rate_from_multi_night(page, hotel, city_name, check_in)

        result.update(rate_info)

    except PlaywrightTimeout:
        result["error"] = "Navigation timeout"
        result["availability_status"] = "error"
    except Exception as e:
        result["error"] = str(e)
        result["availability_status"] = "error"

    return result


def generate_scrape_report(all_results: list, errors: list) -> dict:
    """Generate a summary report of the scrape session."""
    report = {
        "total_requests": len(all_results),
        "successful": len([r for r in all_results if r.get("rate") is not None]),
        "errors": len(errors),
        "error_rate": f"{(len(errors) / len(all_results) * 100):.1f}%" if all_results else "N/A",
        "error_breakdown": {},
        "hotels_with_issues": [],
    }

    # Categorize errors
    for err in errors:
        error_msg = err.get("error", "Unknown")
        # Extract error category
        if "heap growth" in error_msg.lower():
            category = "Memory/Heap"
        elif "timeout" in error_msg.lower():
            category = "Timeout"
        elif "could not calculate" in error_msg.lower():
            category = "Multi-night calculation"
        elif "not found" in error_msg.lower():
            category = "Hotel not found"
        elif "failed after" in error_msg.lower():
            category = "Retry exhausted"
        else:
            category = "Other"

        report["error_breakdown"][category] = report["error_breakdown"].get(category, 0) + 1

    # Find hotels with high error rates
    hotel_errors = {}
    for r in all_results:
        hotel_id = r.get("hotel_id")
        if hotel_id:
            if hotel_id not in hotel_errors:
                hotel_errors[hotel_id] = {"total": 0, "errors": 0, "name": r.get("hotel_name")}
            hotel_errors[hotel_id]["total"] += 1
            if r.get("error"):
                hotel_errors[hotel_id]["errors"] += 1

    for hotel_id, stats in hotel_errors.items():
        if stats["errors"] > 0:
            error_rate = stats["errors"] / stats["total"]
            if error_rate >= 0.5:  # 50%+ error rate
                report["hotels_with_issues"].append({
                    "hotel_id": hotel_id,
                    "hotel_name": stats["name"],
                    "error_rate": f"{error_rate*100:.0f}%",
                    "errors": stats["errors"],
                    "total": stats["total"]
                })

    return report


def run_scraper(cities: list[str] = None, event_id: str = "fifa_2026", dry_run: bool = False):
    """
    Run the scraper for specified cities with memory management.

    Args:
        cities: List of city keys to scrape (e.g., ["toronto", "vancouver", "montreal"]).
                If None, scrapes all cities for the event.
        event_id: Event identifier (default: fifa_2026)
        dry_run: If True, only print what would be scraped without actually scraping.
    """
    config = load_config()
    settings = config["scrape_settings"]
    max_retries = settings.get("max_retries", 3)

    # Get cities config using helper (supports both new and legacy schema)
    cities_config = get_event_cities(config, event_id)
    event_info = get_event_info(config, event_id)

    # Determine which cities to scrape
    if cities is None:
        cities = list(cities_config.keys())

    # Prepare output directory
    now = datetime.now(timezone.utc)
    scrape_date = now.strftime("%Y-%m-%d")
    scrape_timestamp = now.strftime("%Y%m%d_%H%M%S")
    output_dir = DATA_DIR / scrape_date
    output_dir.mkdir(parents=True, exist_ok=True)

    all_results = []
    errors = []

    logger.info("=" * 60)
    logger.info("PitchPrice Hotel Rate Scraper")
    logger.info("=" * 60)
    logger.info(f"Scrape date: {scrape_date}")
    logger.info(f"Cities: {', '.join(cities)}")
    logger.info(f"Log file: {LOG_DIR / 'scraper.log'}")

    if dry_run:
        logger.info("DRY RUN - Not actually scraping")
        for city_key in cities:
            city_config = cities_config[city_key]
            # Support both new (scrape_date_range) and legacy (date_range) schema
            date_range = city_config.get("scrape_date_range", city_config.get("date_range", {}))
            dates = generate_dates(date_range["start"], date_range["end"])
            city_type = city_config.get("city_type", "event_host")
            logger.info(f"{city_config['name']} ({city_type}): {len(city_config['hotels'])} hotels x {len(dates)} dates = {len(city_config['hotels']) * len(dates)} requests")
        return

    # Memory management: refresh context every N hotels
    # Reduced to 3 for aggressive memory management after corruption issues
    REQUESTS_BEFORE_CONTEXT_REFRESH = 3
    request_count = 0

    with sync_playwright() as p:
        browser = None
        context = None
        page = None

        def launch_browser():
            """Launch a fresh browser instance."""
            nonlocal browser
            return p.chromium.launch(
                headless=True,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--single-process',
                    '--disable-extensions',
                    '--js-flags=--max-old-space-size=512',  # Limit JS heap
                ]
            )

        def create_fresh_context():
            """Create a new browser context with stealth settings."""
            nonlocal browser, context, page

            # If browser is dead, restart it
            try:
                if browser is None or not browser.is_connected():
                    logger.info("Browser not connected, launching new browser")
                    browser = launch_browser()
            except Exception as e:
                logger.warning(f"Browser check failed, restarting: {e}")
                try:
                    if browser:
                        browser.close()
                except:
                    pass
                browser = launch_browser()

            ctx = browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale='en-CA',
                timezone_id='America/Toronto',
            )
            pg = ctx.new_page()
            stealth_sync(pg)
            return ctx, pg

        browser = launch_browser()
        context, page = create_fresh_context()
        logger.debug("Initial browser context created")

        for city_key in cities:
            city_config = cities_config[city_key]
            city_name = city_config["name"]
            city_type = city_config.get("city_type", "event_host")

            logger.info(f"Scraping {city_name} ({city_type})")

            # Support both new (scrape_date_range) and legacy (date_range) schema
            date_range = city_config.get("scrape_date_range", city_config.get("date_range", {}))
            dates = generate_dates(date_range["start"], date_range["end"])

            for hotel in city_config["hotels"]:
                logger.info(f"Hotel: {hotel['name']}")

                # Refresh context periodically to prevent memory leaks
                request_count += 1
                if request_count % REQUESTS_BEFORE_CONTEXT_REFRESH == 0:
                    logger.info(f"Refreshing browser context after {request_count} hotel batches")
                    try:
                        context.close()
                    except Exception as e:
                        logger.warning(f"Error closing old context: {e}")
                    try:
                        context, page = create_fresh_context()
                    except Exception as e:
                        logger.error(f"Failed to create fresh context: {e}, restarting browser")
                        try:
                            browser.close()
                        except:
                            pass
                        browser = launch_browser()
                        context, page = create_fresh_context()
                    time.sleep(2)  # Give browser time to stabilize

                for check_in in dates:
                    # Retry loop for browser corruption recovery
                    max_corruption_retries = 2
                    for corruption_retry in range(max_corruption_retries + 1):
                        try:
                            result = scrape_hotel_rate(page, hotel, city_name, city_config, event_info, check_in)
                            break  # Success, exit retry loop
                        except BrowserCorruptionError as e:
                            if corruption_retry < max_corruption_retries:
                                logger.warning(f"Browser corruption on {hotel['name']} {check_in}, refreshing browser (attempt {corruption_retry + 1}/{max_corruption_retries})")
                                # Close and restart everything
                                try:
                                    context.close()
                                except Exception:
                                    pass
                                try:
                                    browser.close()
                                except Exception:
                                    pass
                                time.sleep(2)
                                browser = launch_browser()
                                context, page = create_fresh_context()
                                logger.info("Browser restarted after corruption")
                                time.sleep(2)
                            else:
                                # Exhausted retries, record error
                                logger.error(f"Browser corruption persists for {hotel['name']} {check_in} after {max_corruption_retries} restarts")
                                result = {
                                    "hotel_id": hotel["id"],
                                    "hotel_name": hotel["name"],
                                    "city": city_name,
                                    "segment": hotel["segment"],
                                    "venue_proximity": hotel.get("venue_proximity", hotel.get("proximity")),
                                    "proximity": hotel.get("venue_proximity", hotel.get("proximity")),
                                    "check_in_date": check_in,
                                    "check_out_date": (datetime.strptime(check_in, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d"),
                                    "rate": None,
                                    "currency": "CAD",
                                    "availability_status": "error",
                                    "scrape_timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                                    "error": str(e),
                                    "event_id": event_info.get("event_id"),
                                    "event_type": event_info.get("event_type"),
                                    "city_type": city_config.get("city_type", "event_host"),
                                    "control_for": city_config.get("control_for"),
                                    "days_to_event": None,
                                    "nearest_event_date": None
                                }

                    all_results.append(result)

                    if result["error"]:
                        errors.append({
                            "hotel": hotel["name"],
                            "date": check_in,
                            "error": result["error"]
                        })
                        logger.error(f"{hotel['name']} {check_in}: ERROR - {result['error']}")
                    elif result["rate"]:
                        logger.info(f"{hotel['name']} {check_in}: ${result['rate']} {result['currency']}")
                    else:
                        logger.info(f"{hotel['name']} {check_in}: {result['availability_status']}")

                    # Random delay between requests
                    delay = random.uniform(
                        settings["delay_min_seconds"],
                        settings["delay_max_seconds"]
                    )
                    time.sleep(delay)

        # Clean up
        try:
            context.close()
        except Exception:
            pass
        browser.close()
        logger.debug("Browser closed")

    # Generate session report
    report = generate_scrape_report(all_results, errors)

    # Save results
    output_file = output_dir / f"scrape_{scrape_timestamp}.json"
    output_data = {
        "scrape_metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "event_id": event_info.get("event_id"),
            "event_name": event_info.get("event_name"),
            "cities_scraped": cities,
            "total_results": len(all_results),
            "errors_count": len(errors)
        },
        "results": all_results,
        "errors": errors,
        "report": report
    }

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2)

    # Log session report
    logger.info("=" * 60)
    logger.info("SCRAPE SESSION REPORT")
    logger.info("=" * 60)
    logger.info(f"Total requests: {report['total_requests']}")
    logger.info(f"Successful: {report['successful']}")
    logger.info(f"Errors: {report['errors']} ({report['error_rate']})")

    if report['error_breakdown']:
        logger.info("Error breakdown:")
        for category, count in report['error_breakdown'].items():
            logger.info(f"  - {category}: {count}")

    if report['hotels_with_issues']:
        logger.warning("Hotels with high error rates (>=50%):")
        for h in report['hotels_with_issues']:
            logger.warning(f"  - {h['hotel_name']}: {h['error_rate']} ({h['errors']}/{h['total']})")

    logger.info(f"Results saved to: {output_file}")

    # Also update the latest.json symlink/copy for dashboard
    latest_file = DATA_DIR / "latest.json"
    with open(latest_file, "w") as f:
        json.dump(output_data, f, indent=2)
    logger.info(f"Latest data updated: {latest_file}")

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

    logger.info(f"Aggregated data updated: {aggregated_file}")


def main():
    """Main entry point."""
    import argparse

    # Load config to get available cities
    config = load_config()
    cities_config = get_event_cities(config, "fifa_2026")
    available_cities = list(cities_config.keys())

    parser = argparse.ArgumentParser(description="PitchPrice Hotel Rate Scraper")
    parser.add_argument(
        "--cities",
        nargs="+",
        help=f"Cities to scrape (available: {', '.join(available_cities)}). Default: all"
    )
    parser.add_argument(
        "--event",
        default="fifa_2026",
        help="Event ID to scrape (default: fifa_2026)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be scraped without actually scraping"
    )

    args = parser.parse_args()

    # Validate cities if provided
    if args.cities:
        invalid = [c for c in args.cities if c not in available_cities]
        if invalid:
            parser.error(f"Invalid cities: {', '.join(invalid)}. Available: {', '.join(available_cities)}")

    run_scraper(cities=args.cities, event_id=args.event, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
