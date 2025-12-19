/**
 * PitchPrice Dashboard
 * FIFA 2026 Hotel Rate Tracker
 */

// Configuration - will be loaded from config file
let CONFIG = null;
let CITIES_CONFIG = null;  // Cities config extracted from events
let EVENT_INFO = null;     // Event metadata
let DATA = null;
let CHARTS = {};
let EXCLUDED_HOTELS = new Set();  // Hotels excluded from Rate Evolution chart

// Chart.js default dark theme configuration
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';

// Segment colors
const SEGMENT_COLORS = {
    luxury: '#a371f7',
    upscale: '#58a6ff',
    midscale: '#3fb950',
    economy: '#d29922'
};

// Generate distinct colors for hotels
const HOTEL_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7',
    '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#bc8cff',
    '#a5d6ff', '#7ee787', '#f2cc60', '#ffa198', '#d2a8ff',
    '#39d353', '#2ea043', '#9e6a03', '#cf222e', '#8957e5',
    '#1f6feb', '#238636', '#bb8009', '#da3633', '#8250df'
];

/**
 * Initialize the dashboard
 */
async function init() {
    try {
        // Load configuration
        const configResponse = await fetch('../config/hotels.json');
        CONFIG = await configResponse.json();

        // Extract cities config (supports both new events-based and legacy schema)
        extractCitiesConfig();

        // Populate city filter dynamically
        populateCityFilter();

        // Populate game dates in the About section
        populateGameDates();

        // Try to load data
        await loadData();

        // Setup filters
        setupFilters();

        // Populate date filter with available dates from data
        populateDateFilter(getAllResults());

        // Initial render
        renderDashboard();

    } catch (error) {
        console.error('Failed to initialize dashboard:', error);
        showError('Failed to load dashboard. Please try refreshing the page.');
    }
}

/**
 * Extract cities config from the configuration (supports both new and legacy schema)
 */
function extractCitiesConfig() {
    // New schema: events.{event_id}.cities
    if (CONFIG.events && CONFIG.events.fifa_2026) {
        CITIES_CONFIG = CONFIG.events.fifa_2026.cities;
        EVENT_INFO = {
            event_id: 'fifa_2026',
            event_name: CONFIG.events.fifa_2026.name,
            event_type: CONFIG.events.fifa_2026.event_type
        };
    }
    // Legacy schema: cities at root level
    else if (CONFIG.cities) {
        CITIES_CONFIG = CONFIG.cities;
        EVENT_INFO = {
            event_id: 'fifa_2026',
            event_name: 'FIFA World Cup 2026',
            event_type: 'fifa'
        };
    }
    else {
        throw new Error('Invalid config format: no cities found');
    }
}

/**
 * Populate the city filter dropdown dynamically from config
 */
function populateCityFilter() {
    const cityFilter = document.getElementById('city-filter');
    if (!cityFilter || !CITIES_CONFIG) return;

    // Clear existing options except "All Cities"
    cityFilter.innerHTML = '<option value="all">All Cities</option>';

    // Add cities from config
    for (const [cityKey, cityConfig] of Object.entries(CITIES_CONFIG)) {
        const cityType = cityConfig.city_type || 'event_host';
        const label = cityType === 'control'
            ? `${cityConfig.name} (Control)`
            : cityConfig.name;

        const option = document.createElement('option');
        option.value = cityKey;
        option.textContent = label;
        cityFilter.appendChild(option);
    }
}

/**
 * Load scraped data from JSON files
 */
async function loadData() {
    try {
        // Try to load aggregated data first
        const response = await fetch('../data/scrapes/aggregated.json');

        if (!response.ok) {
            // If aggregated doesn't exist, try latest
            const latestResponse = await fetch('../data/scrapes/latest.json');
            if (!latestResponse.ok) {
                throw new Error('No data available');
            }
            const latestData = await latestResponse.json();
            DATA = {
                last_updated: latestData.scrape_metadata?.timestamp,
                total_scrapes: 1,
                scrapes: [{
                    scrape_date: new Date().toISOString().split('T')[0],
                    results: latestData.results || []
                }]
            };
        } else {
            DATA = await response.json();
        }

        // Update data freshness indicator
        updateDataFreshness();

    } catch (error) {
        console.warn('Could not load data:', error);
        // Create empty data structure for demo
        DATA = {
            last_updated: null,
            total_scrapes: 0,
            scrapes: []
        };
        updateDataFreshness();
    }
}

/**
 * Update the data freshness indicator
 */
function updateDataFreshness() {
    const indicator = document.querySelector('.status-indicator');
    const lastUpdateEl = document.getElementById('last-update');

    if (!DATA || !DATA.last_updated) {
        indicator.classList.add('error');
        lastUpdateEl.textContent = 'No data available - waiting for first scrape';
        return;
    }

    // Use the most recent scrape timestamp from the data
    let lastUpdate = new Date(DATA.last_updated);

    // Also check the most recent scrape_timestamp from results
    const allResults = getAllResults();
    for (const result of allResults) {
        if (result.scrape_timestamp) {
            const resultDate = new Date(result.scrape_timestamp);
            if (resultDate > lastUpdate) {
                lastUpdate = resultDate;
            }
        }
    }

    const now = new Date();
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

    if (hoursSinceUpdate > 168) { // More than a week
        indicator.classList.add('stale');
        indicator.classList.remove('error');
    } else {
        indicator.classList.remove('stale', 'error');
    }

    lastUpdateEl.textContent = `Last updated: ${formatDate(lastUpdate)} (${formatRelativeTime(lastUpdate)})`;
}

/**
 * Populate game dates in the About section
 */
function populateGameDates() {
    if (!CITIES_CONFIG) return;

    for (const [cityKey, cityConfig] of Object.entries(CITIES_CONFIG)) {
        const listEl = document.getElementById(`${cityKey}-game-dates`);
        if (listEl) {
            // Support both new (event_dates) and legacy (game_dates) schema
            const eventDates = cityConfig.event_dates || cityConfig.game_dates || [];

            if (eventDates.length === 0) {
                // Control city - no game dates
                listEl.innerHTML = '<li class="no-games">No event dates (control city)</li>';
            } else {
                listEl.innerHTML = eventDates
                    .map(date => `<li>${formatGameDate(date)}</li>`)
                    .join('');
            }
        }
    }
}

/**
 * Setup filter event listeners
 */
function setupFilters() {
    const filters = ['city-filter', 'segment-filter', 'proximity-filter', 'city-type-filter'];

    filters.forEach(filterId => {
        const el = document.getElementById(filterId);
        if (el) {
            el.addEventListener('change', () => renderDashboard());
        }
    });
}

/**
 * Populate the date filter checkboxes dynamically from data
 */
function populateDateFilter(allResults) {
    const container = document.getElementById('date-filter');
    if (!container) return;

    // Get unique check-in dates from data
    const dates = [...new Set(allResults.map(r => r.check_in_date))].filter(Boolean).sort();

    if (dates.length === 0) {
        container.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.8rem;">No dates available</span>';
        return;
    }

    // Get event dates from config for highlighting (only from event host cities)
    let gameDates = [];
    if (CITIES_CONFIG) {
        for (const cityConfig of Object.values(CITIES_CONFIG)) {
            if (cityConfig.city_type !== 'control') {
                const eventDates = cityConfig.event_dates || cityConfig.game_dates || [];
                gameDates.push(...eventDates);
            }
        }
    }
    gameDates = [...new Set(gameDates)];

    // Add All/None/Game Days controls
    const controls = document.createElement('div');
    controls.className = 'date-filter-controls';
    controls.innerHTML = `
        <button type="button" id="select-all-dates">All</button>
        <button type="button" id="select-none-dates">None</button>
        <button type="button" id="select-game-dates">Game Days</button>
    `;
    container.parentNode.insertBefore(controls, container);

    // Render checkboxes
    container.innerHTML = dates.map(date => {
        const formatted = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric'
        });
        const isGameDate = gameDates.includes(date);
        return `
            <label class="date-checkbox-item${isGameDate ? ' game-date' : ''}">
                <input type="checkbox" value="${date}" checked>
                ${formatted}
            </label>
        `;
    }).join('');

    // Add event listeners for checkboxes
    container.querySelectorAll('input').forEach(cb => {
        cb.addEventListener('change', () => renderDashboard());
    });

    // Add event listeners for control buttons
    document.getElementById('select-all-dates')?.addEventListener('click', () => {
        container.querySelectorAll('input').forEach(cb => cb.checked = true);
        renderDashboard();
    });
    document.getElementById('select-none-dates')?.addEventListener('click', () => {
        container.querySelectorAll('input').forEach(cb => cb.checked = false);
        renderDashboard();
    });
    document.getElementById('select-game-dates')?.addEventListener('click', () => {
        container.querySelectorAll('input').forEach(cb => {
            cb.checked = gameDates.includes(cb.value);
        });
        renderDashboard();
    });
}

/**
 * Get current filter values
 */
function getFilters() {
    const dateCheckboxes = document.querySelectorAll('#date-filter input:checked');
    const selectedDates = Array.from(dateCheckboxes).map(cb => cb.value);

    return {
        city: document.getElementById('city-filter')?.value || 'all',
        cityType: document.getElementById('city-type-filter')?.value || 'all',
        segment: document.getElementById('segment-filter')?.value || 'all',
        proximity: document.getElementById('proximity-filter')?.value || 'all',
        dates: selectedDates.length > 0 ? selectedDates : 'all'
    };
}

/**
 * Filter results based on current selections
 */
function filterResults(results) {
    const filters = getFilters();

    return results.filter(result => {
        if (filters.city !== 'all' && result.city?.toLowerCase() !== filters.city) {
            return false;
        }
        // Filter by city type (event_host or control)
        if (filters.cityType !== 'all') {
            const resultCityType = result.city_type || 'event_host';
            if (resultCityType !== filters.cityType) {
                return false;
            }
        }
        if (filters.segment !== 'all' && result.segment !== filters.segment) {
            return false;
        }
        // Support both venue_proximity (new) and proximity (legacy)
        const resultProximity = result.venue_proximity || result.proximity;
        if (filters.proximity !== 'all' && resultProximity !== filters.proximity) {
            return false;
        }
        if (filters.dates !== 'all' && !filters.dates.includes(result.check_in_date)) {
            return false;
        }
        return true;
    });
}

/**
 * Get all hotels from config matching current filters
 */
function getFilteredHotels() {
    const filters = getFilters();
    let hotels = [];

    if (!CITIES_CONFIG) return hotels;

    for (const [cityKey, cityConfig] of Object.entries(CITIES_CONFIG)) {
        if (filters.city !== 'all' && cityKey !== filters.city) continue;

        // Filter by city type
        const cityType = cityConfig.city_type || 'event_host';
        if (filters.cityType !== 'all' && cityType !== filters.cityType) continue;

        for (const hotel of cityConfig.hotels) {
            if (filters.segment !== 'all' && hotel.segment !== filters.segment) continue;
            // Support both venue_proximity (new) and proximity (legacy)
            const hotelProximity = hotel.venue_proximity || hotel.proximity;
            if (filters.proximity !== 'all' && hotelProximity !== filters.proximity) continue;

            hotels.push({
                ...hotel,
                cityKey,
                cityName: cityConfig.name,
                cityType: cityType,
                // Normalize proximity field name
                proximity: hotelProximity
            });
        }
    }

    return hotels;
}

/**
 * Get all results flattened across all scrapes
 */
function getAllResults() {
    if (!DATA || !DATA.scrapes) return [];

    const results = [];
    for (const scrape of DATA.scrapes) {
        if (scrape.results) {
            for (const result of scrape.results) {
                results.push({
                    ...result,
                    scrape_date: scrape.scrape_date
                });
            }
        }
    }
    return results;
}

/**
 * Render the entire dashboard
 */
function renderDashboard() {
    const allResults = getAllResults();
    const filteredResults = filterResults(allResults);

    updateSummaryCards(filteredResults);
    renderRateEvolutionChart(filteredResults);
    renderComparisonChart(filteredResults);
    renderLeadTimeCurvesChart(allResults);  // Use all results for city comparison
    renderEventPremiumChart(allResults);     // Use all results for control comparison
    renderLeadTimeChart(filteredResults);
    renderAvailabilityTable(filteredResults);
}

/**
 * Update summary cards
 */
function updateSummaryCards(results) {
    const resultsWithRates = results.filter(r => r.rate && r.rate > 0);

    const rates = resultsWithRates.map(r => r.rate);

    const avgRate = rates.length > 0
        ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
        : '--';

    // Find min and max records (not just values)
    let minRecord = null;
    let maxRecord = null;

    if (resultsWithRates.length > 0) {
        minRecord = resultsWithRates.reduce((min, r) => r.rate < min.rate ? r : min);
        maxRecord = resultsWithRates.reduce((max, r) => r.rate > max.rate ? r : max);
    }

    // Count unique hotels with data in filtered results
    const uniqueHotels = new Set(resultsWithRates.map(r => r.hotel_id));
    const hotelsCount = uniqueHotels.size;

    // Update values
    document.getElementById('avg-rate').textContent = avgRate !== '--' ? `$${avgRate}` : '--';
    document.getElementById('min-rate').textContent = minRecord ? `$${minRecord.rate}` : '--';
    document.getElementById('max-rate').textContent = maxRecord ? `$${maxRecord.rate}` : '--';
    document.getElementById('hotels-count').textContent = hotelsCount;

    // Update context for min rate
    const minContext = document.getElementById('min-rate-context');
    if (minContext && minRecord) {
        const minDate = new Date(minRecord.check_in_date + 'T00:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        minContext.innerHTML = `
            <span class="hotel-name">${minRecord.hotel_name}</span><br>
            <span class="date-info">${minDate}</span>
        `;
    } else if (minContext) {
        minContext.innerHTML = '';
    }

    // Update context for max rate
    const maxContext = document.getElementById('max-rate-context');
    if (maxContext && maxRecord) {
        const maxDate = new Date(maxRecord.check_in_date + 'T00:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        maxContext.innerHTML = `
            <span class="hotel-name">${maxRecord.hotel_name}</span><br>
            <span class="date-info">${maxDate}</span>
        `;
    } else if (maxContext) {
        maxContext.innerHTML = '';
    }
}

/**
 * Populate hotel toggle buttons for the Rate Evolution chart
 */
function populateHotelToggles(hotels, hotelData) {
    const container = document.getElementById('hotel-toggles');
    if (!container) return;

    // Sort hotels by highest average rate (descending) so outliers are at top
    const hotelsWithRates = hotels.map(hotel => {
        const data = hotelData[hotel.id]?.data || [];
        const rates = data.map(d => d.y).filter(r => r > 0);
        const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
        return { ...hotel, avgRate };
    }).sort((a, b) => b.avgRate - a.avgRate);

    container.innerHTML = hotelsWithRates.map((hotel, index) => {
        const isExcluded = EXCLUDED_HOTELS.has(hotel.id);
        const color = HOTEL_COLORS[hotels.findIndex(h => h.id === hotel.id) % HOTEL_COLORS.length];
        const rateDisplay = hotel.avgRate > 0 ? `$${Math.round(hotel.avgRate)}` : '--';
        return `
            <button type="button"
                    class="hotel-toggle ${isExcluded ? 'excluded' : ''}"
                    data-hotel-id="${hotel.id}"
                    style="--hotel-color: ${color}">
                <span class="hotel-toggle-name">${hotel.name}</span>
                <span class="hotel-toggle-rate">${rateDisplay}</span>
            </button>
        `;
    }).join('');

    // Add click handlers
    container.querySelectorAll('.hotel-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const hotelId = btn.dataset.hotelId;
            if (EXCLUDED_HOTELS.has(hotelId)) {
                EXCLUDED_HOTELS.delete(hotelId);
                btn.classList.remove('excluded');
            } else {
                EXCLUDED_HOTELS.add(hotelId);
                btn.classList.add('excluded');
            }
            // Re-render chart with updated exclusions
            const allResults = getAllResults();
            const filteredResults = filterResults(allResults);
            renderRateEvolutionChart(filteredResults, true);  // true = skip toggle refresh
        });
    });
}

/**
 * Render the rate evolution chart
 */
function renderRateEvolutionChart(results, skipToggleRefresh = false) {
    const ctx = document.getElementById('rate-evolution-chart');
    if (!ctx) return;

    // Destroy existing chart
    if (CHARTS.rateEvolution) {
        CHARTS.rateEvolution.destroy();
    }

    if (results.length === 0) {
        showNoData(ctx, 'No rate data available');
        return;
    }

    // Group results by hotel and scrape date
    const hotelData = {};
    const hotels = getFilteredHotels();

    hotels.forEach((hotel, index) => {
        hotelData[hotel.id] = {
            id: hotel.id,
            label: hotel.name,
            color: HOTEL_COLORS[index % HOTEL_COLORS.length],
            data: []
        };
    });

    // Organize data by hotel
    for (const result of results) {
        if (hotelData[result.hotel_id] && result.rate) {
            hotelData[result.hotel_id].data.push({
                x: new Date(result.scrape_date + 'T12:00:00'),
                y: result.rate,
                checkIn: result.check_in_date
            });
        }
    }

    // Populate hotel toggles (only on full refresh, not when toggling)
    if (!skipToggleRefresh) {
        populateHotelToggles(hotels, hotelData);
    }

    // Create datasets with sorted data, filtering out excluded hotels
    const datasets = Object.values(hotelData)
        .filter(h => h.data.length > 0 && !EXCLUDED_HOTELS.has(h.id))
        .map(h => {
            // Sort data points by date chronologically
            const sortedData = [...h.data].sort((a, b) => {
                return new Date(a.x) - new Date(b.x);
            });
            return {
                label: h.label,
                data: sortedData,
                borderColor: h.color,
                backgroundColor: h.color + '20',
                tension: 0.3,
                fill: false,
                pointRadius: 3,
                pointHoverRadius: 6
            };
        });

    // Get all unique dates and sort them chronologically for x-axis labels
    const allDates = new Set();
    for (const dataset of datasets) {
        for (const point of dataset.data) {
            allDates.add(point.x);
        }
    }
    const sortedLabels = [...allDates].sort((a, b) => new Date(a) - new Date(b));

    // Get event dates for annotations (only from event host cities)
    const filters = getFilters();
    let gameDates = [];

    if (filters.city === 'all') {
        for (const cityConfig of Object.values(CITIES_CONFIG || {})) {
            if (cityConfig.city_type !== 'control') {
                const eventDates = cityConfig.event_dates || cityConfig.game_dates || [];
                gameDates.push(...eventDates);
            }
        }
    } else {
        const cityConfig = CITIES_CONFIG?.[filters.city];
        gameDates = cityConfig?.event_dates || cityConfig?.game_dates || [];
    }

    gameDates = [...new Set(gameDates)].sort();

    CHARTS.rateEvolution = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        displayFormats: {
                            day: 'yyyy-MM-dd'
                        },
                        tooltipFormat: 'yyyy-MM-dd'
                    },
                    title: {
                        display: true,
                        text: 'Scrape Date'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Rate (CAD)'
                    },
                    beginAtZero: false
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        boxWidth: 12,
                        padding: 15
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const data = context.raw;
                            return `${context.dataset.label}: $${data.y} (check-in: ${data.checkIn})`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render the comparison chart
 */
function renderComparisonChart(results) {
    const ctx = document.getElementById('comparison-chart');
    if (!ctx) return;

    if (CHARTS.comparison) {
        CHARTS.comparison.destroy();
    }

    const hotels = getFilteredHotels();

    if (hotels.length === 0) {
        showNoData(ctx, 'No hotels match the current filters');
        return;
    }

    // Get latest rate for each hotel
    const latestRates = {};

    for (const result of results) {
        if (result.rate) {
            const existing = latestRates[result.hotel_id];
            if (!existing || result.scrape_date > existing.scrape_date) {
                latestRates[result.hotel_id] = result;
            }
        }
    }

    // Group hotels by segment
    const segmentGroups = {
        luxury: [],
        upscale: [],
        midscale: [],
        economy: []
    };

    hotels.forEach(hotel => {
        const rate = latestRates[hotel.id]?.rate || 0;
        segmentGroups[hotel.segment].push({
            name: hotel.name,
            rate: rate,
            city: hotel.cityName
        });
    });

    // Flatten for chart
    const labels = [];
    const data = [];
    const colors = [];

    for (const [segment, hotels] of Object.entries(segmentGroups)) {
        for (const hotel of hotels) {
            labels.push(`${hotel.name} (${hotel.city})`);
            data.push(hotel.rate);
            colors.push(SEGMENT_COLORS[segment]);
        }
    }

    CHARTS.comparison = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Latest Rate (CAD)',
                data,
                backgroundColor: colors,
                borderColor: colors.map(c => c + 'ff'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Rate (CAD)'
                    },
                    beginAtZero: true
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: (context) => `$${context.raw} CAD`
                    }
                }
            }
        }
    });
}

/**
 * Render the lead-time pricing curves chart (Hero Chart)
 * Shows indexed rates by city over days to event
 */
function renderLeadTimeCurvesChart(results) {
    const ctx = document.getElementById('lead-time-curves-chart');
    if (!ctx) return;

    if (CHARTS.leadTimeCurves) {
        CHARTS.leadTimeCurves.destroy();
    }

    if (results.length === 0) {
        showNoData(ctx, 'No data available for lead-time analysis');
        return;
    }

    // Group results by city
    const cityData = {};
    const cityColors = {
        'Toronto': '#58a6ff',
        'Vancouver': '#3fb950',
        'Montreal': '#d29922'
    };

    // Calculate baseline rates (first observation per hotel)
    const baselineRates = {};
    for (const result of results) {
        if (!result.rate || !result.hotel_id) continue;
        const key = result.hotel_id;
        if (!baselineRates[key] || result.scrape_date < baselineRates[key].scrape_date) {
            baselineRates[key] = { rate: result.rate, scrape_date: result.scrape_date };
        }
    }

    // Calculate indexed rates and group by city and days_to_event
    for (const result of results) {
        if (!result.rate || !result.city) continue;

        const cityName = result.city;
        if (!cityData[cityName]) {
            cityData[cityName] = {};
        }

        // Use days_to_event from result, or calculate lead time for control cities
        let daysToEvent = result.days_to_event;
        if (daysToEvent === undefined || daysToEvent === null) {
            // For control cities, calculate lead time from scrape to check-in date
            // This allows comparison with event host cities at the same lead times
            if (result.check_in_date && result.scrape_timestamp) {
                const checkIn = new Date(result.check_in_date + 'T00:00:00');
                const scrapeDate = new Date(result.scrape_timestamp.split('T')[0] + 'T00:00:00');
                daysToEvent = Math.floor((checkIn - scrapeDate) / (1000 * 60 * 60 * 24));
            } else {
                continue;
            }
        }

        // Calculate indexed rate (100 = baseline)
        const baseline = baselineRates[result.hotel_id];
        const indexedRate = baseline ? (result.rate / baseline.rate * 100) : 100;

        if (!cityData[cityName][daysToEvent]) {
            cityData[cityName][daysToEvent] = [];
        }
        cityData[cityName][daysToEvent].push(indexedRate);
    }

    // Average indexed rates per city per days_to_event
    const datasets = [];
    for (const [cityName, dayData] of Object.entries(cityData)) {
        const points = [];
        for (const [days, rates] of Object.entries(dayData)) {
            const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
            points.push({ x: parseInt(days), y: avgRate });
        }
        // Sort by days to event
        points.sort((a, b) => b.x - a.x);

        if (points.length > 0) {
            datasets.push({
                label: cityName,
                data: points,
                borderColor: cityColors[cityName] || '#8b949e',
                backgroundColor: (cityColors[cityName] || '#8b949e') + '20',
                tension: 0.3,
                fill: false,
                pointRadius: 4,
                pointHoverRadius: 6,
                borderWidth: cityName === 'Montreal' ? 2 : 3,
                borderDash: cityName === 'Montreal' ? [5, 5] : []
            });
        }
    }

    if (datasets.length === 0) {
        showNoData(ctx, 'No lead-time data available');
        return;
    }

    CHARTS.leadTimeCurves = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Days to Event (T-60 to T-0)'
                    },
                    reverse: true,
                    min: -5,
                    max: 60
                },
                y: {
                    title: {
                        display: true,
                        text: 'Indexed Rate (100 = baseline)'
                    },
                    beginAtZero: false,
                    suggestedMin: 80,
                    suggestedMax: 150
                }
            },
            plugins: {
                legend: {
                    position: 'bottom'
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            return `${context.dataset.label}: ${context.raw.y.toFixed(1)} (${context.raw.x} days out)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render the event premium chart
 * Shows difference between event host cities and Montreal control
 */
function renderEventPremiumChart(results) {
    const ctx = document.getElementById('event-premium-chart');
    if (!ctx) return;

    if (CHARTS.eventPremium) {
        CHARTS.eventPremium.destroy();
    }

    if (results.length === 0) {
        showNoData(ctx, 'No data available for event premium analysis');
        return;
    }

    // Group results by city and segment
    const citySegmentRates = {};

    for (const result of results) {
        if (!result.rate || !result.city || !result.segment) continue;

        const cityType = result.city_type || (result.city === 'Montreal' ? 'control' : 'event_host');
        const key = `${result.city}-${result.segment}`;

        if (!citySegmentRates[key]) {
            citySegmentRates[key] = {
                city: result.city,
                segment: result.segment,
                cityType: cityType,
                rates: []
            };
        }
        citySegmentRates[key].rates.push(result.rate);
    }

    // Calculate average rates per city/segment
    const avgRates = {};
    for (const [key, data] of Object.entries(citySegmentRates)) {
        avgRates[key] = {
            ...data,
            avgRate: data.rates.reduce((a, b) => a + b, 0) / data.rates.length
        };
    }

    // Get Montreal control rates by segment
    const montrealRates = {};
    for (const segment of ['luxury', 'upscale', 'midscale', 'economy']) {
        const key = `Montreal-${segment}`;
        if (avgRates[key]) {
            montrealRates[segment] = avgRates[key].avgRate;
        }
    }

    // Calculate premium for each event host city/segment
    const labels = [];
    const premiumData = [];
    const percentPremiumData = [];
    const colors = [];

    const segmentColors = {
        luxury: '#a371f7',
        upscale: '#58a6ff',
        midscale: '#3fb950',
        economy: '#d29922'
    };

    for (const [key, data] of Object.entries(avgRates)) {
        if (data.cityType === 'control') continue; // Skip Montreal

        const controlRate = montrealRates[data.segment];
        if (!controlRate) continue;

        const premium = data.avgRate - controlRate;
        const percentPremium = ((data.avgRate / controlRate) - 1) * 100;

        labels.push(`${data.city} ${data.segment.charAt(0).toUpperCase() + data.segment.slice(1)}`);
        premiumData.push(premium);
        percentPremiumData.push(percentPremium);
        colors.push(segmentColors[data.segment] || '#8b949e');
    }

    if (labels.length === 0) {
        showNoData(ctx, 'No comparison data available (need both event host and control city data)');
        return;
    }

    CHARTS.eventPremium = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Premium vs Montreal ($)',
                data: premiumData,
                backgroundColor: colors,
                borderColor: colors.map(c => c + 'ff'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Premium vs Montreal Control (CAD)'
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const idx = context.dataIndex;
                            const premium = premiumData[idx];
                            const percent = percentPremiumData[idx];
                            const sign = premium >= 0 ? '+' : '';
                            return `${sign}$${premium.toFixed(0)} (${sign}${percent.toFixed(1)}%)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render the lead-time analysis chart
 */
function renderLeadTimeChart(results) {
    const ctx = document.getElementById('lead-time-chart');
    if (!ctx) return;

    if (CHARTS.leadTime) {
        CHARTS.leadTime.destroy();
    }

    if (results.length === 0) {
        showNoData(ctx, 'No lead-time data available');
        return;
    }

    // Get all event dates (only from event host cities)
    const filters = getFilters();
    let gameDates = [];

    if (filters.city === 'all') {
        for (const cityConfig of Object.values(CITIES_CONFIG || {})) {
            if (cityConfig.city_type !== 'control') {
                const eventDates = cityConfig.event_dates || cityConfig.game_dates || [];
                gameDates.push(...eventDates);
            }
        }
    } else {
        const cityConfig = CITIES_CONFIG?.[filters.city];
        gameDates = cityConfig?.event_dates || cityConfig?.game_dates || [];
    }

    gameDates = [...new Set(gameDates)].map(d => new Date(d));

    // Calculate days until nearest game for each result
    const leadTimeData = [];

    for (const result of results) {
        if (!result.rate || !result.check_in_date || !result.scrape_date) continue;

        const checkIn = new Date(result.check_in_date);
        const scrapeDate = new Date(result.scrape_date);

        // Find nearest game date to check-in
        let minDaysToGame = Infinity;
        for (const gameDate of gameDates) {
            const daysToGame = Math.abs((gameDate - checkIn) / (1000 * 60 * 60 * 24));
            if (daysToGame < minDaysToGame) {
                minDaysToGame = daysToGame;
            }
        }

        // Only include if check-in is within 3 days of a game date
        if (minDaysToGame <= 3) {
            const daysBeforeCheckIn = Math.floor((checkIn - scrapeDate) / (1000 * 60 * 60 * 24));
            if (daysBeforeCheckIn > 0) {
                leadTimeData.push({
                    x: daysBeforeCheckIn,
                    y: result.rate,
                    hotel: result.hotel_name,
                    segment: result.segment
                });
            }
        }
    }

    // Group by segment
    const segmentData = {};
    for (const point of leadTimeData) {
        if (!segmentData[point.segment]) {
            segmentData[point.segment] = [];
        }
        segmentData[point.segment].push(point);
    }

    const datasets = Object.entries(segmentData).map(([segment, points]) => ({
        label: segment.charAt(0).toUpperCase() + segment.slice(1),
        data: points,
        backgroundColor: SEGMENT_COLORS[segment] + '60',
        borderColor: SEGMENT_COLORS[segment],
        pointRadius: 4,
        pointHoverRadius: 6
    }));

    CHARTS.leadTime = new Chart(ctx, {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Days Before Check-in'
                    },
                    reverse: true,
                    min: 0
                },
                y: {
                    title: {
                        display: true,
                        text: 'Rate (CAD)'
                    },
                    beginAtZero: false
                }
            },
            plugins: {
                legend: {
                    position: 'bottom'
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const data = context.raw;
                            return `${data.hotel}: $${data.y} (${context.raw.x} days out)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render the availability table
 */
function renderAvailabilityTable(results) {
    const tbody = document.getElementById('availability-tbody');
    if (!tbody) return;

    const hotels = getFilteredHotels();

    if (hotels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-data">No hotels match the current filters</td></tr>';
        return;
    }

    // Get event dates per city (only for event host cities)
    const gameDatesByCity = {};
    for (const [cityKey, cityConfig] of Object.entries(CITIES_CONFIG || {})) {
        gameDatesByCity[cityKey] = cityConfig.event_dates || cityConfig.game_dates || [];
    }

    // Get latest results per hotel/date combo
    const latestByHotelDate = {};
    for (const result of results) {
        const key = `${result.hotel_id}-${result.check_in_date}`;
        if (!latestByHotelDate[key] || result.scrape_date > latestByHotelDate[key].scrape_date) {
            latestByHotelDate[key] = result;
        }
    }

    // Build table rows
    const rows = hotels.map(hotel => {
        const cityGameDates = gameDatesByCity[hotel.cityKey] || [];

        // Get availability for each game date
        const gameAvailability = cityGameDates.map(gameDate => {
            const key = `${hotel.id}-${gameDate}`;
            const result = latestByHotelDate[key];
            return {
                date: gameDate,
                status: result?.availability_status || 'unknown',
                rate: result?.rate
            };
        });

        // Get latest rate across all dates
        let latestRate = null;
        for (const [key, result] of Object.entries(latestByHotelDate)) {
            if (key.startsWith(hotel.id + '-') && result.rate) {
                if (!latestRate || result.scrape_date > latestRate.scrape_date) {
                    latestRate = result;
                }
            }
        }

        return `
            <tr>
                <td><strong>${hotel.name}</strong></td>
                <td>${hotel.cityName}</td>
                <td><span class="segment-badge ${hotel.segment}">${hotel.segment}</span></td>
                <td class="game-date-cell">
                    ${gameAvailability.map(ga => `
                        <span class="game-date-indicator">
                            <span class="date">${formatShortDate(ga.date)}</span>
                            <span class="status ${ga.status}"></span>
                        </span>
                    `).join('')}
                </td>
                <td>${latestRate?.rate ? `$${latestRate.rate}` : '--'}</td>
            </tr>
        `;
    });

    tbody.innerHTML = rows.join('');
}

/**
 * Show no data message in a chart container
 */
function showNoData(ctx, message) {
    const container = ctx.parentElement;
    container.innerHTML = `
        <div class="no-data">
            <div class="no-data-icon">📊</div>
            <p>${message}</p>
        </div>
    `;
}

/**
 * Show error message
 */
function showError(message) {
    const main = document.querySelector('main');
    if (main) {
        main.innerHTML = `
            <div class="no-data" style="height: 400px;">
                <div class="no-data-icon">⚠️</div>
                <p>${message}</p>
            </div>
        `;
    }
}

// Formatting utilities

function formatDate(date) {
    return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function formatGameDate(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    return new Intl.DateTimeFormat('en-CA', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    }).format(date);
}

function formatShortDate(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    return new Intl.DateTimeFormat('en-CA', {
        month: 'short',
        day: 'numeric'
    }).format(date);
}

function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days} day${days === 1 ? '' : 's'} ago`;
    } else if (hours > 0) {
        return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    } else {
        return 'just now';
    }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', init);
