# AI Powered Whiteboard

A low-latency computer-vision whiteboard that uses the system camera to turn a colored pen or marker into live digital writing. The app runs fully in the browser: camera frames are processed locally, pen motion is stabilized, and ink is drawn directly onto a canvas.

## Features

- System camera access through `getUserMedia`
- Real-time marker detection from saturated colored pixels
- AI-style smoothing, gap bridging, and jitter reduction for live writing
- Clean whiteboard, camera board, and transparent overlay modes
- Ink colors, thickness, eraser, undo, clear, grid, mirror, and PNG export
- Local static server so camera permissions work reliably on `localhost`
- No external runtime dependencies

## Quick Start

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Then click `Start camera`. Use a bright red, blue, or green pen cap/marker tip for the strongest detection. For best results, keep the pen tip visible, write against a bright wall or board, and keep the camera fixed.

## Calibration

The detector works without calibration by looking for vivid marker colors. For better tracking:

1. Start the camera.
2. Hold the pen tip in the center of the camera view.
3. Click `Calibrate pen`.

The app samples the center pixels and biases the detector toward that pen color.

## Verification

```bash
npm run check
```

This checks the Node server and browser application JavaScript syntax.

## Project Structure

```text
.
├── AGENTS.md
├── README.md
├── index.html
├── package.json
├── server.js
├── src/
│   └── app.js
└── styles.css
```

## How It Works

The app draws camera frames into a small analysis canvas, scores pixels by saturation and color dominance, finds the weighted marker centroid, smooths the point, bridges short tracking drops, and draws the result onto a persistent ink canvas. The final visible canvas combines the selected board background, optional grid, and ink layer.

The processing is intentionally client-side and dependency-free to keep latency low. The whiteboard output should feel like a live board rather than a delayed CV demo.
