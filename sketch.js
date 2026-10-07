// =============================================================
// Hands-free Loop Station
// Point with your index finger to choose a pad.
// Trigger it by holding still (dwell) OR saying "go".
// Say "stop" to silence everything, "up"/"down" for volume.
//
// Keys:  E = switch play / study mode
//        1 / 2 / 3 = start study block (dwell / voice / combined)
//        S = save study data as CSV
//        M = mouse cursor instead of hand (for testing)
// =============================================================

// ---------- Settings you may want to tweak ----------
const BPM = 96;
const BEATS_PER_BAR = 4;
const LOOP_BARS = 2;            // length of every loop file, in bars
const DWELL_MS = 1000;          // hold time to trigger by dwell
const VOICE_COOLDOWN_MS = 1200; // ignore repeats of the same word
const RETOGGLE_GUARD_MS = 800;  // stops dwell + "go" double-toggling
const HAND_LOST_MS = 400;       // hide cursor after this long without a hand
const SMOOTHING = 0.35;         // 0..1, higher = snappier cursor
const VOICE_WORDS = ["go", "stop", "up", "down"];

const TRIALS_PER_BLOCK = 15;
const TRIAL_TIMEOUT_MS = 10000;
const TARGET_SIZES = [50, 80, 110]; // diameters in pixels

// ---------- Colors ----------
const C = {
  overlay: [14, 17, 22, 200],
  surface: "#1b212b",
  border: "#323b4a",
  text: "#e8ecf2",
  muted: "#9aa4b2",
  good: "#4cc38a",
  warn: "#e5a93b",
  bad: "#e5534b",
};

const PAD_DEFS = [
  { name: "Drums",      file: "sounds/drums.wav",      color: "#5b8def" },
  { name: "Bass",       file: "sounds/bass.wav",       color: "#8b6cf0" },
  { name: "Chords",     file: "sounds/chords.wav",     color: "#3fb6a8" },
  { name: "Vocal chop", file: "sounds/vocal-chop.wav", color: "#e07ab0" },
  { name: "Hi-hats",    file: "sounds/hihats.wav",     color: "#d9a441" },
  { name: "Guitar",     file: "sounds/guitar.wav",     color: "#e2814d" },
  { name: "Pads",       file: "sounds/pads.wav",       color: "#6fbf5e" },
  { name: "Stop all",   action: "stopAll",             color: C.bad },
];

// ---------- State ----------
let video, handPose, classifier;
let hands = [];
let started = false;
let useMouse = false;

let pads = [];
let clockStart = 0;
let volume = 0.8;

const cursor = { x: 0, y: 0, conf: 0, visible: false, lastSeen: -9999 };
let hovered = null;      // pad or study target under cursor
let dwellItem = null;
let dwellStart = 0;
let dwellProgress = 0;
let lockedItem = null;   // item just triggered; ignored until cursor leaves

let heard = { label: "", time: -9999 };
let message = { text: "", time: -9999 };

let mode = "play";       // "play" or "study"
const study = {
  participant: "",
  condition: null,       // "dwell" | "voice" | "combined"
  state: "idle",         // "idle" | "running" | "done"
  trial: 0,
  target: null,
  prevTarget: null,
  trialStart: 0,
  errors: 0,
  table: null,
  blockResults: [],
};

// =============================================================
// p5 lifecycle
// =============================================================
function preload() {
  handPose = ml5.handPose({ maxHands: 1, flipped: true });
  classifier = ml5.soundClassifier("SpeechCommands18w", { probabilityThreshold: 0.75 });
  for (const def of PAD_DEFS) {
    const pad = { ...def, state: "off", startAt: 0, lastToggle: -9999, rect: null };
    if (def.file) pad.sound = loadSound(def.file);
    pads.push(pad);
  }
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont("system-ui, -apple-system, Segoe UI, sans-serif");
  video = createCapture(VIDEO, { flipped: true });
  video.size(640, 480);
  video.hide();
  for (const p of pads) if (p.sound) p.sound.playMode("restart");
  setupStudyTable();
  layoutPads();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  layoutPads();
}

function mousePressed() {
  if (started) return;
  userStartAudio();
  outputVolume(volume);
  clockStart = audioNow() + 0.1;
  handPose.detectStart(video, (results) => (hands = results));
  classifier.classifyStart(gotVoice);
  started = true;
}

function draw() {
  drawBackground();
  if (!started) return drawStartScreen();

  updateCursor();
  updateHover();
  updateDwell();
  updatePadStates();
  if (mode === "study") updateStudy();

  drawTopBar();
  if (mode === "play") drawPads(); else drawStudy();
  drawBottomBar();
  drawCursor();
}

// =============================================================
// Audio clock: every loop starts on a loop boundary so all stay in sync
// =============================================================
function audioNow() { return getAudioContext().currentTime; }
function loopSeconds() { return (LOOP_BARS * BEATS_PER_BAR * 60) / BPM; }
function secondsToNextLoop() {
  const d = loopSeconds();
  const rem = d - ((audioNow() - clockStart) % d);
  return rem < 0.05 ? rem + d : rem;
}
function beatPosition() {
  const beats = ((audioNow() - clockStart) * BPM) / 60;
  const b = Math.max(0, Math.floor(beats));
  return { bar: (Math.floor(b / BEATS_PER_BAR) % LOOP_BARS) + 1, beat: (b % BEATS_PER_BAR) + 1, frac: beats % 1 };
}

// =============================================================
// Input: hand cursor
// =============================================================
function updateCursor() {
  if (useMouse) {
    cursor.x = mouseX; cursor.y = mouseY; cursor.conf = 1;
    cursor.visible = true; cursor.lastSeen = millis();
    return;
  }
  if (hands.length > 0) {
    const h = hands[0];
    const tip = h.index_finger_tip;
    // Video is drawn stretched to the canvas, so map video coords the same way
    const tx = (tip.x * width) / video.width;
    const ty = (tip.y * height) / video.height;
    if (!cursor.visible) { cursor.x = tx; cursor.y = ty; }
    cursor.x = lerp(cursor.x, tx, SMOOTHING);
    cursor.y = lerp(cursor.y, ty, SMOOTHING);
    cursor.conf = lerp(cursor.conf, h.confidence ?? 1, 0.2);
    cursor.visible = true;
    cursor.lastSeen = millis();
  } else if (millis() - cursor.lastSeen > HAND_LOST_MS) {
    cursor.visible = false;
    cursor.conf = lerp(cursor.conf, 0, 0.2);
  }
}

function updateHover() {
  hovered = null;
  if (!cursor.visible) return;
  if (mode === "play") {
    hovered = pads.find((p) => inside(cursor.x, cursor.y, p.rect)) || null;
  } else if (study.state === "running" && study.target) {
    const t = study.target;
    if (dist(cursor.x, cursor.y, t.x, t.y) <= t.d / 2) hovered = t;
  }
  if (lockedItem && hovered !== lockedItem) lockedItem = null;
}

function dwellAllowed() { return mode === "play" || study.condition !== "voice"; }
function voiceAllowed() { return mode === "play" || study.condition !== "dwell"; }

function updateDwell() {
  if (!hovered || hovered === lockedItem || !dwellAllowed()) {
    dwellItem = null; dwellProgress = 0; return;
  }
  if (hovered !== dwellItem) { dwellItem = hovered; dwellStart = millis(); }
  dwellProgress = (millis() - dwellStart) / DWELL_MS;
  if (dwellProgress >= 1) trigger(hovered, "dwell");
}

// =============================================================
// Input: voice
// =============================================================
function gotVoice(results) {
  if (!results || !results[0]) return;
  const label = results[0].label;
  if (!VOICE_WORDS.includes(label)) return;
  if (label === heard.label && millis() - heard.time < VOICE_COOLDOWN_MS) return;
  heard = { label, time: millis() };

  if (mode === "study") {
    if (label === "go" && study.state === "running" && voiceAllowed()) {
      if (hovered) trigger(hovered, "voice");
      else study.errors++;   // said "go" while off target
    }
    return;
  }

  if (label === "go") {
    if (hovered) trigger(hovered, "voice");
    else say("Point at a pad first, then say go");
  } else if (label === "stop") {
    stopAll();
  } else if (label === "up" || label === "down") {
    volume = constrain(volume + (label === "up" ? 0.1 : -0.1), 0, 1);
    outputVolume(volume, 0.1);
    say(`Volume ${round(volume * 100)}%`);
  }
}

// =============================================================
// Actions
// =============================================================
function trigger(item, method) {
  lockedItem = item;
  dwellItem = null;
  dwellProgress = 0;
  if (mode === "study") return studyHit(method);

  const pad = item;
  if (millis() - pad.lastToggle < RETOGGLE_GUARD_MS) return;
  pad.lastToggle = millis();

  if (pad.action === "stopAll") return stopAll();
  if (pad.state === "off") {
    const wait = secondsToNextLoop();
    pad.sound.loop(wait);          // starts on the next loop boundary
    pad.startAt = audioNow() + wait;
    pad.state = "queued";
  } else {
    pad.sound.stop();
    pad.state = "off";
  }
}

function stopAll() {
  for (const p of pads) {
    if (p.sound) p.sound.stop();
    p.state = "off";
  }
  say("Everything stopped");
}

function updatePadStates() {
  for (const p of pads) {
    if (p.state === "queued" && audioNow() >= p.startAt) p.state = "on";
  }
}

function say(text) { message = { text, time: millis() }; }

// =============================================================
// Layout + drawing
// =============================================================
const TOP_H = 64, BOTTOM_H = 56, MARGIN = 24, GAP = 16;

function layoutPads() {
  const cols = 4, rows = 2;
  const areaW = Math.min(width - MARGIN * 2, 1100);
  const areaH = height - TOP_H - BOTTOM_H - MARGIN * 2;
  const w = (areaW - GAP * (cols - 1)) / cols;
  const h = Math.min((areaH - GAP * (rows - 1)) / rows, w * 0.9);
  const x0 = (width - (w * cols + GAP * (cols - 1))) / 2;
  const y0 = TOP_H + MARGIN + (areaH - (h * rows + GAP * (rows - 1))) / 2;
  pads.forEach((p, i) => {
    p.rect = { x: x0 + (i % cols) * (w + GAP), y: y0 + Math.floor(i / cols) * (h + GAP), w, h };
  });
}

function inside(x, y, r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function drawBackground() {
  background(14, 17, 22);
  if (video && video.loadedmetadata) image(video, 0, 0, width, height);
  noStroke();
  fill(...C.overlay);
  rect(0, 0, width, height);
}

function drawStartScreen() {
  textAlign(CENTER, CENTER);
  fill(C.text); textSize(32); textStyle(BOLD);
  text("Hands-free Loop Station", width / 2, height / 2 - 30);
  textStyle(NORMAL); textSize(16); fill(C.muted);
  text("Click anywhere to start. Allow camera and microphone access when asked.", width / 2, height / 2 + 14);
}

function pill(x, y, label, col) {
  textSize(13); textStyle(BOLD);
  const w = textWidth(label) + 24;
  noStroke(); fill(color(col + "33"));
  rect(x, y - 13, w, 26, 13);
  fill(col); textAlign(LEFT, CENTER);
  text(label, x + 12, y);
  textStyle(NORMAL);
  return x + w + 12;
}

function drawTopBar() {
  const y = TOP_H / 2;
  let x = MARGIN;

  // Hand status + confidence meter
  const handCol = !cursor.visible ? C.bad : cursor.conf > 0.7 ? C.good : C.warn;
  x = pill(x, y, cursor.visible ? (useMouse ? "Mouse cursor" : "Hand tracked") : "Show your hand", handCol);
  fill(C.border); rect(x, y - 3, 120, 6, 3);
  fill(handCol); rect(x, y - 3, 120 * constrain(cursor.conf, 0, 1), 6, 3);
  fill(C.muted); textSize(13); textAlign(LEFT, CENTER);
  text(cursor.conf.toFixed(2), x + 130, y);
  x += 180;

  // Last heard word (fades out)
  const age = millis() - heard.time;
  if (age < 1500) pill(x, y, `Heard "${heard.label}"`, C.good);
  else pill(x, y, "Listening", C.muted);

  // Right side: mode, volume, tempo
  textAlign(RIGHT, CENTER); fill(C.muted); textSize(13);
  const pos = beatPosition();
  const right = mode === "play"
    ? `Volume ${round(volume * 100)}%     ${BPM} bpm   bar ${pos.bar} beat ${pos.beat}`
    : `Study mode${study.participant ? `   participant ${study.participant}` : ""}`;
  text(right, width - MARGIN, y);
}

function drawPads() {
  const pulse = 1 - beatPosition().frac; // flashes on each beat
  for (const p of pads) {
    const r = p.rect;
    const isHover = p === hovered;
    const base = color(p.color);

    stroke(isHover ? C.text : C.border);
    strokeWeight(isHover ? 2 : 1);
    if (p.state === "on") {
      const c = color(p.color); c.setAlpha(150 + 80 * pulse); fill(c);
    } else {
      fill(C.surface);
    }
    rect(r.x, r.y, r.w, r.h, 14);

    if (p.state === "queued") { // dashed outline while waiting for the bar
      noFill(); stroke(base); strokeWeight(2);
      drawingContext.setLineDash([8, 6]);
      rect(r.x + 5, r.y + 5, r.w - 10, r.h - 10, 10);
      drawingContext.setLineDash([]);
    }

    noStroke();
    if (p.state !== "on") { fill(base); circle(r.x + 22, r.y + 22, 10); }
    fill(C.text); textAlign(CENTER, CENTER);
    textSize(Math.max(14, r.w * 0.08)); textStyle(BOLD);
    text(p.name, r.x + r.w / 2, r.y + r.h / 2 - 8);
    textStyle(NORMAL); textSize(13); fill(p.state === "on" ? C.text : C.muted);
    const status = p.action ? "Silence everything"
      : p.state === "on" ? "Playing"
      : p.state === "queued" ? `Starts in ${max(0, p.startAt - audioNow()).toFixed(1)}s`
      : "Off";
    text(status, r.x + r.w / 2, r.y + r.h / 2 + 18);
  }
}

function drawBottomBar() {
  const y = height - BOTTOM_H / 2;
  textAlign(CENTER, CENTER); textSize(14);
  if (millis() - message.time < 2000) {
    fill(C.text); text(message.text, width / 2, y);
  } else if (mode === "play") {
    fill(C.muted);
    text('Point at a pad, then hold still or say "go".  Say "stop" to silence everything, "up" or "down" for volume.', width / 2, y);
  }
}

function drawCursor() {
  if (!cursor.visible) return;
  const steady = cursor.conf > 0.7;
  noFill();
  stroke(steady ? C.text : C.warn); strokeWeight(2);
  if (!steady) drawingContext.setLineDash([5, 5]);
  circle(cursor.x, cursor.y, 36);
  drawingContext.setLineDash([]);
  if (dwellProgress > 0) {
    stroke(C.good); strokeWeight(4);
    arc(cursor.x, cursor.y, 36, 36, -HALF_PI, -HALF_PI + TWO_PI * min(dwellProgress, 1));
  }
  noStroke(); fill(steady ? C.text : C.warn);
  circle(cursor.x, cursor.y, 6);
}

// =============================================================
// Study mode: timed target selection, logged to CSV
// =============================================================
function setupStudyTable() {
  study.table = new p5.Table();
  ["participant", "condition", "trial", "target_diameter", "distance", "time_ms",
   "errors", "method", "timed_out", "confidence", "timestamp"].forEach((c) => study.table.addColumn(c));
}

function keyPressed() {
  const k = key.toLowerCase();
  if (k === "m") { useMouse = !useMouse; say(useMouse ? "Mouse cursor on" : "Hand cursor on"); }
  if (!started) return;
  if (k === "e") {
    mode = mode === "play" ? "study" : "play";
    if (mode === "study") {
      stopAll();
      if (!study.participant) study.participant = prompt("Participant ID?", "P1") || "P1";
      study.state = "idle";
    }
  }
  if (mode === "study" && study.state !== "running") {
    const conds = { 1: "dwell", 2: "voice", 3: "combined" };
    if (conds[k]) startBlock(conds[k]);
  }
  if (k === "s") {
    saveTable(study.table, `study_${study.participant || "data"}.csv`);
    say("Study data saved");
  }
}

function startBlock(condition) {
  study.condition = condition;
  study.state = "running";
  study.trial = 0;
  study.blockResults = [];
  study.prevTarget = { x: width / 2, y: height / 2 };
  nextTrial();
}

function nextTrial() {
  study.trial++;
  if (study.trial > TRIALS_PER_BLOCK) { study.state = "done"; study.target = null; return; }
  const d = random(TARGET_SIZES);
  const pad = d / 2 + 20;
  study.target = {
    x: random(pad, width - pad),
    y: random(TOP_H + pad, height - BOTTOM_H - pad),
    d,
  };
  study.target.distance = dist(study.prevTarget.x, study.prevTarget.y, study.target.x, study.target.y);
  study.trialStart = millis();
  study.errors = 0;
}

function studyHit(method) { logTrial(method, false); }

function logTrial(method, timedOut) {
  const t = study.target;
  const time = millis() - study.trialStart;
  const row = study.table.addRow();
  row.setString("participant", study.participant);
  row.setString("condition", study.condition);
  row.setNum("trial", study.trial);
  row.setNum("target_diameter", t.d);
  row.setNum("distance", round(t.distance));
  row.setNum("time_ms", round(time));
  row.setNum("errors", study.errors);
  row.setString("method", method);
  row.setString("timed_out", timedOut ? "yes" : "no");
  row.setNum("confidence", +cursor.conf.toFixed(3));
  row.setString("timestamp", new Date().toISOString());
  study.blockResults.push({ time, errors: study.errors, timedOut });
  study.prevTarget = t;
  nextTrial();
}

function updateStudy() {
  if (study.state === "running" && millis() - study.trialStart > TRIAL_TIMEOUT_MS) {
    logTrial("none", true);
  }
}

function drawStudy() {
  textAlign(CENTER, CENTER);
  if (study.state === "idle") {
    fill(C.text); textSize(22); textStyle(BOLD);
    text("Study mode", width / 2, height / 2 - 50);
    textStyle(NORMAL); textSize(16); fill(C.muted);
    text("Press 1 for dwell only, 2 for voice only, 3 for combined.", width / 2, height / 2 - 10);
    text(`Each block has ${TRIALS_PER_BLOCK} targets. Press E to return to the loop station.`, width / 2, height / 2 + 18);
    return;
  }
  if (study.state === "done") {
    const r = study.blockResults;
    const ok = r.filter((x) => !x.timedOut);
    const avg = ok.length ? ok.reduce((s, x) => s + x.time, 0) / ok.length : 0;
    const errs = r.reduce((s, x) => s + x.errors, 0);
    fill(C.text); textSize(22); textStyle(BOLD);
    text(`Block finished: ${study.condition}`, width / 2, height / 2 - 50);
    textStyle(NORMAL); textSize(16); fill(C.muted);
    text(`Average time ${(avg / 1000).toFixed(2)}s   errors ${errs}   timeouts ${r.length - ok.length}`, width / 2, height / 2 - 10);
    text("Press 1, 2 or 3 for the next block. Press S to save the CSV.", width / 2, height / 2 + 18);
    return;
  }
  // Running: draw the target
  const t = study.target;
  stroke(t === hovered ? C.text : C.border); strokeWeight(2);
  fill(color("#5b8def"));
  circle(t.x, t.y, t.d);
  noStroke(); fill(C.muted); textSize(14);
  const how = { dwell: "Hold still on the target", voice: 'Point at the target and say "go"', combined: 'Hold still or say "go"' }[study.condition];
  text(`${study.condition} · target ${study.trial} of ${TRIALS_PER_BLOCK}.  ${how}`, width / 2, height - BOTTOM_H / 2);
}
