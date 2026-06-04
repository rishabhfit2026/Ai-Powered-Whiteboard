# AI Powered Whiteboard

A low-latency computer-vision whiteboard that uses the system camera to track a pen in your hand and reflect whatever you write onto a digital board.

The main implementation is now a standalone Python/OpenCV app in `cv_whiteboard.py`. The browser version is still included as an optional local UI demo.

## Features

- Standalone OpenCV camera app for real pen tracking
- Pen-tip detection while the pen is held in the hand
- Hand/skin suppression so the tracker prefers the pen instead of fingers
- Color calibration from the camera center
- Motion and background-change cues for dark pens
- Contour/component scoring with Kalman smoothing
- Live digital board window, undo, erase, clear, save, and mask preview
- System camera access through `getUserMedia`
- Real-time pen detection with color, motion, dark-pen, and background-change cues
- Connected-component blob tracking that locks onto the pen and selects the writing tip
- AI-style smoothing, ROI relock, gap bridging, and jitter reduction for live writing
- Clean whiteboard, camera board, and transparent overlay modes
- Smart hybrid, color-pen, and dark-pen tracking modes
- Ink colors, thickness, eraser, undo, clear, grid, mirror, and PNG export
- Local static server so camera permissions work reliably on `localhost`
- No external runtime dependencies

## Run The Computer Vision App

```bash
python3 cv_whiteboard.py
```

Hold your pen tip in the cyan square at the center of the camera window and press `c` to calibrate. After that, write in front of the camera. The tracked pen-tip path appears in the `Digital Board` window.

### OpenCV Controls

```text
c       calibrate pen color from center square
space   toggle drawing on/off
e       toggle eraser
u       undo last stroke
x       clear board
m       show/hide pen mask preview
s       save board PNG
q/esc   quit
```

For strongest tracking, use a red, blue, green, or otherwise visually distinct pen tip/cap. Black pens can still work when moving because the tracker uses motion and background-change cues, but color calibration is more stable.

## Run The Browser Demo

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Then click `Start camera`. `Smart hybrid` mode works best for most demos. Use a bright red, blue, or green pen cap/marker tip for the strongest detection. If your pen is black, switch `Pen tracking` to `Dark pen` and keep the pen moving in front of the camera. For best results, keep the pen tip visible, write against a bright wall or board, and keep the camera fixed.

## Calibration

The detector works without calibration by looking for vivid marker colors. For better tracking:

1. Start the camera.
2. Hold the pen tip in the center of the camera view.
3. Click `Calibrate pen`.

The app samples the center pixels and biases the detector toward that pen color.

## Verification

```bash
python3 -m py_compile cv_whiteboard.py
npm run check
```

This checks the standalone OpenCV app and browser application syntax.

## Project Structure

```text
.
├── AGENTS.md
├── README.md
├── cv_whiteboard.py
├── index.html
├── package.json
├── requirements.txt
├── server.js
├── src/
│   └── app.js
└── styles.css
```

## How The OpenCV App Works

The OpenCV app reads frames from the webcam, mirrors the image for natural writing, and builds several masks:

- skin mask from HSV and YCrCb to suppress the hand
- calibrated/vivid color mask for colored pens
- motion foreground mask from background subtraction
- dark-pen mask gated by motion

It combines those masks, extracts contours, filters by size and shape, and scores each candidate using saturation, motion, elongated shape, continuity, and distance away from skin. The chosen contour is reduced to a probable pen tip, then passed through a Kalman filter. The smoothed tip is drawn onto an RGBA ink layer and composited onto the board.

## How The Browser Demo Works

The app draws camera frames into a small analysis canvas, scores pixels by calibrated color, vivid color, dark-pen motion, and background change, then groups candidate pixels into connected components. Each component is ranked by confidence, size, density, and proximity to the current tracker lock. The selected component is reduced to a likely writing tip using motion direction and strongest-pixel evidence, then smoothed and drawn onto a persistent ink canvas.

The processing is intentionally client-side and dependency-free to keep latency low. The whiteboard output should feel like a live board rather than a delayed CV demo.
