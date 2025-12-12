import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const INDICATORS = {
  LIFE_EXPECTANCY: {
    id: "SP.DYN.LE00.IN",
    label: "Life expectancy at birth",
    unitLatest: "years",
    chartValueFormatter: (v) => `${v.toFixed(1)} years`,
  },
  HEALTH_EXPENDITURE_PC: {
    id: "SH.XPD.CHEX.PC.CD",
    label: "Health expenditure per capita",
    unitLatest: "US$",
    chartValueFormatter: (v) => `$${Math.round(v).toLocaleString()}`,
  },
  INFANT_MORTALITY: {
    id: "SP.DYN.IMRT.IN",
    label: "Infant mortality rate",
    unitLatest: "per 1,000",
    chartValueFormatter: (v) => `${v.toFixed(1)} per 1,000`,
  },
  UNDER5_MORTALITY: {
    id: "SH.DYN.MORT",
    label: "Under-5 mortality rate",
    unitLatest: "per 1,000",
    chartValueFormatter: (v) => `${v.toFixed(1)} per 1,000`,
  },
};

// Simple in-memory cache: Map(countryCode -> { data, cachedAt })
const countryIndicatorsCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

function isFresh(entry) {
  if (!entry) return false;
  if (CACHE_TTL_MS == null) return true;
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function App() {
  const [selectedCountry, setSelectedCountry] = useState("GLOBAL");

  // Compare mode
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareCountry, setCompareCountry] = useState("USA");

  // Country list state
  const [countries, setCountries] = useState([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [countriesError, setCountriesError] = useState(null);

  // Data state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Primary country indicators: { KEY: [{year, value}, ...] }
  const [seriesByIndicator, setSeriesByIndicator] = useState({});
  // Compare country indicators
  const [compareSeriesByIndicator, setCompareSeriesByIndicator] = useState({});

  // Which indicator the chart is currently showing
  const [selectedChartKey, setSelectedChartKey] = useState("LIFE_EXPECTANCY");

  // Fetch list of countries once
  useEffect(() => {
    async function fetchCountries() {
      setCountriesLoading(true);
      setCountriesError(null);
      try {
        const url =
          "https://api.worldbank.org/v2/country?format=json&per_page=400";
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Countries request failed: ${res.status}`);

        const data = await res.json();
        const list = data[1] || [];

        const filtered = list.filter(
          (c) => c.region && c.region.id !== "NA" && c.name && c.id
        );
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        setCountries(filtered);
      } catch (err) {
        console.error(err);
        setCountriesError("Could not load countries list.");
      } finally {
        setCountriesLoading(false);
      }
    }

    fetchCountries();
  }, []);

  // CSV helpers
  function escapeCsv(value) {
    const s = String(value ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replaceAll('"', '""')}"`;
    }
    return s;
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  }

  function makeSafeFilename(s) {
    return String(s)
      .trim()
      .replaceAll(" ", "_")
      .replaceAll("/", "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");
  }

  // Helper: fetch a single indicator series
  async function fetchIndicatorSeries(countryCode, indicatorId) {
    const url = `https://api.worldbank.org/v2/country/${countryCode}/indicator/${indicatorId}?format=json&per_page=80`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Indicator ${indicatorId} failed: ${res.status}`);

    const data = await res.json();
    const raw = data[1] || [];

    return raw
      .filter((entry) => entry.value !== null)
      .map((entry) => ({
        year: Number(entry.date),
        value: Number(entry.value),
      }))
      .sort((a, b) => a.year - b.year);
  }

  // Fetch all indicators for a country (with caching)
  async function getAllIndicatorsForCountry(countryCode) {
    const cached = countryIndicatorsCache.get(countryCode);
    if (isFresh(cached)) return cached.data;

    const keys = Object.keys(INDICATORS);
    const results = await Promise.all(
      keys.map(async (key) => {
        const indicatorId = INDICATORS[key].id;
        const series = await fetchIndicatorSeries(countryCode, indicatorId);
        return [key, series];
      })
    );

    const data = Object.fromEntries(results);
    countryIndicatorsCache.set(countryCode, { data, cachedAt: Date.now() });
    return data;
  }

  // Load primary indicators when selectedCountry changes
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setError(null);

      const code = selectedCountry === "GLOBAL" ? "WLD" : selectedCountry;

      const cached = countryIndicatorsCache.get(code);
      if (isFresh(cached)) {
        setSeriesByIndicator(cached.data);
        return;
      }

      setLoading(true);
      try {
        const data = await getAllIndicatorsForCountry(code);
        if (!cancelled) setSeriesByIndicator(data);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("Could not load health indicators. Please try again.");
          setSeriesByIndicator({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  // Load compare indicators when compareEnabled/compareCountry changes
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!compareEnabled) {
        setCompareSeriesByIndicator({});
        return;
      }

      setError(null);

      const code = compareCountry === "GLOBAL" ? "USA" : compareCountry;

      const cached = countryIndicatorsCache.get(code);
      if (isFresh(cached)) {
        setCompareSeriesByIndicator(cached.data);
        return;
      }

      setLoading(true);
      try {
        const data = await getAllIndicatorsForCountry(code);
        if (!cancelled) setCompareSeriesByIndicator(data);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("Could not load comparison indicators. Please try again.");
          setCompareSeriesByIndicator({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [compareEnabled, compareCountry]);

  // Latest cards for primary country
  const latestCards = useMemo(() => {
    return Object.keys(INDICATORS).map((key) => {
      const meta = INDICATORS[key];
      const series = seriesByIndicator[key] || [];
      const latest = series.length ? series[series.length - 1] : null;
      const first = series.length ? series[0] : null;

      const change = latest && first ? latest.value - first.value : null;

      return {
        key,
        label: meta.label,
        latestValue: latest?.value ?? null,
        latestYear: latest?.year ?? null,
        startYear: first?.year ?? null,
        change,
        unit: meta.unitLatest,
      };
    });
  }, [seriesByIndicator]);

  // Country names
  const primaryCountryName = useMemo(() => {
    if (selectedCountry === "GLOBAL") return "World";
    const found = countries.find((c) => c.id === selectedCountry);
    return found?.name ?? selectedCountry;
  }, [countries, selectedCountry]);

  const compareCountryName = useMemo(() => {
    const found = countries.find((c) => c.id === compareCountry);
    return found?.name ?? compareCountry;
  }, [countries, compareCountry]);

  const chartMeta = INDICATORS[selectedChartKey];

  // Merge data for compare chart
  const mergedChartData = useMemo(() => {
    const a = seriesByIndicator[selectedChartKey] || [];
    const byYearA = new Map(a.map((p) => [p.year, p.value]));

    if (!compareEnabled) {
      return a.map((p) => ({ year: p.year, a: p.value }));
    }

    const b = compareSeriesByIndicator[selectedChartKey] || [];
    const byYearB = new Map(b.map((p) => [p.year, p.value]));

    const years = Array.from(
      new Set([...byYearA.keys(), ...byYearB.keys()])
    ).sort((x, y) => x - y);

    return years.map((year) => ({
      year,
      a: byYearA.get(year) ?? null,
      b: byYearB.get(year) ?? null,
    }));
  }, [
    compareEnabled,
    compareSeriesByIndicator,
    selectedChartKey,
    seriesByIndicator,
  ]);

  const latestForMetric = useMemo(() => {
    const aSeries = seriesByIndicator[selectedChartKey] || [];
    const bSeries = compareSeriesByIndicator[selectedChartKey] || [];

    const aLatest = aSeries.length ? aSeries[aSeries.length - 1] : null;
    const bLatest = bSeries.length ? bSeries[bSeries.length - 1] : null;

    return { a: aLatest, b: bLatest };
  }, [compareSeriesByIndicator, selectedChartKey, seriesByIndicator]);

  // Formatting
  const formatLatest = (key, value) => {
    if (value === null || value === undefined) return "No data";
    if (key === "HEALTH_EXPENDITURE_PC")
      return `$${Math.round(value).toLocaleString()}`;
    if (key === "LIFE_EXPECTANCY") return `${value.toFixed(1)} years`;
    return `${value.toFixed(1)} per 1,000`;
  };

  const formatChange = (key, change) => {
    if (change === null || change === undefined) return "n/a";
    const sign = change >= 0 ? "+" : "";
    if (key === "HEALTH_EXPENDITURE_PC")
      return `${sign}${Math.round(change).toLocaleString()}`;
    return `${sign}${change.toFixed(1)}`;
  };

  function handleDownloadCsv() {
  if (!mergedChartData || mergedChartData.length === 0) return;

  const metricLabel = chartMeta.label;

  const primaryName = primaryCountryName;
  const compareName = compareCountryName;

  let header;
  let rows;

  if (!compareEnabled) {
    header = [
      "year",
      `${metricLabel} (${primaryName})`
    ];
    rows = mergedChartData.map((r) => [
      r.year,
      r.a ?? ""
    ]);
  } else {
    header = [
      "year",
      `${metricLabel} (${primaryName})`,
      `${metricLabel} (${compareName})`
    ];
    rows = mergedChartData.map((r) => [
      r.year,
      r.a ?? "",
      r.b ?? ""
    ]);
  }

  const csv =
    header.map(escapeCsv).join(",") +
    "\n" +
    rows.map((row) => row.map(escapeCsv).join(",")).join("\n");

  const filenameBase = !compareEnabled
    ? `${metricLabel}__${primaryName}`
    : `${metricLabel}__${primaryName}_vs_${compareName}`;

  const filename = `${makeSafeFilename(filenameBase)}.csv`;

  downloadTextFile(filename, csv);
}


  return (
    <div className="app">
      <header className="app-header">
        <h1>Health Data Tracker</h1>
        <p className="app-subtitle">
          Visualising global health statistics using public APIs.
        </p>
      </header>

      <main className="app-main">
        <section className="controls-panel">
          <div className="panel-header">
            <h2>Filters</h2>
          </div>

          <div className="control-group">
            <label htmlFor="country-select">Primary country</label>
            <select
              id="country-select"
              value={selectedCountry}
              onChange={(e) => setSelectedCountry(e.target.value)}
              disabled={countriesLoading}
            >
              <option value="GLOBAL">Global (World)</option>
              {countriesError && <option disabled>Could not load countries</option>}
              {!countriesError &&
                countries.map((country) => (
                  <option key={country.id} value={country.id}>
                    {country.name}
                  </option>
                ))}
            </select>
            {countriesLoading && (
              <span className="hint-text">Loading countries…</span>
            )}
          </div>

          <div className="control-group">
            <label htmlFor="metric-select">Chart metric</label>
            <select
              id="metric-select"
              value={selectedChartKey}
              onChange={(e) => setSelectedChartKey(e.target.value)}
            >
              {Object.keys(INDICATORS).map((key) => (
                <option key={key} value={key}>
                  {INDICATORS[key].label}
                </option>
              ))}
            </select>
            <span className="hint-text">
              Switch what the trend chart displays.
            </span>
          </div>

          <div className="control-group">
            <label>Compare mode</label>
            <div className="toggle-row">
              <input
                id="compare-toggle"
                type="checkbox"
                checked={compareEnabled}
                onChange={(e) => setCompareEnabled(e.target.checked)}
              />
              <label htmlFor="compare-toggle" className="toggle-label">
                Enable comparison
              </label>
            </div>
            <span className="hint-text">Plot two countries on the same chart.</span>
          </div>

          {compareEnabled && (
            <div className="control-group">
              <label htmlFor="compare-country">Compare against</label>
              <select
                id="compare-country"
                value={compareCountry}
                onChange={(e) => setCompareCountry(e.target.value)}
                disabled={countriesLoading}
              >
                {countriesError && <option disabled>Could not load countries</option>}
                {!countriesError &&
                  countries.map((country) => (
                    <option key={country.id} value={country.id}>
                      {country.name}
                    </option>
                  ))}
              </select>
              <span className="hint-text">Tip: pick a very different country.</span>
            </div>
          )}
        </section>

        <section className="dashboard">
          <div className="dashboard-section">
            <h2>Key Health Metrics</h2>

            {loading && <p className="placeholder">Loading health data…</p>}

            {error && !loading && (
              <p className="placeholder error-placeholder">{error}</p>
            )}

            {!loading && !error && (
              <div className="metrics-grid">
                {latestCards.map((c) => (
                  <div
                    key={c.key}
                    className="metric-card"
                    style={{ cursor: "pointer" }}
                    onClick={() => setSelectedChartKey(c.key)}
                    title="Click to view this metric in the chart"
                  >
                    <span className="metric-label">{c.label}</span>

                    <span className="metric-value">
                      {formatLatest(c.key, c.latestValue)}
                    </span>

                    <span className="metric-meta">
                      {c.latestYear
                        ? `Latest year: ${c.latestYear}`
                        : "Latest year: n/a"}
                    </span>

                    <span className="metric-meta">
                      {c.startYear && c.latestYear && c.change !== null
                        ? `Change since ${c.startYear}: ${formatChange(
                            c.key,
                            c.change
                          )}`
                        : "Change: n/a"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dashboard-section">
            <h2>Trends & Charts</h2>

            {loading && <p className="placeholder">Loading chart…</p>}

            {!loading && error && (
              <p className="placeholder error-placeholder">
                Could not load chart data.
              </p>
            )}

            {!loading && !error && mergedChartData.length === 0 && (
              <p className="placeholder">
                No time-series data available for this metric.
              </p>
            )}

            {!loading && !error && mergedChartData.length > 0 && (
              <>
                <div className="chart-actions">
                  <button
                    className="btn"
                    onClick={handleDownloadCsv}
                    disabled={mergedChartData.length === 0}
                  >
                    Download CSV
                  </button>
                  <span className="hint-text">
                    Exports the visible chart data{" "}
                    {compareEnabled ? "(both countries)" : ""}.
                  </span>
                </div>

                <p className="hint-text" style={{ marginTop: 0 }}>
                  Showing: <strong>{chartMeta.label}</strong>
                  {compareEnabled ? (
                    <>
                      {" "}
                      • <strong>{primaryCountryName}</strong> vs{" "}
                      <strong>{compareCountryName}</strong>
                    </>
                  ) : (
                    <>
                      {" "}
                      • <strong>{primaryCountryName}</strong>
                    </>
                  )}
                </p>

                {compareEnabled && (
                  <div className="compare-summary">
                    <div className="compare-pill">
                      <span className="compare-name">{primaryCountryName}</span>
                      <span className="compare-value">
                        {latestForMetric.a
                          ? chartMeta.chartValueFormatter(latestForMetric.a.value)
                          : "No data"}
                      </span>
                    </div>

                    <div className="compare-pill">
                      <span className="compare-name">{compareCountryName}</span>
                      <span className="compare-value">
                        {latestForMetric.b
                          ? chartMeta.chartValueFormatter(latestForMetric.b.value)
                          : "No data"}
                      </span>
                    </div>
                  </div>
                )}

                <div className="chart-wrapper">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={mergedChartData}
                      margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis
                        dataKey="year"
                        tick={{ fontSize: 10 }}
                        tickMargin={6}
                      />
                      <YAxis tick={{ fontSize: 10 }} tickMargin={6} />
                      <Tooltip
                        formatter={(value) =>
                          value === null
                            ? "No data"
                            : chartMeta.chartValueFormatter(value)
                        }
                        labelFormatter={(label) => `Year: ${label}`}
                      />
                      <Line
                        type="monotone"
                        dataKey="a"
                        stroke="#4f46e5"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                        name={primaryCountryName}
                        connectNulls
                      />
                      {compareEnabled && (
                        <Line
                          type="monotone"
                          dataKey="b"
                          stroke="#22c55e"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                          name={compareCountryName}
                          connectNulls
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span>Built for portfolio • Health Data Tracker</span>
      </footer>
    </div>
  );
}

export default App;
