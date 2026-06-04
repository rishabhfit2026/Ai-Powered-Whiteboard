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
    analysisWidth: 320,
    analysisHeight: 180,
    inkColor: "#111827",
    thickness: 7,
    smoothing: 0.65,
    eraseMode: false,
    penTarget: null,
    lastPoint: null,
    activeStroke: false,
    lastSeenAt: 0,
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

    if (!candidate) {
      const bridgeWindow = now - state.lastSeenAt < 140;
      ui.penValue.textContent = bridgeWindow ? "Bridge" : "Lost";
      return bridgeWindow ? state.lastPoint : null;
    }

    const x = (candidate.x / state.analysisWidth) * state.width;
    const y = (candidate.y / state.analysisHeight) * state.height;
    const rawPoint = { x, y, confidence: candidate.confidence };
    const point = smoothPoint(rawPoint);

    state.lastSeenAt = now;
    ui.penValue.textContent = candidate.confidence > 0.72 ? "Locked" : "Tracking";
    return point;
  }

  function findMarkerCandidate(frame) {
    const data = frame.data;
    let totalWeight = 0;
    let totalX = 0;
    let totalY = 0;
    let strongest = 0;
    const calibration = state.calibration;

    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const index = (y * frame.width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const score = calibration ? calibratedScore(r, g, b, calibration) : vividMarkerScore(r, g, b);

        if (score > 0.42) {
          totalWeight += score;
          totalX += x * score;
          totalY += y * score;
          strongest = Math.max(strongest, score);
        }
      }
    }

    if (totalWeight < 10) {
      return null;
    }

    return {
      x: totalX / totalWeight,
      y: totalY / totalWeight,
      confidence: Math.min(1, strongest * Math.min(1, totalWeight / 180))
    };
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

  function calibratedScore(r, g, b, target) {
    const distance = Math.hypot(r - target.r, g - target.g, b - target.b);
    const similarity = 1 - Math.min(1, distance / 185);
    return similarity * vividMarkerScore(r, g, b) * 1.75;
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
