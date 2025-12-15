/**
 * PitchPrice Dashboard
 * FIFA 2026 Hotel Rate Tracker
 */

// Configuration - will be loaded from config file
let CONFIG = null;
let DATA = null;
let CHARTS = {};

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

        // Populate game dates in the About section
        populateGameDates();

        // Try to load data
        await loadData();

        // Setup filters
        setupFilters();

        // Initial render
        renderDashboard();

    } catch (error) {
        console.error('Failed to initialize dashboard:', error);
        showError('Failed to load dashboard. Please try refreshing the page.');
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

    const lastUpdate = new Date(DATA.last_updated);
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
    if (!CONFIG) return;

    for (const [cityKey, cityConfig] of Object.entries(CONFIG.cities)) {
        const listEl = document.getElementById(`${cityKey}-game-dates`);
        if (listEl) {
            listEl.innerHTML = cityConfig.game_dates
                .map(date => `<li>${formatGameDate(date)}</li>`)
                .join('');
        }
    }
}

/**
 * Setup filter event listeners
 */
function setupFilters() {
    const filters = ['city-filter', 'segment-filter', 'proximity-filter'];

    filters.forEach(filterId => {
        const el = document.getElementById(filterId);
        if (el) {
            el.addEventListener('change', () => renderDashboard());
        }
    });
}

/**
 * Get current filter values
 */
function getFilters() {
    return {
        city: document.getElementById('city-filter')?.value || 'all',
        segment: document.getElementById('segment-filter')?.value || 'all',
        proximity: document.getElementById('proximity-filter')?.value || 'all'
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
        if (filters.segment !== 'all' && result.segment !== filters.segment) {
            return false;
        }
        if (filters.proximity !== 'all' && result.proximity !== filters.proximity) {
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

    for (const [cityKey, cityConfig] of Object.entries(CONFIG.cities)) {
        if (filters.city !== 'all' && cityKey !== filters.city) continue;

        for (const hotel of cityConfig.hotels) {
            if (filters.segment !== 'all' && hotel.segment !== filters.segment) continue;
            if (filters.proximity !== 'all' && hotel.proximity !== filters.proximity) continue;

            hotels.push({
                ...hotel,
                cityKey,
                cityName: cityConfig.name
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
    renderLeadTimeChart(filteredResults);
    renderAvailabilityTable(filteredResults);
}

/**
 * Update summary cards
 */
function updateSummaryCards(results) {
    const rates = results
        .filter(r => r.rate && r.rate > 0)
        .map(r => r.rate);

    const avgRate = rates.length > 0
        ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
        : '--';

    const minRate = rates.length > 0
        ? Math.min(...rates)
        : '--';

    const maxRate = rates.length > 0
        ? Math.max(...rates)
        : '--';

    const hotels = getFilteredHotels();

    document.getElementById('avg-rate').textContent = avgRate !== '--' ? `$${avgRate}` : '--';
    document.getElementById('min-rate').textContent = minRate !== '--' ? `$${minRate}` : '--';
    document.getElementById('max-rate').textContent = maxRate !== '--' ? `$${maxRate}` : '--';
    document.getElementById('hotels-count').textContent = hotels.length;
}

/**
 * Render the rate evolution chart
 */
function renderRateEvolutionChart(results) {
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
            label: hotel.name,
            color: HOTEL_COLORS[index % HOTEL_COLORS.length],
            data: []
        };
    });

    // Organize data by hotel
    for (const result of results) {
        if (hotelData[result.hotel_id] && result.rate) {
            hotelData[result.hotel_id].data.push({
                x: result.scrape_date,
                y: result.rate,
                checkIn: result.check_in_date
            });
        }
    }

    // Create datasets
    const datasets = Object.values(hotelData)
        .filter(h => h.data.length > 0)
        .map(h => ({
            label: h.label,
            data: h.data,
            borderColor: h.color,
            backgroundColor: h.color + '20',
            tension: 0.3,
            fill: false,
            pointRadius: 3,
            pointHoverRadius: 6
        }));

    // Get game dates for annotations
    const filters = getFilters();
    let gameDates = [];

    if (filters.city === 'all') {
        for (const cityConfig of Object.values(CONFIG.cities)) {
            gameDates.push(...cityConfig.game_dates);
        }
    } else {
        gameDates = CONFIG.cities[filters.city]?.game_dates || [];
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
                    type: 'category',
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

    // Get all game dates
    const filters = getFilters();
    let gameDates = [];

    if (filters.city === 'all') {
        for (const cityConfig of Object.values(CONFIG.cities)) {
            gameDates.push(...cityConfig.game_dates);
        }
    } else {
        gameDates = CONFIG.cities[filters.city]?.game_dates || [];
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

    // Get game dates per city
    const gameDatesByCity = {};
    for (const [cityKey, cityConfig] of Object.entries(CONFIG.cities)) {
        gameDatesByCity[cityKey] = cityConfig.game_dates;
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
