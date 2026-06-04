(function () {
  "use strict";

  const video = document.getElementById("cameraFeed");
  const outputCanvas = document.getElementById("outputCanvas");
  const inkCanvas = document.getElementById("inkCanvas");
  const analysisCanvas = document.getElementById("analysisCanvas");
  const outputCtx = outputCanvas.getContext("2d");
  const inkCtx = inkCanvas.getContext("2d");
  const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

  const ui = {
    cameraToggle: document.getElementById("cameraToggle"),
    calibrateBtn: document.getElementById("calibrateBtn"),
    modeSelect: document.getElementById("modeSelect"),
    trackerSelect: document.getElementById("trackerSelect"),
    thicknessRange: document.getElementById("thicknessRange"),
    thicknessValue: document.getElementById("thicknessValue"),
    smoothingRange: document.getElementById("smoothingRange"),
    smoothingValue: document.getElementById("smoothingValue"),
    mirrorToggle: document.getElementById("mirrorToggle"),
    gridToggle: document.getElementById("gridToggle"),
    stabilizeToggle: document.getElementById("stabilizeToggle"),
    autoWriteToggle: document.getElementById("autoWriteToggle"),
    undoBtn: document.getElementById("undoBtn"),
    clearBtn: document.getElementById("clearBtn"),
    saveBtn: document.getElementById("saveBtn"),
    eraseBtn: document.getElementById("eraseBtn"),
    fpsValue: document.getElementById("fpsValue"),
    penValue: document.getElementById("penValue"),
    cameraStatus: document.getElementById("cameraStatus"),
    pipelineStatus: document.getElementById("pipelineStatus"),
    resolutionStatus: document.getElementById("resolutionStatus")
  };

  const state = {
    running: false,
    stream: null,
    width: 1280,
    height: 720,
    analysisWidth: 384,
    analysisHeight: 180,
    inkColor: "#111827",
    thickness: 7,
    smoothing: 0.65,
    eraseMode: false,
    penTarget: null,
    lastPoint: null,
    activeStroke: false,
    lastSeenAt: 0,
    previousFrame: null,
    backgroundLuma: null,
    lastAnalysisPoint: null,
    velocityAnalysis: { x: 0, y: 0 },
    frameCount: 0,
    fpsStartedAt: performance.now(),
    snapshots: [],
    calibration: null
  };

  function resizeCanvases() {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    if (outputCanvas.width === width && outputCanvas.height === height) {
      return;
    }

    const oldInk = document.createElement("canvas");
    oldInk.width = inkCanvas.width || width;
    oldInk.height = inkCanvas.height || height;
    oldInk.getContext("2d").drawImage(inkCanvas, 0, 0);

    state.width = width;
    state.height = height;
    outputCanvas.width = width;
    outputCanvas.height = height;
    inkCanvas.width = width;
    inkCanvas.height = height;
    analysisCanvas.width = state.analysisWidth;
    analysisCanvas.height = Math.round((height / width) * state.analysisWidth);
    state.analysisHeight = analysisCanvas.height;
    resetTrackerMemory();

    inkCtx.clearRect(0, 0, width, height);
    inkCtx.drawImage(oldInk, 0, 0, width, height);
    ui.resolutionStatus.textContent = `${width} x ${height}`;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera API unavailable in this browser", "error");
      return;
    }

    const constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 30 },
        facingMode: "environment"
      },
      audio: false
    };

    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = state.stream;
      await video.play();
      state.running = true;
      ui.cameraToggle.textContent = "Stop camera";
      ui.cameraStatus.textContent = "Camera live";
      setStatus("Realtime CV active", "ok");
      resetTrackerMemory();
      resizeCanvases();
      requestAnimationFrame(loop);
    } catch (error) {
      setStatus(`Camera blocked: ${error.message}`, "error");
    }
  }

  function stopCamera() {
    state.running = false;
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }
    state.stream = null;
    ui.cameraToggle.textContent = "Start camera";
    ui.cameraStatus.textContent = "Camera idle";
    setStatus("Camera stopped", "idle");
  }

  function setStatus(message) {
    ui.pipelineStatus.textContent = message;
  }

  function drawBoardBackground() {
    const mode = ui.modeSelect.value;
    outputCtx.save();
    outputCtx.clearRect(0, 0, state.width, state.height);

    if (mode === "camera" || mode === "overlay") {
      if (mode === "camera") {
        outputCtx.filter = "grayscale(1) brightness(1.35) contrast(0.55)";
        drawMirroredVideo(outputCtx, state.width, state.height);
        outputCtx.filter = "none";
        outputCtx.fillStyle = "rgba(255,255,255,0.34)";
        outputCtx.fillRect(0, 0, state.width, state.height);
      } else {
        drawMirroredVideo(outputCtx, state.width, state.height);
        outputCtx.fillStyle = "rgba(255,255,255,0.78)";
        outputCtx.fillRect(0, 0, state.width, state.height);
      }
    } else {
      outputCtx.fillStyle = "#ffffff";
      outputCtx.fillRect(0, 0, state.width, state.height);
    }

    if (ui.gridToggle.checked) {
      drawGrid();
    }

    outputCtx.drawImage(inkCanvas, 0, 0);
    outputCtx.restore();
  }

  function drawGrid() {
    const gap = Math.max(32, Math.round(state.width / 32));
    outputCtx.strokeStyle = "rgba(15, 23, 42, 0.08)";
    outputCtx.lineWidth = 1;
    outputCtx.beginPath();

    for (let x = 0; x <= state.width; x += gap) {
      outputCtx.moveTo(x, 0);
      outputCtx.lineTo(x, state.height);
    }

    for (let y = 0; y <= state.height; y += gap) {
      outputCtx.moveTo(0, y);
      outputCtx.lineTo(state.width, y);
    }

    outputCtx.stroke();
  }

  function drawMirroredVideo(ctx, width, height) {
    ctx.save();
    if (ui.mirrorToggle.checked) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }

  function detectPen(now) {
    analysisCtx.save();
    analysisCtx.clearRect(0, 0, state.analysisWidth, state.analysisHeight);
    if (ui.mirrorToggle.checked) {
      analysisCtx.translate(state.analysisWidth, 0);
      analysisCtx.scale(-1, 1);
    }
    analysisCtx.drawImage(video, 0, 0, state.analysisWidth, state.analysisHeight);
    analysisCtx.restore();

    const frame = analysisCtx.getImageData(0, 0, state.analysisWidth, state.analysisHeight);
    const candidate = findMarkerCandidate(frame);
    rememberFrame(frame);

    if (!candidate) {
      const bridgeWindow = now - state.lastSeenAt < 110;
      ui.penValue.textContent = bridgeWindow ? "Bridge" : "Lost";
      if (!bridgeWindow && now - state.lastSeenAt > 350) {
        state.lastAnalysisPoint = null;
        state.velocityAnalysis = { x: 0, y: 0 };
      }
      return bridgeWindow ? state.lastPoint : null;
    }

    const x = (candidate.x / state.analysisWidth) * state.width;
    const y = (candidate.y / state.analysisHeight) * state.height;
    const rawPoint = { x, y, confidence: candidate.confidence };
    const point = smoothPoint(rawPoint);

    state.lastSeenAt = now;
    ui.penValue.textContent = candidate.confidence > 0.72 ? "Tip locked" : "Tracking";
    return point;
  }

  function findMarkerCandidate(frame) {
    const data = frame.data;
    const width = frame.width;
    const height = frame.height;
    const totalPixels = width * height;
    const previous = state.previousFrame;
    const background = state.backgroundLuma;
    const scoreMap = new Float32Array(totalPixels);
    const visited = new Uint8Array(totalPixels);
    const stack = new Int32Array(totalPixels);
    const roi = getTrackingRoi(width, height);
    let best = null;

    for (let y = roi.y0; y <= roi.y1; y += 1) {
      for (let x = roi.x0; x <= roi.x1; x += 1) {
        const pixel = y * width + x;
        const index = pixel * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = luminance(r, g, b);
        const colorScore = colorPenScore(r, g, b);
        const motionScore = previous ? pixelMotionScore(data, previous, index) : 0;
        const backgroundScore = background ? Math.min(1, Math.abs(luma - background[pixel]) / 58) : 0;
        const darkScore = darkPenScore(r, g, b, motionScore, backgroundScore);
        const score = combineScores(colorScore, darkScore, motionScore, backgroundScore);

        if (score >= trackingThreshold(x, y, roi, colorScore, darkScore, motionScore)) {
          scoreMap[pixel] = score;
        }
      }
    }

    for (let y = roi.y0; y <= roi.y1; y += 1) {
      for (let x = roi.x0; x <= roi.x1; x += 1) {
        const pixel = y * width + x;
        if (visited[pixel] || scoreMap[pixel] === 0) {
          continue;
        }

        const component = collectComponent(pixel, width, height, roi, scoreMap, visited, stack);
        const ranked = rankComponent(component, width, height);
        if (ranked && (!best || ranked.rank > best.rank)) {
          best = ranked;
        }
      }
    }

    if (!best) {
      return null;
    }

    updateAnalysisVelocity(best.x, best.y);
    return best;
  }

  function getTrackingRoi(width, height) {
    const last = state.lastAnalysisPoint;
    if (!last) {
      return { x0: 0, y0: 0, x1: width - 1, y1: height - 1, locked: false };
    }

    const speed = Math.hypot(state.velocityAnalysis.x, state.velocityAnalysis.y);
    const radius = Math.max(44, Math.min(130, 52 + speed * 10));
    return {
      x0: Math.max(0, Math.floor(last.x - radius)),
      y0: Math.max(0, Math.floor(last.y - radius)),
      x1: Math.min(width - 1, Math.ceil(last.x + radius)),
      y1: Math.min(height - 1, Math.ceil(last.y + radius)),
      locked: true
    };
  }

  function trackingThreshold(x, y, roi, colorScore, darkScore, motionScore) {
    const mode = ui.trackerSelect.value;
    let threshold = roi.locked ? 0.25 : 0.38;

    if (mode === "color") {
      threshold += colorScore > 0.35 ? -0.08 : 0.24;
    } else if (mode === "dark") {
      threshold += darkScore > 0.28 || motionScore > 0.3 ? -0.05 : 0.18;
    } else if (colorScore > 0.38 || motionScore > 0.45) {
      threshold -= 0.06;
    }

    if (roi.locked) {
      const cx = (roi.x0 + roi.x1) / 2;
      const cy = (roi.y0 + roi.y1) / 2;
      const distance = Math.hypot(x - cx, y - cy);
      const maxDistance = Math.max(1, Math.hypot(roi.x1 - cx, roi.y1 - cy));
      threshold -= (1 - distance / maxDistance) * 0.05;
    }

    return threshold;
  }

  function combineScores(colorScore, darkScore, motionScore, backgroundScore) {
    const mode = ui.trackerSelect.value;
    const motionBoost = motionScore * 0.22 + backgroundScore * 0.18;

    if (mode === "color") {
      return colorScore * 1.18 + motionBoost * 0.55;
    }

    if (mode === "dark") {
      return darkScore * 1.18 + motionBoost;
    }

    return Math.max(colorScore * 1.12, darkScore) + motionBoost;
  }

  function collectComponent(startPixel, width, height, roi, scoreMap, visited, stack) {
    let stackSize = 0;
    let area = 0;
    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    let strongest = 0;
    let bestPixel = startPixel;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const pixels = [];

    stack[stackSize] = startPixel;
    stackSize += 1;
    visited[startPixel] = 1;

    while (stackSize > 0) {
      stackSize -= 1;
      const pixel = stack[stackSize];
      const score = scoreMap[pixel];
      const x = pixel % width;
      const y = Math.floor(pixel / width);

      area += 1;
      weight += score;
      sumX += x * score;
      sumY += y * score;
      pixels.push(pixel);

      if (score > strongest) {
        strongest = score;
        bestPixel = pixel;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      pushNeighbor(pixel - 1, x > roi.x0);
      pushNeighbor(pixel + 1, x < roi.x1);
      pushNeighbor(pixel - width, y > roi.y0);
      pushNeighbor(pixel + width, y < roi.y1);
    }

    function pushNeighbor(nextPixel, allowed) {
      if (!allowed || visited[nextPixel] || scoreMap[nextPixel] === 0) {
        return;
      }
      visited[nextPixel] = 1;
      stack[stackSize] = nextPixel;
      stackSize += 1;
    }

    return {
      area,
      weight,
      cx: sumX / Math.max(0.001, weight),
      cy: sumY / Math.max(0.001, weight),
      strongest,
      bestPixel,
      minX,
      minY,
      maxX,
      maxY,
      pixels,
      scoreMap
    };
  }

  function rankComponent(component, width, height) {
    if (component.area < 3 || component.area > 1900 || component.weight < 2.8) {
      return null;
    }

    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const boxArea = boxWidth * boxHeight;
    const density = component.area / Math.max(1, boxArea);
    const compactness = Math.min(1, component.weight / Math.max(1, component.area * 0.55));
    const sizePenalty = component.area > 600 ? (component.area - 600) / 1500 : 0;
    let lockScore = 0;

    if (state.lastAnalysisPoint) {
      const distance = Math.hypot(component.cx - state.lastAnalysisPoint.x, component.cy - state.lastAnalysisPoint.y);
      lockScore = Math.max(0, 1 - distance / 115);
    }

    const tip = chooseComponentTip(component, width);
    const confidence = Math.max(0, Math.min(1, component.strongest * 0.65 + compactness * 0.22 + lockScore * 0.2));
    const rank = confidence + lockScore * 0.55 + density * 0.16 - sizePenalty;

    if (rank < 0.34) {
      return null;
    }

    return {
      x: tip.x,
      y: tip.y,
      confidence,
      rank,
      area: component.area
    };
  }

  function chooseComponentTip(component, width) {
    const speed = Math.hypot(state.velocityAnalysis.x, state.velocityAnalysis.y);
    const bestX = component.bestPixel % width;
    const bestY = Math.floor(component.bestPixel / width);

    if (speed < 0.35 || component.pixels.length < 8) {
      return {
        x: component.cx * 0.68 + bestX * 0.32,
        y: component.cy * 0.68 + bestY * 0.32
      };
    }

    const vx = state.velocityAnalysis.x / speed;
    const vy = state.velocityAnalysis.y / speed;
    let tipPixel = component.bestPixel;
    let tipRank = -Infinity;

    for (let index = 0; index < component.pixels.length; index += 1) {
      const pixel = component.pixels[index];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const lead = (x - component.cx) * vx + (y - component.cy) * vy;
      const score = lead + component.scoreMap[pixel] * 9;
      if (score > tipRank) {
        tipRank = score;
        tipPixel = pixel;
      }
    }

    const tipX = tipPixel % width;
    const tipY = Math.floor(tipPixel / width);
    return {
      x: component.cx * 0.25 + tipX * 0.75,
      y: component.cy * 0.25 + tipY * 0.75
    };
  }

  function updateAnalysisVelocity(x, y) {
    if (state.lastAnalysisPoint) {
      state.velocityAnalysis = {
        x: state.velocityAnalysis.x * 0.55 + (x - state.lastAnalysisPoint.x) * 0.45,
        y: state.velocityAnalysis.y * 0.55 + (y - state.lastAnalysisPoint.y) * 0.45
      };
    }

    state.lastAnalysisPoint = { x, y };
  }

  function rememberFrame(frame) {
    const data = frame.data;
    const totalPixels = frame.width * frame.height;

    if (!state.backgroundLuma || state.backgroundLuma.length !== totalPixels) {
      state.backgroundLuma = new Float32Array(totalPixels);
      for (let pixel = 0; pixel < totalPixels; pixel += 1) {
        const index = pixel * 4;
        state.backgroundLuma[pixel] = luminance(data[index], data[index + 1], data[index + 2]);
      }
    } else {
      for (let pixel = 0; pixel < totalPixels; pixel += 1) {
        const index = pixel * 4;
        const current = luminance(data[index], data[index + 1], data[index + 2]);
        state.backgroundLuma[pixel] = state.backgroundLuma[pixel] * 0.965 + current * 0.035;
      }
    }

    if (!state.previousFrame || state.previousFrame.length !== data.length) {
      state.previousFrame = new Uint8ClampedArray(data.length);
    }
    state.previousFrame.set(data);
  }

  function resetTrackerMemory() {
    state.previousFrame = null;
    state.backgroundLuma = null;
    state.lastAnalysisPoint = null;
    state.velocityAnalysis = { x: 0, y: 0 };
  }

  function vividMarkerScore(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = (max - min) / Math.max(1, max);
    const brightness = max / 255;
    const blueBias = Math.max(0, b - Math.max(r, g)) / 255;
    const redBias = Math.max(0, r - Math.max(g, b)) / 255;
    const greenBias = Math.max(0, g - Math.max(r, b)) / 255;
    return Math.max(blueBias, redBias, greenBias) * 0.72 + saturation * brightness * 0.45;
  }

  function colorPenScore(r, g, b) {
    if (state.calibration) {
      return calibratedScore(r, g, b, state.calibration);
    }

    return vividMarkerScore(r, g, b);
  }

  function darkPenScore(r, g, b, motionScore, backgroundScore) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const darkness = 1 - max / 255;
    const lowSaturation = 1 - (max - min) / Math.max(1, max);
    const movementGate = Math.max(motionScore, backgroundScore);
    const baseline = ui.trackerSelect.value === "dark" ? 0.08 : 0.015;
    return Math.pow(Math.max(0, darkness), 1.8) * (0.25 + lowSaturation * 0.35) * (baseline + movementGate * 1.6);
  }

  function calibratedScore(r, g, b, target) {
    const distance = Math.hypot(r - target.r, g - target.g, b - target.b);
    const similarity = 1 - Math.min(1, distance / 185);
    return similarity * vividMarkerScore(r, g, b) * 1.75;
  }

  function pixelMotionScore(current, previous, index) {
    const diff =
      Math.abs(current[index] - previous[index]) +
      Math.abs(current[index + 1] - previous[index + 1]) +
      Math.abs(current[index + 2] - previous[index + 2]);
    return Math.min(1, diff / 135);
  }

  function luminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function smoothPoint(point) {
    if (!ui.stabilizeToggle.checked || !state.lastPoint) {
      state.lastPoint = point;
      return point;
    }

    const alpha = 1 - state.smoothing;
    const smoothed = {
      x: state.lastPoint.x + (point.x - state.lastPoint.x) * alpha,
      y: state.lastPoint.y + (point.y - state.lastPoint.y) * alpha,
      confidence: point.confidence
    };

    state.lastPoint = smoothed;
    return smoothed;
  }

  function drawInk(point) {
    if (!point || !ui.autoWriteToggle.checked) {
      return;
    }

    if (!state.penTarget) {
      if (!state.activeStroke) {
        snapshotInk();
        state.activeStroke = true;
      }
      state.penTarget = point;
      return;
    }

    const distance = Math.hypot(point.x - state.penTarget.x, point.y - state.penTarget.y);
    if (distance > state.width * 0.24) {
      snapshotInk();
      state.activeStroke = true;
      state.penTarget = point;
      return;
    }

    inkCtx.save();
    inkCtx.lineCap = "round";
    inkCtx.lineJoin = "round";
    inkCtx.lineWidth = state.eraseMode ? state.thickness * 3.2 : state.thickness;
    inkCtx.globalCompositeOperation = state.eraseMode ? "destination-out" : "source-over";
    inkCtx.strokeStyle = state.inkColor;
    inkCtx.beginPath();
    inkCtx.moveTo(state.penTarget.x, state.penTarget.y);
    inkCtx.quadraticCurveTo(
      state.penTarget.x,
      state.penTarget.y,
      (state.penTarget.x + point.x) / 2,
      (state.penTarget.y + point.y) / 2
    );
    inkCtx.stroke();
    inkCtx.restore();
    state.penTarget = point;
  }

  function snapshotInk() {
    if (state.snapshots.length > 20) {
      state.snapshots.shift();
    }
    state.snapshots.push(inkCtx.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
  }

  function clearBoard() {
    snapshotInk();
    inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  }

  function undo() {
    const previous = state.snapshots.pop();
    if (!previous) {
      return;
    }
    inkCtx.putImageData(previous, 0, 0);
  }

  function saveBoard() {
    drawBoardBackground();
    const link = document.createElement("a");
    link.download = `ai-whiteboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    link.href = outputCanvas.toDataURL("image/png");
    link.click();
  }

  function calibratePen() {
    if (!state.running) {
      setStatus("Start camera before calibration");
      return;
    }

    const centerX = Math.floor(state.analysisWidth / 2);
    const centerY = Math.floor(state.analysisHeight / 2);
    analysisCtx.drawImage(video, 0, 0, state.analysisWidth, state.analysisHeight);
    const sample = analysisCtx.getImageData(centerX - 8, centerY - 8, 16, 16).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = sample.length / 4;

    for (let index = 0; index < sample.length; index += 4) {
      r += sample[index];
      g += sample[index + 1];
      b += sample[index + 2];
    }

    state.calibration = {
      r: r / pixels,
      g: g / pixels,
      b: b / pixels
    };
    setStatus("Pen color calibrated");
  }

  function updateFps(now) {
    state.frameCount += 1;
    const elapsed = now - state.fpsStartedAt;
    if (elapsed >= 700) {
      ui.fpsValue.textContent = Math.round((state.frameCount / elapsed) * 1000);
      state.frameCount = 0;
      state.fpsStartedAt = now;
    }
  }

  function loop(now) {
    if (!state.running) {
      return;
    }

    resizeCanvases();
    const point = detectPen(now);
    drawInk(point);
    drawBoardBackground();
    updateFps(now);

    if (!point) {
      state.penTarget = null;
      state.lastPoint = null;
      state.activeStroke = false;
    }

    requestAnimationFrame(loop);
  }

  function bindUi() {
    ui.cameraToggle.addEventListener("click", () => {
      if (state.running) {
        stopCamera();
      } else {
        startCamera();
      }
    });

    ui.calibrateBtn.addEventListener("click", calibratePen);
    ui.clearBtn.addEventListener("click", clearBoard);
    ui.undoBtn.addEventListener("click", undo);
    ui.saveBtn.addEventListener("click", saveBoard);

    ui.eraseBtn.addEventListener("click", () => {
      state.eraseMode = !state.eraseMode;
      ui.eraseBtn.classList.toggle("active", state.eraseMode);
      ui.eraseBtn.textContent = state.eraseMode ? "Drawing mode" : "Erase mode";
    });

    ui.thicknessRange.addEventListener("input", () => {
      state.thickness = Number(ui.thicknessRange.value);
      ui.thicknessValue.textContent = String(state.thickness);
    });

    ui.smoothingRange.addEventListener("input", () => {
      const value = Number(ui.smoothingRange.value);
      state.smoothing = value / 100;
      ui.smoothingValue.textContent = String(value);
    });

    document.querySelectorAll(".swatch").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".swatch").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        state.inkColor = button.dataset.color;
        state.eraseMode = false;
        ui.eraseBtn.classList.remove("active");
        ui.eraseBtn.textContent = "Erase mode";
      });
    });

    window.addEventListener("beforeunload", stopCamera);
  }

  bindUi();
  drawBoardBackground();
})();
