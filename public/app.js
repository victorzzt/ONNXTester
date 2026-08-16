const $ = (selector) => document.querySelector(selector);

// Storage keys and explicit debug flags stay centralized so browser-only test
// behavior cannot be enabled accidentally by normal application state.
const THEME_STORAGE_KEY = "onnxtts.theme";
const RECENT_STORAGE_KEY = "onnxtts.recentVoices";
const QUEUE_DEBUG_MODE = new URLSearchParams(window.location.search).get("queueDebug");
const QUEUE_FULL_MESSAGE = "Too Many Request, please wait for a while.";
const QUEUE_DEBUG_MODEL = Object.freeze({
  id: "queue-debug-model",
  key: "debug/queue",
  name: "Queue Debug Voice",
  language: "debug",
  quality: "debug",
  origin: "debug",
  sampleRate: 22050,
  sizeBytes: 0,
  numSpeakers: 1,
  speakers: {},
});

/** Returns a sanitized, bounded recent-voice list from browser storage. */
function storedRecentIds() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

// Client state stays deliberately small: generated audio remains on the server,
// while only model selection and sentence timings are retained in the browser.
const state = {
  models: [],
  selectedId: localStorage.getItem("onnxtts.voice") || null,
  recentIds: storedRecentIds(),
  sentences: [],
  activeSentence: -1,
};

// Cache stable DOM references once after index.html has finished parsing.
const elements = {
  themeToggle: $("#themeToggle"),
  openInfo: $("#openInfo"),
  infoDialog: $("#infoDialog"),
  voiceList: $("#voiceList"),
  transcript: $("#transcript"),
  charCount: $("#charCount"),
  generate: $("#generate"),
  status: $("#editorStatus"),
  result: $("#result"),
  audio: $("#audio"),
  download: $("#download"),
  resultTitle: $("#resultTitle"),
  resultMeta: $("#resultMeta"),
  sentenceTimeline: $("#sentenceTimeline"),
  pace: $("#pace"),
  paceValue: $("#paceValue"),
  pause: $("#sentencePause"),
  pauseValue: $("#pauseValue"),
  speakerField: $("#speakerField"),
  speaker: $("#speaker"),
  dialog: $("#downloadDialog"),
  addMenuWrap: $("#addVoiceMenuWrap"),
  addMenu: $("#addVoiceMenu"),
  toggleAddMenu: $("#toggleAddMenu"),
  openDownload: $("#openDownload"),
  openUpload: $("#openUpload"),
  hfUrl: $("#hfUrl"),
  hfToken: $("#hfToken"),
  downloadStatus: $("#downloadStatus"),
  installVoice: $("#installVoice"),
  uploadDialog: $("#uploadDialog"),
  uploadForm: $("#uploadForm"),
  closeUpload: $("#closeUpload"),
  customModel: $("#customModel"),
  customConfig: $("#customConfig"),
  uploadStatus: $("#uploadStatus"),
  uploadVoice: $("#uploadVoice"),
};

// Theme state is mirrored across the document, control accessibility labels,
// browser chrome color, LocalStorage, and other open tabs.
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function syncThemeControl(theme) {
  const isDark = theme === "dark";
  elements.themeToggle.setAttribute("aria-pressed", String(isDark));
  elements.themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  elements.themeToggle.title = `Switch to ${isDark ? "light" : "dark"} theme`;
  elements.themeToggle.querySelector(".theme-toggle-label").textContent = isDark ? "Dark" : "Light";
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = isDark ? "#0e1521" : "#f5f7fb";
}

function setTheme(theme, persist = true) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
  syncThemeControl(nextTheme);
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme); } catch { /* Storage may be blocked. */ }
  }
}

elements.themeToggle.addEventListener("click", () => {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
});

window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY && (event.newValue === "light" || event.newValue === "dark")) {
    setTheme(event.newValue, false);
  }
});

syncThemeControl(currentTheme());

// The About dialog closes from its backdrop or content as a deliberate shortcut.
function dismissInfo() {
  if (elements.infoDialog.open) elements.infoDialog.close();
}

function openInfoDialog() {
  if (!elements.infoDialog.open) elements.infoDialog.showModal();
}

elements.openInfo.addEventListener("click", openInfoDialog);
elements.infoDialog.addEventListener("click", dismissInfo);

// Presentation helpers below never mutate model data returned by the server.
function bytes(value) {
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function selectedModel() {
  return state.models.find((model) => model.id === state.selectedId) || null;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function setDownloadStatus(message, error = false) {
  elements.downloadStatus.textContent = message;
  elements.downloadStatus.classList.toggle("error", error);
}

function setUploadStatus(message, error = false) {
  elements.uploadStatus.textContent = message;
  elements.uploadStatus.classList.toggle("error", error);
}

// Voice rendering owns speaker choices, recent history, grouping, and the one
// selected model id used by generation requests.
function updateSpeakers() {
  const model = selectedModel();
  const entries = Object.entries(model?.speakers || {});
  elements.speakerField.hidden = !model || model.numSpeakers <= 1;
  elements.speaker.replaceChildren();
  if (!model || model.numSpeakers <= 1) return;
  const speakerMap = entries.length ? entries.sort((a, b) => a[1] - b[1]) : Array.from({ length: model.numSpeakers }, (_, index) => [`Speaker ${index + 1}`, index]);
  for (const [name, id] of speakerMap) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${name} · ${id}`;
    elements.speaker.append(option);
  }
}

function persistRecentIds() {
  try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentIds)); } catch { /* Storage may be blocked. */ }
}

function recordRecentModel(modelId) {
  state.recentIds = [modelId, ...state.recentIds.filter((id) => id !== modelId)].slice(0, 5);
  persistRecentIds();
  renderModels();
}

function selectModel(model) {
  state.selectedId = model.id;
  try { localStorage.setItem("onnxtts.voice", model.id); } catch { /* Storage may be blocked. */ }
  renderModels();
}

function createVoiceCard(model) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `voice-card${model.id === state.selectedId ? " selected" : ""}`;
  button.dataset.id = model.id;

  const avatar = document.createElement("span");
  const tone = ((Number.parseInt(model.id.slice(-2), 16) || 0) % 3) + 1;
  avatar.className = `voice-avatar tone-${tone}`;
  avatar.textContent = initials(model.name);

  const info = document.createElement("span");
  info.className = "voice-info";
  const name = document.createElement("b");
  name.textContent = model.name;
  const detail = document.createElement("span");
  detail.textContent = `${model.language} · ${model.sampleRate ? `${(model.sampleRate / 1000).toFixed(1)} kHz` : "ONNX"} · ${bytes(model.sizeBytes)}`;
  info.append(name, detail);

  const quality = document.createElement("span");
  quality.className = "voice-quality";
  quality.textContent = model.quality;
  button.append(avatar, info, quality);
  button.addEventListener("click", () => selectModel(model));
  return button;
}

function createVoiceFolder(title, models, recent = false) {
  const folder = document.createElement("details");
  folder.className = `voice-folder${recent ? " recent-folder" : ""}`;
  folder.open = recent || models.some((model) => model.id === state.selectedId);

  const summary = document.createElement("summary");
  const folderName = document.createElement("span");
  folderName.textContent = title;
  const count = document.createElement("span");
  count.className = "voice-folder-count";
  count.textContent = String(models.length);
  summary.append(folderName, count);

  const items = document.createElement("div");
  items.className = "voice-folder-items";
  for (const model of models) items.append(createVoiceCard(model));
  folder.append(summary, items);
  return folder;
}

function renderModels() {
  elements.voiceList.replaceChildren();
  if (!state.models.length) {
    const empty = document.createElement("p");
    empty.className = "status-message";
    empty.textContent = "No compatible voices found. Use + to add one.";
    elements.voiceList.append(empty);
    setStatus("Add a Piper-compatible voice to begin.");
    return;
  }

  if (!state.models.some((model) => model.id === state.selectedId)) {
    state.selectedId = state.models.find((model) => model.key.includes("jenny_dioco"))?.id || state.models[0].id;
  }

  const modelById = new Map(state.models.map((model) => [model.id, model]));
  const recentModels = state.recentIds.map((id) => modelById.get(id)).filter(Boolean);
  if (recentModels.length !== state.recentIds.length) {
    state.recentIds = recentModels.map((model) => model.id);
    persistRecentIds();
  }
  if (recentModels.length) elements.voiceList.append(createVoiceFolder("Recent", recentModels, true));

  const groups = new Map();
  for (const model of state.models) {
    const folderName = model.custom ? "custom" : (model.language || "unknown");
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName).push(model);
  }
  const folderNames = [...groups.keys()].sort((a, b) => {
    if (a === "custom") return 1;
    if (b === "custom") return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  for (const folderName of folderNames) {
    const models = groups.get(folderName).sort((a, b) => a.name.localeCompare(b.name));
    elements.voiceList.append(createVoiceFolder(folderName, models));
  }

  const active = selectedModel();
  updateSpeakers();
  setStatus(`${active.name} selected · ${active.origin}`);
}

/**
 * Sends API requests and normalizes server failures into displayable errors.
 * The explicit queueDebug query path simulates overload without calling Piper.
 */
async function request(url, options = {}) {
  if (QUEUE_DEBUG_MODE === "full") {
    if (url === "/api/models") return { models: [QUEUE_DEBUG_MODEL] };
    if (url === "/api/generate") {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const error = new Error(QUEUE_FULL_MESSAGE);
      error.statusCode = 429;
      throw error;
    }
  }
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.detail || `Request failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

async function loadModels(preferredId) {
  const data = await request("/api/models");
  state.models = data.models;
  if (preferredId) state.selectedId = preferredId;
  renderModels();
}

// Sentence playback uses server-provided PCM timestamps. requestAnimationFrame
// keeps the active cue smooth during playback; media events cover pause/seek and
// browsers that throttle animation frames in background tabs.
let playbackFrame = null;

function resetSentenceTimeline() {
  state.sentences = [];
  state.activeSentence = -1;
  elements.sentenceTimeline.replaceChildren();
  elements.sentenceTimeline.hidden = true;
}

function formatCueTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return minutes + ":" + remainder;
}

function setActiveSentence(index, scroll = true) {
  if (state.activeSentence === index) return;
  state.activeSentence = index;
  const cues = elements.sentenceTimeline.querySelectorAll(".sentence-cue");
  cues.forEach((cue, cueIndex) => {
    const active = cueIndex === index;
    cue.classList.toggle("active", active);
    if (active) cue.setAttribute("aria-current", "true");
    else cue.removeAttribute("aria-current");
  });
  if (scroll && index >= 0) cues[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function sentenceAtTime(time) {
  return state.sentences.findIndex((sentence) => time >= sentence.start && time < sentence.end);
}

function updateSentenceHighlight() {
  setActiveSentence(sentenceAtTime(elements.audio.currentTime), !elements.audio.paused);
}

function trackPlayback() {
  updateSentenceHighlight();
  if (!elements.audio.paused && !elements.audio.ended) playbackFrame = requestAnimationFrame(trackPlayback);
}

function startPlaybackTracking() {
  if (playbackFrame != null) cancelAnimationFrame(playbackFrame);
  playbackFrame = requestAnimationFrame(trackPlayback);
}

function stopPlaybackTracking(clear = false) {
  if (playbackFrame != null) cancelAnimationFrame(playbackFrame);
  playbackFrame = null;
  if (clear) setActiveSentence(-1, false);
}

/** Builds text-only cue buttons from validated numeric timing metadata. */
function renderSentenceTimeline(sentences) {
  resetSentenceTimeline();
  const valid = Array.isArray(sentences) ? sentences
    .map((sentence) => ({ text: String(sentence.text || "").trim(), start: Number(sentence.start), end: Number(sentence.end) }))
    .filter((sentence) => sentence.text && Number.isFinite(sentence.start) && Number.isFinite(sentence.end) && sentence.end >= sentence.start)
    : [];
  state.sentences = valid;
  if (!valid.length) return;

  const fragment = document.createDocumentFragment();
  valid.forEach((sentence, index) => {
    const cue = document.createElement("button");
    cue.type = "button";
    cue.className = "sentence-cue";
    cue.dataset.index = String(index);
    cue.setAttribute("aria-label", "Seek to " + formatCueTime(sentence.start));
    const time = document.createElement("span");
    time.className = "sentence-cue-time";
    time.textContent = formatCueTime(sentence.start);
    const text = document.createElement("span");
    text.className = "sentence-cue-text";
    text.textContent = sentence.text;
    cue.append(time, text);
    fragment.append(cue);
  });
  elements.sentenceTimeline.append(fragment);
  elements.sentenceTimeline.hidden = false;
}

/** Seeks to a cue immediately, or waits for media metadata when clicked early.
 * HTTP byte-range support lets the browser perform the resulting random seek. */
function seekToSentence(event) {
  const cue = event.target.closest?.(".sentence-cue");
  if (!cue || !elements.sentenceTimeline.contains(cue)) return;
  const sentence = state.sentences[Number(cue.dataset.index)];
  if (!sentence) return;
  const seek = () => { elements.audio.currentTime = sentence.start; };
  if (elements.audio.readyState === 0) elements.audio.addEventListener("loadedmetadata", seek, { once: true });
  else seek();

  setActiveSentence(Number(cue.dataset.index), false);
}
/** Runs one complete UI generation cycle and replaces any prior preview state.
 * Queue overload errors flow through the same status area as validation errors. */
async function generate() {
  const model = selectedModel();
  const text = elements.transcript.value.trim();
  if (!model) return setStatus("Choose or add a voice first.", true);
  if (!text) return setStatus("Paste a transcript before generating audio.", true);
  elements.generate.disabled = true;
  elements.generate.classList.add("loading");
  elements.generate.querySelector(".button-icon").textContent = "◌";
  elements.generate.querySelector(".button-label").textContent = "Rendering locally…";
  setStatus("Loading the voice and synthesising your transcript…");
  stopPlaybackTracking(true);
  elements.audio.pause();
  elements.result.hidden = true;
  resetSentenceTimeline();
  try {
    const format = document.querySelector('input[name="format"]:checked').value;
    const data = await request("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        text,
        modelId: model.id,
        format,
        lengthScale: Number(elements.pace.value),
        sentenceSilence: Number(elements.pause.value) / 1000,
        speakerId: elements.speakerField.hidden ? null : elements.speaker.value,
      }),
    });
    elements.audio.src = data.mediaUrl;
    elements.download.href = data.downloadUrl;
    elements.resultTitle.textContent = `${model.name} preview`;
    elements.resultMeta.textContent = `${data.duration ? `${data.duration.toFixed(1)} sec · ` : ""}${format.toUpperCase()} · ${data.sampleRate ? `${(data.sampleRate / 1000).toFixed(1)} kHz` : "local render"}`;
    renderSentenceTimeline(data.sentences);
    elements.result.hidden = false;
    recordRecentModel(model.id);
    setStatus("Preview ready. Play it here or download the file.");
    await elements.audio.play().catch(() => {});
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.generate.disabled = false;
    elements.generate.classList.remove("loading");
    elements.generate.querySelector(".button-icon").textContent = "▶";
    elements.generate.querySelector(".button-label").textContent = "Generate preview";
  }
}

/** Inspects and installs one unambiguous Hugging Face voice-model pair.
 * Tokens exist only in the request and are cleared after a successful install. */
async function installVoice() {
  const url = elements.hfUrl.value.trim();
  if (!url) return setDownloadStatus("Paste a Hugging Face URL first.", true);
  elements.installVoice.disabled = true;
  elements.installVoice.querySelector(".button-label").textContent = "Inspecting repository…";
  setDownloadStatus("Looking for a matching ONNX model and Piper configuration…");
  try {
    const credentials = { url, token: elements.hfToken.value.trim() || undefined };
    const inspection = await request("/api/models/inspect", { method: "POST", body: JSON.stringify(credentials) });
    if (inspection.candidates.length !== 1) throw new Error(`Found ${inspection.candidates.length} voices. Paste the URL of one specific voice folder.`);
    const candidate = inspection.candidates[0];
    elements.installVoice.querySelector(".button-label").textContent = "Downloading…";
    setDownloadStatus(`Found ${candidate.name}${candidate.sizeBytes ? ` · ${bytes(candidate.sizeBytes)}` : ""}. Downloading to this machine…`);
    const installed = await request("/api/models/download", { method: "POST", body: JSON.stringify(credentials) });
    await loadModels(installed.model?.id);
    setDownloadStatus(installed.alreadyInstalled ? "This voice was already installed and is now selected." : "Voice installed and selected. You can close this window.");
    elements.hfToken.value = "";
  } catch (error) {
    setDownloadStatus(error.message, true);
  } finally {
    elements.installVoice.disabled = false;
    elements.installVoice.querySelector(".button-label").textContent = "Inspect & download";
  }
}

// The compact add-voice menu preserves keyboard focus when Escape dismisses it
// and delegates the actual workflows to their native dialogs.
function closeAddMenu(restoreFocus = false) {
  if (elements.addMenu.hidden) return;
  elements.addMenu.hidden = true;
  elements.toggleAddMenu.setAttribute("aria-expanded", "false");
  if (restoreFocus) elements.toggleAddMenu.focus();
}

function toggleAddMenu() {
  const shouldOpen = elements.addMenu.hidden;
  if (!shouldOpen) return closeAddMenu();
  elements.addMenu.hidden = false;
  elements.toggleAddMenu.setAttribute("aria-expanded", "true");
  setTimeout(() => elements.openDownload.focus(), 0);
}

function openDownloadDialog() {
  closeAddMenu();
  setDownloadStatus("");
  elements.dialog.showModal();
  setTimeout(() => elements.hfUrl.focus(), 0);
}

function openUploadDialog() {
  closeAddMenu();
  elements.uploadForm.reset();
  setUploadStatus("");
  elements.uploadDialog.showModal();
  setTimeout(() => elements.customModel.focus(), 0);
}

/** Uploads one matching ONNX/config pair using multipart data, then refreshes
 * the library so the server-validated model becomes the active selection. */
async function uploadCustomVoice(event) {
  event.preventDefault();
  const modelFile = elements.customModel.files[0];
  const configFile = elements.customConfig.files[0];
  if (!modelFile || !configFile) return setUploadStatus("Choose both an ONNX model and its JSON configuration.", true);
  if (!modelFile.name.toLowerCase().endsWith(".onnx")) return setUploadStatus("The model must use the .onnx extension.", true);
  if (!configFile.name.toLowerCase().endsWith(".json")) return setUploadStatus("The configuration must use the .json extension.", true);

  elements.uploadVoice.disabled = true;
  elements.uploadVoice.querySelector(".button-label").textContent = "Uploading…";
  setUploadStatus("Uploading " + modelFile.name + " · " + bytes(modelFile.size) + "…");
  try {
    const body = new FormData();
    body.append("model", modelFile, modelFile.name);
    body.append("config", configFile, configFile.name);
    const uploaded = await request("/api/models/upload", { method: "POST", body });
    if (!uploaded.model) throw new Error("The server stored the files but could not find the new voice.");
    await loadModels(uploaded.model.id);
    setUploadStatus("Custom voice uploaded and selected. You can close this window.");
    elements.uploadForm.reset();
  } catch (error) {
    setUploadStatus(error.message, true);
  } finally {
    elements.uploadVoice.disabled = false;
    elements.uploadVoice.querySelector(".button-label").textContent = "Upload voice";
  }
}

// Register element-level controls after every handler has been declared; audio
// events keep both native controls and sentence cues synchronized.
elements.transcript.addEventListener("input", () => { elements.charCount.textContent = `${elements.transcript.value.length.toLocaleString()} / 50,000`; });
elements.pace.addEventListener("input", () => {
  const value = Number(elements.pace.value);
  const label = value < 0.9 ? "Brisk" : value > 1.1 ? "Measured" : "Natural";
  elements.paceValue.textContent = `${label} · ${value.toFixed(2)}×`;
});
elements.pause.addEventListener("input", () => { elements.pauseValue.textContent = `${elements.pause.value} ms`; });
elements.generate.addEventListener("click", generate);
elements.sentenceTimeline.addEventListener("click", seekToSentence);
elements.audio.addEventListener("play", startPlaybackTracking);
elements.audio.addEventListener("pause", () => stopPlaybackTracking());
elements.audio.addEventListener("ended", () => stopPlaybackTracking(true));
elements.audio.addEventListener("timeupdate", updateSentenceHighlight);
elements.audio.addEventListener("seeked", updateSentenceHighlight);
elements.installVoice.addEventListener("click", installVoice);
elements.uploadForm.addEventListener("submit", uploadCustomVoice);
elements.toggleAddMenu.addEventListener("click", toggleAddMenu);
elements.openDownload.addEventListener("click", openDownloadDialog);
elements.openUpload.addEventListener("click", openUploadDialog);
elements.closeUpload.addEventListener("click", () => elements.uploadDialog.close());

// Global handlers cover outside-click dismissal, keyboard escape, and tab sync.
document.addEventListener("click", (event) => {
  if (!elements.addMenuWrap.contains(event.target)) closeAddMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.addMenu.hidden) {
    event.preventDefault();
    closeAddMenu(true);
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === RECENT_STORAGE_KEY) {
    state.recentIds = storedRecentIds();
    renderModels();
  }
});

// Prime derived labels synchronously, then hydrate the model library from disk.
elements.transcript.dispatchEvent(new Event("input"));
loadModels().catch((error) => {
  elements.voiceList.textContent = "Voice library unavailable.";
  setStatus(error.message, true);
});
