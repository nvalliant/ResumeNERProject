const ENTITY_MAP = {
  "job title": {
    cls: "ent-job",
    color: "#a78bfa",
    label: "Job Title",
  },
  "years or months of experience": {
    cls: "ent-dur",
    color: "#fbbf24",
    label: "Duration",
  },
  "technical skill": {
    cls: "ent-skill",
    color: "#34d399",
    label: "Skill",
  },
  "certification or license": {
    cls: "ent-cert",
    color: "#60a5fa",
    label: "Certification",
  },
  "soft skill or personal trait": {
    cls: "ent-trait",
    color: "#f87171",
    label: "Trait",
  },
  "company name": {
    cls: "ent-company",
    color: "#fb923c",
    label: "Company",
  },
  "university degree or major": {
    cls: "ent-edu",
    color: "#e879f9",
    label: "Education",
  },
  "programming language": {
    cls: "ent-lang",
    color: "#22d3ee",
    label: "Language",
  },
  "software framework or library": {
    cls: "ent-lib",
    color: "#a3e635",
    label: "Framework",
  },
  contact: {
    cls: "ent-contact",
    color: "#f472b6",
    label: "Contact",
  },
};

const EXTRA_COLORS = [
  "#c084fc",
  "#fb923c",
  "#22d3ee",
  "#e879f9",
  "#a3e635",
  "#f472b6",
  "#38bdf8",
];
let extraColorIdx = 0;
const dynamicMap = {};

function getEntityInfo(type) {
  if (ENTITY_MAP[type]) return ENTITY_MAP[type];
  if (dynamicMap[type]) return dynamicMap[type];
  const color = EXTRA_COLORS[extraColorIdx++ % EXTRA_COLORS.length];
  dynamicMap[type] = { cls: "ent-other", color, label: type };
  return dynamicMap[type];
}

let activeFilter = null;
let currentSpans = [];
let selectedFile = null;

// ── File drop ──
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const badge = document.getElementById("file-name-badge");
const btnAnalyze = document.getElementById("btn-analyze");

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) setFile(f);
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("dragging"),
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});

function setFile(f) {
  if (!f.name.toLowerCase().endsWith(".pdf")) {
    showError("Only PDF files are supported.");
    return;
  }
  selectedFile = f;
  badge.textContent = "📎 " + f.name;
  badge.classList.add("visible");
  btnAnalyze.disabled = false;
  hideError();
}

// ── Analyze ──
btnAnalyze.addEventListener("click", analyze);

function showError(msg) {
  const el = document.getElementById("error-box");
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  document.getElementById("error-box").style.display = "none";
}
function setLoading(on) {
  document.getElementById("loading").classList.toggle("visible", on);
  btnAnalyze.disabled = on;
}

async function analyze() {
  if (!selectedFile) {
    showError("Please select a PDF file first.");
    return;
  }

  hideError();
  extraColorIdx = 0;
  Object.keys(dynamicMap).forEach((k) => delete dynamicMap[k]);
  setLoading(true);

  try {
    const formData = new FormData();
    formData.append("file", selectedFile);

    const res = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Server error. Check terminal for details.");
      return;
    }

    const { entities, text, "resume file": fileName } = data;

    // Build spans from entities
    const spans = [];
    for (const [type, items] of Object.entries(entities)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item.char_start !== "number") continue;

        spans.push({
          type,
          start: item.char_start,
          end: item.char_end,
          score: item.score || 0,
        });
      }
    }

    spans.sort((a, b) => a.start - b.start || b.end - a.end);

    // Merge overlapping spans, keep highest score
    const merged = [];
    for (const s of spans) {
      if (!merged.length || s.start >= merged[merged.length - 1].end) {
        merged.push({ ...s });
      } else if (s.score > merged[merged.length - 1].score) {
        merged[merged.length - 1] = { ...s };
      }
    }
    currentSpans = merged;

    document.getElementById("output-file").textContent = fileName;
    activeFilter = null;
    renderHighlights(text, null);
    document.getElementById("output-section").classList.add("visible");

    renderLegend(entities);
    renderStats(entities);
    renderConfBars(entities);
  } catch (err) {
    showError("Request failed: " + err.message);
  } finally {
    setLoading(false);
    btnAnalyze.disabled = false;
  }
}

// ── Render highlights ──
function renderHighlights(text, filter) {
  const body = document.getElementById("resume-body");
  const frag = document.createDocumentFragment();
  let cursor = 0;

  // FIX: Convert the string to an array of Unicode characters.
  // This forces JS to count characters (like bullets/ligatures) exactly the way Python does.
  const textChars = Array.from(text);

  for (const span of currentSpans) {
    if (span.start > cursor) {
      // Slice the array and join it back into a string
      const textBefore = textChars.slice(cursor, span.start).join("");
      frag.appendChild(document.createTextNode(textBefore));
    }
    const info = getEntityInfo(span.type);
    const mark = document.createElement("mark");
    mark.className = "ent " + info.cls;
    mark.dataset.type = span.type;
    mark.dataset.score = span.score;
    if (filter && span.type !== filter) mark.classList.add("dimmed");

    // Slice the highlighted text from the array
    mark.textContent = textChars.slice(span.start, span.end).join("");

    mark.addEventListener("mouseenter", (e) =>
      showTooltip(e, info.label, span.score),
    );
    mark.addEventListener("mousemove", moveTooltip);
    mark.addEventListener("mouseleave", hideTooltip);
    frag.appendChild(mark);
    cursor = span.end;
  }

  if (cursor < textChars.length) {
    const textAfter = textChars.slice(cursor).join("");
    frag.appendChild(document.createTextNode(textAfter));
  }

  body.innerHTML = "";
  body.appendChild(frag);
}

function applyFilter(type) {
  activeFilter = type;
  document.querySelectorAll(".ent").forEach((el) => {
    el.classList.toggle("dimmed", type !== null && el.dataset.type !== type);
  });
  updateLegendActive(type);
  document
    .getElementById("btn-clear-filter")
    .classList.toggle("visible", type !== null);
}

document
  .getElementById("btn-clear-filter")
  .addEventListener("click", () => applyFilter(null));

function renderLegend(entities) {
  const el = document.getElementById("legend-list");
  el.innerHTML = "";
  for (const [type, items] of Object.entries(entities)) {
    const info = getEntityInfo(type);
    const div = document.createElement("div");
    div.className = "legend-item";
    div.dataset.type = type;
    div.innerHTML = `
      <div class="legend-swatch" style="background:${info.color}"></div>
      <div class="legend-name">${info.label || type}</div>
      <div class="legend-count">${items.length}</div>
    `;
    div.addEventListener("click", () =>
      applyFilter(activeFilter === type ? null : type),
    );
    el.appendChild(div);
  }
}

function updateLegendActive(filter) {
  document.querySelectorAll(".legend-item").forEach((el) => {
    el.classList.toggle("active", filter && el.dataset.type === filter);
    el.classList.toggle("inactive", filter && el.dataset.type !== filter);
  });
}

function renderStats(entities) {
  const types = Object.keys(entities);
  const totalEntities = types.reduce((sum, t) => sum + entities[t].length, 0);
  const avgConf =
    types.reduce(
      (sum, t) => sum + entities[t].reduce((s, i) => s + (i.score || 0), 0),
      0,
    ) / (totalEntities || 1);

  document.getElementById("stat-grid").innerHTML = `
    <div class="stat-card"><div class="num">${totalEntities}</div><div class="lbl">Entities</div></div>
    <div class="stat-card"><div class="num">${types.length}</div><div class="lbl">Types</div></div>
    <div class="stat-card"><div class="num">${(avgConf * 100).toFixed(0)}%</div><div class="lbl">Avg Conf</div></div>
    <div class="stat-card"><div class="num">${types.length ? Math.max(...types.map((t) => entities[t].length)) : 0}</div><div class="lbl">Max Group</div></div>
  `;
  document.getElementById("stats-section").style.display = "block";
}

function renderConfBars(entities) {
  const el = document.getElementById("conf-bars");
  el.innerHTML = "";
  for (const [type, items] of Object.entries(entities)) {
    const info = getEntityInfo(type);
    const avg = items.reduce((s, i) => s + (i.score || 0), 0) / items.length;
    const pct = Math.round(avg * 100);
    el.innerHTML += `
      <div class="confidence-bar-wrap">
        <div class="confidence-label-row">
          <span class="confidence-name">${info.label || type}</span>
          <span class="confidence-val">${pct}%</span>
        </div>
        <div class="confidence-bar">
          <div class="confidence-fill" style="width:${pct}%; background:${info.color}"></div>
        </div>
      </div>
    `;
  }
  document.getElementById("conf-section").style.display = "block";
}

// ── Tooltip ──
const tooltip = document.getElementById("tooltip");
function showTooltip(e, label, score) {
  document.getElementById("tt-type").textContent = label;
  document.getElementById("tt-score").textContent =
    (score * 100).toFixed(1) + "%";
  tooltip.style.display = "block";
  positionTooltip(e);
}
function moveTooltip(e) {
  positionTooltip(e);
}
function positionTooltip(e) {
  tooltip.style.left = e.clientX + 14 + "px";
  tooltip.style.top = e.clientY - 36 + "px";
}
function hideTooltip() {
  tooltip.style.display = "none";
}
