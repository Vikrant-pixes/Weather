const geocodingEndpoint = "https://geocoding-api.open-meteo.com/v1/search";
const openStreetMapGeocodingEndpoint = "https://nominatim.openstreetmap.org/search";
const photonGeocodingEndpoint = "https://photon.komoot.io/api/";
const forecastEndpoint = "https://api.open-meteo.com/v1/forecast";
const savedPlacesKey = "nightfall.savedPlaces";
const weatherDescriptions = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Heavy rain showers", 82: "Violent rain showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Heavy thunderstorm with hail"
};
const elements = {
  placeForm: document.querySelector("#place-search"),
  coordinateForm: document.querySelector("#coordinates-search"),
  placeTab: document.querySelector("#place-tab"),
  coordinateTab: document.querySelector("#coordinates-tab"),
  placeInput: document.querySelector("#place-query"),
  placeSource: document.querySelector("#place-source"),
  searchStatus: document.querySelector("#search-status"),
  searchResults: document.querySelector("#search-results"),
  welcome: document.querySelector("#welcome-card"),
  weatherContent: document.querySelector("#weather-content"),
  weatherSection: document.querySelector("#weather-section"),
  appStatus: document.querySelector("#app-status"),
  savedSection: document.querySelector("#saved-section"),
  savedList: document.querySelector("#saved-list"),
  savedCount: document.querySelector("#saved-count"),
  forecastList: document.querySelector("#forecast-list"),
  saveButton: document.querySelector("#save-place"),
  saveLabel: document.querySelector("#save-label"),
  refreshButton: document.querySelector("#refresh-weather")
};

let activePlace = null;
let savedPlaces = readSavedPlaces();
let weatherRequestId = 0;
let searchRequestId = 0;
const geocodingCache = new Map();
let nominatimQueue = Promise.resolve();
let lastNominatimRequest = 0;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let starsPaused = prefersReducedMotion;
let starFrame = 0;
let stars = [];
let meteors = [];
let weatherParticles = [];
let showerRemaining = 0;
let solarClock = null;
let lastFrameTime = 0;
let nextMeteorAt = 0;

function readSavedPlaces() {
  try {
    const stored = JSON.parse(localStorage.getItem(savedPlacesKey) || "[]");
    if (!Array.isArray(stored)) throw new Error("Saved places data is not a list.");
    return stored.filter(place =>
      place &&
      typeof place.name === "string" &&
      Number.isFinite(place.latitude) &&
      Number.isFinite(place.longitude)
    );
  } catch (error) {
    elements?.appStatus && (elements.appStatus.textContent = "Saved places could not be read from this browser.");
    return [];
  }
}

function persistSavedPlaces() {
  try {
    localStorage.setItem(savedPlacesKey, JSON.stringify(savedPlaces));
    return true;
  } catch (error) {
    showAppStatus("Your browser couldn't save this place. Check its storage settings and try again.");
    return false;
  }
}

function showAppStatus(message, state = "error") {
  elements.appStatus.textContent = message;
  elements.appStatus.dataset.state = state;
}

function clearAppStatus() {
  elements.appStatus.textContent = "";
  delete elements.appStatus.dataset.state;
}

function placePath(place) {
  const labels = [place.admin4, place.admin3, place.admin2, place.admin1, place.country]
    .filter((label, index, all) =>
      label &&
      normalizePlaceName(label) !== normalizePlaceName(place.name) &&
      all.indexOf(label) === index
    );
  return labels.join(", ") || `${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`;
}

function locationIdentity(place) {
  return `${Number(place.latitude).toFixed(4)},${Number(place.longitude).toFixed(4)}`;
}

function isSaved(place) {
  return savedPlaces.some(saved => locationIdentity(saved) === locationIdentity(place));
}

function setSearchMode(mode) {
  const placeMode = mode === "place";
  elements.placeForm.hidden = !placeMode;
  elements.coordinateForm.hidden = placeMode;
  elements.placeTab.classList.toggle("active", placeMode);
  elements.coordinateTab.classList.toggle("active", !placeMode);
  elements.placeTab.setAttribute("aria-selected", String(placeMode));
  elements.coordinateTab.setAttribute("aria-selected", String(!placeMode));
  elements.searchStatus.textContent = "";
  elements.searchResults.replaceChildren();
}

function makePlaceLabel(place) {
  return [place.admin4, place.admin3, place.admin2, place.admin1, place.country]
    .filter((label, index, all) =>
      label &&
      normalizePlaceName(label) !== normalizePlaceName(place.name) &&
      all.indexOf(label) === index
    )
    .join(", ") || "Location";
}

function featureLabel(code) {
  const placeTypeLabels = {
    city: "City",
    town: "Town",
    village: "Village",
    hamlet: "Village",
    county: "County",
    state_district: "District",
    suburb: "Neighbourhood",
    neighbourhood: "Neighbourhood",
    municipality: "Municipality",
    state: "State or region",
    country: "Country",
    administrative: "Administrative area"
  };
  if (code?.sourceType) {
    const type = code.sourceType.toLocaleLowerCase();
    return placeTypeLabels[type] || type.charAt(0).toLocaleUpperCase() + type.slice(1);
  }
  if (code?.feature_code) code = code.feature_code;
  if (code === "PPLC") return "Capital";
  if (/^PPLA\d?$/.test(code || "")) return "Administrative centre";
  if (/^PPL/.test(code || "")) return "Town or settlement";
  if (code === "AIRP") return "Airport";
  return code ? `Map feature ${code}` : "";
}

function mapOpenStreetMapPlaces(results) {
  return results.map(result => {
    const address = result.address || {};
    const name = result.name ||
      address.village ||
      address.town ||
      address.city ||
      address.county ||
      result.display_name?.split(",")[0] ||
      "";
    return {
      id: result.place_id,
      name,
      latitude: Number(result.lat),
      longitude: Number(result.lon),
      country: address.country || "",
      country_code: address.country_code?.toLocaleUpperCase() || "",
      admin1: address.state || address.province || address.region || "",
      admin2: address.state_district || address.city || address.town || address.municipality || "",
      admin3: address.county || address.district || "",
      admin4: address.neighbourhood || address.quarter || address.suburb || "",
      feature_code: result.category === "place" ? "PPL" : "",
      sourceType: result.addresstype || result.type || "",
      population: 0,
      source: "openstreetmap"
    };
  });
}

function mapPhotonPlaces(results) {
  return results.flatMap(result => {
    const properties = result.properties || {};
    const coordinates = result.geometry?.coordinates;
    if (
      properties.osm_key !== "place" ||
      !["city", "town", "village", "hamlet", "locality"].includes(properties.osm_value) ||
      !Array.isArray(coordinates) ||
      !Number.isFinite(Number(coordinates[0])) ||
      !Number.isFinite(Number(coordinates[1])) ||
      typeof properties.name !== "string"
    ) return [];

    return [{
      id: `${properties.osm_type || "osm"}-${properties.osm_id || properties.name}`,
      name: properties.name,
      latitude: Number(coordinates[1]),
      longitude: Number(coordinates[0]),
      country: properties.country || "",
      country_code: properties.countrycode?.toLocaleUpperCase() || "",
      admin1: properties.state || "",
      admin2: properties.county || properties.district || "",
      admin3: properties.city || "",
      admin4: properties.locality || "",
      feature_code: "PPL",
      sourceType: properties.osm_value,
      population: 0,
      source: "photon",
      suggested: true
    }];
  });
}

function cacheGeocodingResults(key, places) {
  if (geocodingCache.size >= 50) geocodingCache.delete(geocodingCache.keys().next().value);
  geocodingCache.set(key, places);
}

function searchOpenStreetMap(url) {
  const request = nominatimQueue.then(async () => {
    const wait = Math.max(0, 1100 - (performance.now() - lastNominatimRequest));
    if (wait) await new Promise(resolve => window.setTimeout(resolve, wait));
    lastNominatimRequest = performance.now();
    return fetch(url, { headers: { Accept: "application/json" } });
  });
  nominatimQueue = request.then(() => undefined, () => undefined);
  return request;
}

function normalizePlaceName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function rankPlaces(places, query) {
  const [nameQuery, ...qualifiers] = query.split(",").map(value => normalizePlaceName(value));
  const ranked = places
    .filter(place =>
      place &&
      typeof place.name === "string" &&
      Number.isFinite(place.latitude) &&
      Number.isFinite(place.longitude)
    )
    .map((place, index) => {
      const name = normalizePlaceName(place.name);
      let score = name === nameQuery ? 0 : name.startsWith(nameQuery) ? 1 : 2;
      if (qualifiers.length && qualifiers[0]) {
        const areaNames = [place.admin1, place.country, place.country_code]
          .map(normalizePlaceName);
        if (areaNames.includes(qualifiers[0])) score -= 2;
      }
      return { place, index, score };
    });

  const placeNames = ranked.filter(result => /^PPL/.test(result.place.feature_code || ""));
  const candidates = placeNames.length ? placeNames : ranked;
  candidates.sort((left, right) =>
    left.score - right.score ||
    (right.place.population || 0) - (left.place.population || 0) ||
    left.index - right.index
  );
  return candidates.slice(0, 10).map(result => result.place);
}

function isGeographicPlace(place) {
  const featureCode = place.feature_code || "";
  const sourceType = (place.sourceType || "").toLocaleLowerCase();
  return /^PPL/.test(featureCode) ||
    /^ADM\d+$/.test(featureCode) ||
    ["PCLI", "PCLD"].includes(featureCode) ||
    ["city", "town", "village", "hamlet", "locality", "county", "district", "state_district", "state", "region", "province", "country", "municipality", "administrative"]
      .includes(sourceType);
}

async function findPhotonSuggestions(query) {
  const cacheKey = `photon:${query.trim().toLocaleLowerCase()}`;
  let places = geocodingCache.get(cacheKey);
  if (!places) {
    const url = new URL(photonGeocodingEndpoint);
    url.search = new URLSearchParams({ q: query, limit: "20", lang: "en" });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Spelling suggestions failed (HTTP ${response.status}).`);
    const data = await response.json();
    places = mapPhotonPlaces(Array.isArray(data.features) ? data.features : []);
    cacheGeocodingResults(cacheKey, places);
  }
  return places;
}

async function findPlaces(query) {
  const requestId = ++searchRequestId;
  elements.searchStatus.textContent = "Finding places…";
  elements.searchResults.replaceChildren();
  clearAppStatus();

  try {
    const source = elements.placeSource.value;
    const cacheKey = `${source}:${query.trim().toLocaleLowerCase()}`;
    let places = geocodingCache.get(cacheKey);
    if (!places) {
      const url = new URL(source === "openstreetmap" ? openStreetMapGeocodingEndpoint : geocodingEndpoint);
      if (source === "openstreetmap") {
        url.search = new URLSearchParams({
          q: query,
          format: "jsonv2",
          addressdetails: "1",
          limit: "10",
          "accept-language": "en"
        });
      } else {
        url.search = new URLSearchParams({
          name: query,
          count: "100",
          language: "en",
          format: "json"
        });
      }
      const response = source === "openstreetmap"
        ? await searchOpenStreetMap(url)
        : await fetch(url);
      if (!response.ok) throw new Error(`Place search failed (HTTP ${response.status}).`);
      const data = await response.json();
      places = source === "openstreetmap"
        ? mapOpenStreetMapPlaces(Array.isArray(data) ? data : [])
        : Array.isArray(data.results) ? data.results : [];
      cacheGeocodingResults(cacheKey, places);
    }
    if (requestId !== searchRequestId) return;
    places = rankPlaces(places, query);
    const requestedName = normalizePlaceName(query.split(",")[0]);
    const hasNameMatch = places.some(place => {
      const name = normalizePlaceName(place.name);
      const shortPrefixMatch = name.startsWith(requestedName) && name.length - requestedName.length <= 2;
      return isGeographicPlace(place) && (name === requestedName || shortPrefixMatch);
    });
    const usingSuggestions = !hasNameMatch;
    if (usingSuggestions) {
      places = rankPlaces(await findPhotonSuggestions(query), query);
    }
    if (!places.length) {
      elements.searchStatus.textContent = "No matching places found. Try a nearby town or a different spelling.";
      return;
    }

    elements.searchStatus.textContent = usingSuggestions
      ? "Possible spelling matches from Photon. Choose a place to continue; no location is selected automatically."
      : "Choose the matching place. Add a state or country (for example, Springfield, Illinois) to narrow the results.";
    for (const place of places) {
      const button = document.createElement("button");
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      const detail = document.createElement("small");
      const arrow = document.createElement("span");
      button.type = "button";
      button.className = "place-result";
      copy.className = "place-result-copy";
      name.textContent = place.name;
      const region = makePlaceLabel(place);
      const resultName = normalizePlaceName(place.name);
      const type = featureLabel(place);
      const mappedName = place.suggested && requestedName !== resultName
        ? `Suggested for “${query.split(",")[0].trim()}”`
        : "";
      detail.textContent = [region, type, mappedName].filter(Boolean).join(" · ");
      arrow.className = "result-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      copy.append(name, detail);
      button.append(copy, arrow);
      button.addEventListener("click", () => loadWeather(place));
      elements.searchResults.append(button);
    }
  } catch (error) {
    if (requestId !== searchRequestId) return;
    elements.searchStatus.textContent = error instanceof Error ? error.message : "Could not search for places.";
  }
}

function weatherIcon(code, isDay = true) {
  if (code === 0) return isDay ? "☼" : "☾";
  if (code === 1) return isDay ? "◑" : "☾";
  if (code === 2) return "◐";
  if (code === 3) return "☁";
  if (code === 45 || code === 48) return "≋";
  if (code >= 51 && code <= 67) return "☂";
  if (code >= 71 && code <= 86) return "✳";
  if (code >= 95) return "ϟ";
  return "✦";
}

function compassDirection(degrees) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(degrees / 45) % directions.length];
}

function formatDay(date, index) {
  if (index === 0) return "Today";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

function renderForecast(data) {
  const daily = data.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) {
    throw new Error("The weather service returned no daily forecast.");
  }
  const fragment = document.createDocumentFragment();
  daily.time.forEach((date, index) => {
    const day = document.createElement("article");
    const label = document.createElement("span");
    const icon = document.createElement("span");
    const rain = document.createElement("span");
    const temperatures = document.createElement("div");
    const high = document.createElement("strong");
    const low = document.createElement("span");
    const rainChance = daily.precipitation_probability_max?.[index];
    day.className = `forecast-day${index === 0 ? " today" : ""}`;
    label.className = "forecast-day-name";
    label.textContent = formatDay(date, index);
    icon.className = "forecast-day-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = weatherIcon(daily.weather_code?.[index]);
    rain.className = "forecast-rain";
    rain.textContent = rainChance == null ? "" : `${rainChance}% rain`;
    temperatures.className = "forecast-temps";
    high.textContent = daily.temperature_2m_max?.[index] == null ? "—" : `${Math.round(daily.temperature_2m_max[index])}°`;
    low.textContent = daily.temperature_2m_min?.[index] == null ? "—" : `${Math.round(daily.temperature_2m_min[index])}°`;
    temperatures.append(high, low);
    day.append(label, icon, rain, temperatures);
    fragment.append(day);
  });
  elements.forecastList.replaceChildren(fragment);
}

function updateSaveButton() {
  const saved = activePlace && isSaved(activePlace);
  elements.saveButton.setAttribute("aria-pressed", String(Boolean(saved)));
  elements.saveButton.querySelector("[aria-hidden='true']").textContent = saved ? "★" : "☆";
  elements.saveLabel.textContent = saved ? "Saved" : "Save place";
}

async function loadWeather(place) {
  const requestId = ++weatherRequestId;
  elements.searchStatus.textContent = "";
  elements.searchResults.replaceChildren();
  activePlace = {
    ...place,
    latitude: Number(place.latitude),
    longitude: Number(place.longitude)
  };
  showAppStatus("Fetching live conditions…", "loading");
  elements.weatherSection.setAttribute("aria-busy", "true");
  elements.weatherContent.hidden = false;
  elements.welcome.hidden = true;
  document.querySelector("#location-name").textContent = activePlace.name || "Pinned location";
  document.querySelector("#location-path").textContent = placePath(activePlace);
  elements.refreshButton.disabled = true;
  elements.refreshButton.setAttribute("aria-busy", "true");

  try {
    const url = new URL(forecastEndpoint);
    url.search = new URLSearchParams({
      latitude: String(activePlace.latitude),
      longitude: String(activePlace.longitude),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,uv_index",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      timezone: "auto",
      forecast_days: "7"
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather request failed (HTTP ${response.status}).`);
    const data = await response.json();
    if (requestId !== weatherRequestId) return;
    const current = data.current;
    if (!current || !data.current_units) throw new Error("The weather service returned no current conditions.");
    renderForecast(data);
    setSolarClock(current, data.daily);
    drawSky(performance.now(), 0);

    document.querySelector("#location-name").textContent = activePlace.name || "Pinned location";
    document.querySelector("#location-path").textContent = placePath(activePlace);
    document.querySelector("#current-icon").textContent = weatherIcon(current.weather_code, current.is_day === 1);
    document.querySelector("#current-temperature").textContent = `${Math.round(current.temperature_2m)}°`;
    document.querySelector("#current-condition").textContent = weatherDescriptions[current.weather_code] || "Current conditions";
    document.querySelector("#feels-like").textContent = `${Math.round(current.apparent_temperature)}°`;
    document.querySelector("#feels-note").textContent = "Feels like";
    document.querySelector("#humidity").textContent = `${current.relative_humidity_2m}${data.current_units.relative_humidity_2m}`;
    document.querySelector("#wind").textContent = `${Math.round(current.wind_speed_10m)} ${data.current_units.wind_speed_10m}`;
    document.querySelector("#wind-direction").textContent = `${compassDirection(current.wind_direction_10m)} wind`;
    document.querySelector("#uv-index").textContent = current.uv_index == null ? "—" : `${Math.round(current.uv_index)}`;
    document.querySelector("#uv-note").textContent = current.uv_index == null ? "Not available" : current.uv_index < 3 ? "Low" : current.uv_index < 6 ? "Moderate" : current.uv_index < 8 ? "High" : "Very high";

    const high = data.daily?.temperature_2m_max?.[0];
    const low = data.daily?.temperature_2m_min?.[0];
    document.querySelector("#today-range").textContent =
      high == null || low == null ? "Updated live for your location" : `Today  ·  H:${Math.round(high)}°  L:${Math.round(low)}°`;
    const time = String(current.time || "").replace("T", " ");
    document.querySelector("#last-updated").textContent = time
      ? `Local time ${time} · Auto-refreshes every 10 minutes`
      : "Weather refreshes automatically every 10 minutes";
    updateSaveButton();
    clearAppStatus();
  } catch (error) {
    if (requestId !== weatherRequestId) return;
    showAppStatus(error instanceof Error ? error.message : "Could not load the weather forecast.");
  } finally {
    if (requestId === weatherRequestId) {
      elements.weatherSection.setAttribute("aria-busy", "false");
      elements.refreshButton.disabled = false;
      elements.refreshButton.removeAttribute("aria-busy");
    }
  }
}

function renderSavedPlaces() {
  elements.savedSection.hidden = savedPlaces.length === 0;
  elements.savedCount.textContent = `${savedPlaces.length} ${savedPlaces.length === 1 ? "place" : "places"}`;
  const fragment = document.createDocumentFragment();
  savedPlaces.forEach(place => {
    const card = document.createElement("article");
    const openButton = document.createElement("button");
    const name = document.createElement("strong");
    const path = document.createElement("small");
    const removeButton = document.createElement("button");
    card.className = "saved-place";
    openButton.className = "saved-place-main";
    openButton.type = "button";
    name.textContent = place.name;
    path.textContent = makePlaceLabel(place);
    openButton.append(name, path);
    openButton.addEventListener("click", () => loadWeather(place));
    removeButton.className = "remove-saved";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `Remove ${place.name} from saved places`);
    removeButton.addEventListener("click", () => {
      const previousPlaces = savedPlaces;
      savedPlaces = savedPlaces.filter(saved => locationIdentity(saved) !== locationIdentity(place));
      if (!persistSavedPlaces()) {
        savedPlaces = previousPlaces;
        return;
      }
      renderSavedPlaces();
      updateSaveButton();
      showAppStatus(`${place.name} removed from your saved places.`);
    });
    card.append(openButton, removeButton);
    fragment.append(card);
  });
  elements.savedList.replaceChildren(fragment);
}

function toggleSavedPlace() {
  if (!activePlace) return;
  if (isSaved(activePlace)) {
    const previousPlaces = savedPlaces;
    savedPlaces = savedPlaces.filter(place => locationIdentity(place) !== locationIdentity(activePlace));
    if (!persistSavedPlaces()) {
      savedPlaces = previousPlaces;
      return;
    }
    showAppStatus(`${activePlace.name} removed from your saved places.`);
  } else {
    savedPlaces.unshift(activePlace);
    if (!persistSavedPlaces()) {
      savedPlaces.shift();
      return;
    }
    showAppStatus(`${activePlace.name} saved with its available location details.`);
  }
  renderSavedPlaces();
  updateSaveButton();
}

function makeCoordinatePlace(latitude, longitude) {
  return {
    name: "Pinned location",
    latitude,
    longitude,
    admin1: "",
    admin2: "",
    country: ""
  };
}

elements.placeForm.addEventListener("submit", event => {
  event.preventDefault();
  const query = elements.placeInput.value.trim();
  if (query) findPlaces(query);
});

elements.coordinateForm.addEventListener("submit", event => {
  event.preventDefault();
  const formData = new FormData(elements.coordinateForm);
  const latitude = Number(formData.get("latitude"));
  const longitude = Number(formData.get("longitude"));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    showAppStatus("Latitude must be between −90 and 90.");
    return;
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    showAppStatus("Longitude must be between −180 and 180.");
    return;
  }
  elements.searchStatus.textContent = "";
  elements.searchResults.replaceChildren();
  loadWeather(makeCoordinatePlace(latitude, longitude));
});

elements.placeTab.addEventListener("click", () => setSearchMode("place"));
elements.coordinateTab.addEventListener("click", () => setSearchMode("coordinates"));
elements.saveButton.addEventListener("click", toggleSavedPlace);
elements.refreshButton.addEventListener("click", () => {
  if (activePlace) loadWeather(activePlace);
});
document.querySelectorAll("[data-place]").forEach(button => {
  button.addEventListener("click", () => {
    const place = button.getAttribute("data-place");
    elements.placeInput.value = place;
    findPlaces(place);
    document.querySelector("#search-heading").scrollIntoView({ behavior: "smooth", block: "center" });
  });
});
document.querySelector("#theme-toggle").addEventListener("click", event => {
  starsPaused = !starsPaused;
  const button = event.currentTarget;
  button.setAttribute("aria-label", starsPaused ? "Resume star animation" : "Pause star animation");
  button.title = starsPaused ? "Resume star animation" : "Pause star animation";
  button.querySelector("span").textContent = starsPaused ? "✦" : "☾";
  if (!starsPaused) animateStars();
});
window.setInterval(() => {
  if (activePlace && document.visibilityState === "visible") loadWeather(activePlace);
}, 10 * 60 * 1000);

function resizeStarfield() {
  const canvas = document.querySelector("#starfield");
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const count = Math.max(55, Math.floor((window.innerWidth * window.innerHeight) / 6800));
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    radius: Math.random() * 1.15 + .3,
    opacity: Math.random() * .65 + .2,
    phase: Math.random() * Math.PI * 2,
    speed: Math.random() * .012 + .003
  }));
  meteors = [];
  drawSky(performance.now(), 0);
  if (!starsPaused) animateStars();
}

function parseLocalMinutes(value) {
  const match = String(value || "").match(/T(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function setSolarClock(current, daily) {
  const currentMinute = parseLocalMinutes(current.time);
  const sunrise = parseLocalMinutes(daily?.sunrise?.[0]);
  const sunset = parseLocalMinutes(daily?.sunset?.[0]);
  solarClock = {
    minute: currentMinute ?? new Date().getHours() * 60 + new Date().getMinutes(),
    sunrise: sunrise ?? 6 * 60,
    sunset: sunset ?? 18 * 60,
    solarEventsAvailable: sunrise !== null && sunset !== null,
    receivedAt: performance.now(),
    isDay: current.is_day === 1,
    weatherCode: current.weather_code,
    cloudCover: current.cloud_cover,
    visibility: current.visibility
  };
  weatherParticles = [];
  meteors = [];
  showerRemaining = 0;
  nextMeteorAt = performance.now() + 1200;
}

function signedMinuteDifference(minute, reference) {
  return ((minute - reference + 2160) % 1440) - 720;
}

function getSkyState(time) {
  const clock = solarClock || {
    minute: new Date().getHours() * 60 + new Date().getMinutes(),
    sunrise: 6 * 60,
    sunset: 18 * 60,
    solarEventsAvailable: true,
    receivedAt: time,
    isDay: true,
    weatherCode: null,
    cloudCover: null,
    visibility: null
  };
  const minute = (clock.minute + (time - clock.receivedAt) / 60000) % 1440;
  const sunriseDistance = signedMinuteDifference(minute, clock.sunrise);
  const sunsetDistance = signedMinuteDifference(minute, clock.sunset);
  const sunriseGlow = clock.solarEventsAvailable ? Math.max(0, 1 - Math.abs(sunriseDistance - 8) / 75) : 0;
  const sunsetGlow = clock.solarEventsAvailable ? Math.max(0, 1 - Math.abs(sunsetDistance + 12) / 105) : 0;
  const twilight = Math.max(sunriseGlow, sunsetGlow);
  const day = clock.solarEventsAvailable
    ? sunriseDistance > 48 && sunsetDistance < -95
    : clock.isDay;
  const phase = sunsetGlow > .08 ? "sunset" : sunriseGlow > .08 ? "dawn" : day ? "day" : "night";
  const codeCloud = clock.weatherCode === 0 ? 0
    : clock.weatherCode === 1 ? .12
      : clock.weatherCode === 2 ? .4
        : clock.weatherCode >= 3 && clock.weatherCode <= 48 ? .84
          : clock.weatherCode >= 51 && clock.weatherCode <= 99 ? .78
            : .16;
  const cloudCover = Number.isFinite(clock.cloudCover)
    ? Math.max(codeCloud, clock.cloudCover / 100)
    : codeCloud;
  const fog = clock.weatherCode === 45 || clock.weatherCode === 48 ||
    (Number.isFinite(clock.visibility) && clock.visibility < 1000);
  document.body.dataset.skyPhase = phase;
  document.body.dataset.skyWeather = fog ? "fog" : clock.weatherCode >= 95 ? "storm"
    : clock.weatherCode >= 51 && clock.weatherCode <= 86 ? "precipitation"
      : cloudCover > .7 ? "cloudy" : "clear";
  return {
    phase,
    twilight,
    day,
    minute,
    weatherCode: clock.weatherCode,
    cloudCover,
    visibility: clock.visibility,
    fog,
    clear: Number.isFinite(clock.weatherCode) && clock.weatherCode <= 1 && cloudCover < .22
  };
}

function interpolateColor(start, end, amount) {
  return start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount));
}

function colorString(color, alpha = 1) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function drawCloudField(context, width, height, time, cloudCover, phase) {
  if (cloudCover < .06) return;
  const dusk = phase === "sunset" || phase === "dawn";
  const cloudColor = dusk ? [155, 119, 130] : [101, 116, 137];
  const layers = 3 + Math.round(cloudCover * 3);
  context.save();
  context.filter = "blur(25px)";
  for (let index = 0; index < layers; index += 1) {
    const layer = index / Math.max(1, layers - 1);
    const cloudWidth = width * (.34 + (index % 3) * .17);
    const cloudHeight = height * (.08 + (index % 2) * .035);
    const speed = 2 + (index % 3) * 2;
    const x = ((index * width * .47 + time / 1000 * speed) % (width + cloudWidth * 2)) - cloudWidth;
    const y = height * (.18 + layer * .53 + Math.sin(time / 18000 + index) * .025);
    const color = context.createLinearGradient(0, y - cloudHeight, 0, y + cloudHeight);
    color.addColorStop(0, colorString(cloudColor, .02));
    color.addColorStop(.45, colorString(cloudColor, .24));
    color.addColorStop(1, colorString(cloudColor, .01));
    context.globalAlpha = Math.min(.95, cloudCover * (.46 + (index % 3) * .15));
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x - cloudWidth * .58, y + cloudHeight * .12);
    context.bezierCurveTo(x - cloudWidth * .42, y - cloudHeight * .72, x - cloudWidth * .23, y + cloudHeight * .4, x - cloudWidth * .08, y - cloudHeight * .26);
    context.bezierCurveTo(x + cloudWidth * .13, y - cloudHeight * .72, x + cloudWidth * .28, y + cloudHeight * .25, x + cloudWidth * .52, y - cloudHeight * .06);
    context.lineTo(x + cloudWidth * .62, y + cloudHeight * .36);
    context.bezierCurveTo(x + cloudWidth * .22, y + cloudHeight * .5, x - cloudWidth * .24, y + cloudHeight * .54, x - cloudWidth * .58, y + cloudHeight * .12);
    context.fill();
  }
  context.restore();
}

function drawAtmosphericHaze(context, width, height, phase, twilight, cloudCover, fog, time) {
  const dusk = phase === "sunset" || phase === "dawn";
  const horizonY = height * .76;
  const haze = context.createRadialGradient(width * .7, horizonY, 0, width * .7, horizonY, width * .68);
  haze.addColorStop(0, dusk
    ? `rgba(241, 161, 130, ${.08 + twilight * .11})`
    : phase === "day" ? "rgba(224, 222, 208, .12)" : "rgba(106, 123, 159, .05)");
  haze.addColorStop(1, "rgba(80, 90, 114, 0)");
  context.fillStyle = haze;
  context.fillRect(0, height * .32, width, height * .68);

  if (!fog) return;
  const fogColor = [105, 121, 142];
  context.save();
  context.filter = "blur(35px)";
  for (let index = 0; index < 3; index += 1) {
    const drift = (time / 1000 * (4 + index * 3)) % (width * 1.8);
    const y = height * (.61 + index * .11);
    const veil = context.createLinearGradient(0, y - 45, 0, y + 60);
    veil.addColorStop(0, colorString(fogColor, 0));
    veil.addColorStop(.5, colorString(fogColor, .18 + cloudCover * .04));
    veil.addColorStop(1, colorString(fogColor, 0));
    context.fillStyle = veil;
    context.beginPath();
    context.moveTo(drift - width, y);
    context.bezierCurveTo(drift - width * .45, y - 55, drift - width * .15, y + 55, drift + width * .28, y - 16);
    context.bezierCurveTo(drift + width * .63, y - 53, drift + width, y + 49, drift + width * 1.4, y - 5);
    context.lineTo(drift + width * 1.5, y + 55);
    context.lineTo(drift - width, y + 55);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawPrecipitation(context, width, height, delta, weatherCode) {
  const rain = (weatherCode >= 51 && weatherCode <= 67) || (weatherCode >= 80 && weatherCode <= 82) || weatherCode >= 95;
  const snow = weatherCode >= 71 && weatherCode <= 77 || weatherCode >= 85 && weatherCode <= 86;
  if (!rain && !snow) {
    weatherParticles = [];
    return;
  }
  const target = Math.min(85, Math.max(28, Math.round(width / 9)));
  while (weatherParticles.length < target) {
    weatherParticles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      speed: snow ? 22 + Math.random() * 34 : 460 + Math.random() * 320,
      drift: snow ? Math.random() * 30 - 15 : 90 + Math.random() * 85,
      size: snow ? 1 + Math.random() * 1.2 : 8 + Math.random() * 12
    });
  }
  context.save();
  context.strokeStyle = snow ? "rgba(239, 244, 255, .46)" : "rgba(213, 225, 242, .24)";
  context.fillStyle = "rgba(239, 244, 255, .52)";
  context.lineWidth = snow ? 1 : .8;
  for (const particle of weatherParticles) {
    particle.x += particle.drift * delta;
    particle.y += particle.speed * delta;
    if (particle.y > height + particle.size) {
      particle.y = -particle.size;
      particle.x = Math.random() * width;
    }
    if (particle.x > width + particle.size) particle.x = -particle.size;
    if (particle.x < -particle.size) particle.x = width + particle.size;
    context.beginPath();
    if (snow) {
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(particle.x, particle.y);
      context.lineTo(particle.x - particle.size * .18, particle.y - particle.size);
      context.stroke();
    }
  }
  context.restore();
}

function spawnMeteor(width, height, time, twilight) {
  const x = Math.random() * width * .88 + width * .05;
  const y = Math.random() * height * .4 + height * .04;
  const angle = Math.PI * (.16 + Math.random() * .12);
  const speed = 260 + Math.random() * 230;
  meteors.push({
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 0,
    duration: .85 + Math.random() * .6,
    trail: 70 + Math.random() * 100,
    brightness: .5 + Math.random() * .5,
    twilight
  });
}

function drawMeteor(context, meteor, delta) {
  meteor.life += delta;
  meteor.x += meteor.vx * delta;
  meteor.y += meteor.vy * delta;
  const fade = Math.max(0, 1 - meteor.life / meteor.duration);
  const tailLength = meteor.trail * (.25 + fade * .75);
  const directionLength = Math.hypot(meteor.vx, meteor.vy);
  const tailX = meteor.x - meteor.vx / directionLength * tailLength;
  const tailY = meteor.y - meteor.vy / directionLength * tailLength;
  const trail = context.createLinearGradient(tailX, tailY, meteor.x, meteor.y);
  trail.addColorStop(0, "rgba(205, 217, 240, 0)");
  trail.addColorStop(.72, `rgba(211, 220, 239, ${fade * .23 * meteor.brightness})`);
  trail.addColorStop(1, `rgba(255, 250, 238, ${fade * .76 * meteor.brightness})`);
  context.save();
  context.strokeStyle = trail;
  context.lineWidth = .9 + meteor.brightness * .45;
  context.shadowColor = "#dae4f6";
  context.shadowBlur = 4;
  context.beginPath();
  context.moveTo(tailX, tailY);
  context.lineTo(meteor.x, meteor.y);
  context.stroke();
  context.fillStyle = `rgba(255, 252, 244, ${fade * meteor.brightness})`;
  context.beginPath();
  context.arc(meteor.x, meteor.y, 1.05, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSky(time, delta) {
  const canvas = document.querySelector("#starfield");
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scene = getSkyState(time);
  const { phase, twilight, day, weatherCode, cloudCover, fog, clear } = scene;
  const nightTop = [7, 10, 19];
  const dayTop = [20, 32, 52];
  const sunsetTop = [30, 43, 69];
  const nightMiddle = [17, 22, 33];
  const dayMiddle = [36, 48, 65];
  const sunsetMiddle = [131, 87, 94];
  const nightHorizon = [36, 44, 56];
  const dayHorizon = [66, 75, 88];
  const sunsetHorizon = [226, 151, 123];
  const daylight = day ? 1 : 0;
  const overcast = Math.min(.68, cloudCover * .48 + (fog ? .16 : 0));
  const mutedSky = [27, 35, 48];
  const upperBase = interpolateColor(nightTop, dayTop, daylight);
  const midBase = interpolateColor(nightMiddle, dayMiddle, daylight);
  const horizonBase = interpolateColor(nightHorizon, dayHorizon, daylight);
  const upperTwilight = interpolateColor(upperBase, sunsetTop, twilight * .92);
  const midTwilight = interpolateColor(midBase, sunsetMiddle, twilight * .94);
  const horizonTwilight = interpolateColor(horizonBase, sunsetHorizon, twilight);
  const upperColor = interpolateColor(upperTwilight, mutedSky, overcast);
  const midColor = interpolateColor(midTwilight, mutedSky, overcast * .78);
  const horizonColor = interpolateColor(horizonTwilight, mutedSky, overcast * .9);
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, colorString(upperColor));
  gradient.addColorStop(.49, colorString(midColor));
  gradient.addColorStop(.82, colorString(horizonColor));
  gradient.addColorStop(1, colorString(interpolateColor(horizonColor, upperColor, .18)));
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  drawAtmosphericHaze(context, width, height, phase, twilight, cloudCover, fog, time);
  drawCloudField(context, width, height, time, cloudCover, phase);

  const starVisibility = (day ? .025 : 1 - twilight * .65) * (1 - cloudCover * .96) * (fog ? .24 : 1);
  for (const star of stars) {
    const shimmer = starsPaused ? 1 : .55 + .45 * Math.sin(time * star.speed + star.phase);
    context.globalAlpha = star.opacity * shimmer * starVisibility;
    context.fillStyle = "#f0e9ff";
    context.beginPath();
    context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  const meteorSkyIsClear = clear && cloudCover < .25 && !fog;
  if (!day && meteorSkyIsClear && !starsPaused && time >= nextMeteorAt) {
    if (showerRemaining > 0) {
      spawnMeteor(width, height, time, twilight);
      showerRemaining -= 1;
      nextMeteorAt = time + (380 + Math.random() * 650);
      if (showerRemaining === 0) {
        nextMeteorAt = time + (twilight > .12 ? 4500 : 13500) + Math.random() * 11000;
      }
    } else if (clear && twilight < .12) {
      showerRemaining = 3 + Math.floor(Math.random() * 3);
      nextMeteorAt = time + 250;
    } else {
      spawnMeteor(width, height, time, twilight);
      nextMeteorAt = time + 4500 + Math.random() * 5500;
    }
  } else if (!meteorSkyIsClear || day || starsPaused) {
    meteors = [];
    showerRemaining = 0;
  }
  meteors = meteors.filter(meteor => meteor.life < meteor.duration && meteor.x < width + meteor.trail);
  for (const meteor of meteors) drawMeteor(context, meteor, delta);
  drawPrecipitation(context, width, height, delta, weatherCode);
}

function animateStars(time = 0) {
  if (prefersReducedMotion && starsPaused) return;
  const delta = lastFrameTime ? Math.min((time - lastFrameTime) / 1000, .05) : 0;
  lastFrameTime = time;
  drawSky(time, delta);
  starFrame = window.requestAnimationFrame(animateStars);
}

renderSavedPlaces();
const starToggle = document.querySelector("#theme-toggle");
starToggle.setAttribute("aria-label", starsPaused ? "Resume star animation" : "Pause star animation");
starToggle.title = starsPaused ? "Resume star animation" : "Pause star animation";
starToggle.querySelector("span").textContent = starsPaused ? "✦" : "☾";
resizeStarfield();
window.addEventListener("resize", resizeStarfield, { passive: true });
