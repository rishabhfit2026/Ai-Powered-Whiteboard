# AGENTS.md

## Mission

Build and maintain an AI-powered computer-vision whiteboard that feels live, clean, and practical. The main goal is a camera-based app where a person can write with a visible pen or marker and see the writing appear immediately on a digital whiteboard.

## Product Intent

- The board must feel like a real digital board, not a slow computer-vision experiment.
- Camera access should be simple and local-first.
- Writing latency is the highest-priority UX constraint.
- The visual output should be clean enough for demos, teaching, and presentation.
- Controls should match what users expect from a digital board: color, thickness, eraser, undo, clear, grid, mirror, mode, and export.

## Engineering Principles

- Prefer fast browser-native APIs before adding dependencies.
- Keep the CV loop inside `requestAnimationFrame`.
- Use a downscaled analysis canvas for detection and a full-resolution canvas for output.
- Avoid blocking work in the frame loop.
- Keep DOM updates small and infrequent.
- Preserve camera privacy: process frames locally and do not transmit video.
- Keep files readable and focused.

## Current Architecture

- `server.js` serves the app on localhost.
- `index.html` defines the whiteboard UI and canvases.
- `styles.css` owns layout and visual design.
- `src/app.js` owns camera access, marker detection, smoothing, ink drawing, and board composition.

## CV Pipeline

1. Request the system camera using `navigator.mediaDevices.getUserMedia`.
2. Draw each frame into a small analysis canvas.
3. Score pixels using color saturation, color dominance, and optional calibration.
4. Compute the weighted centroid of likely marker pixels.
5. Smooth the point with an exponential filter.
6. Bridge very short tracking gaps to avoid broken strokes.
7. Draw ink onto a persistent canvas.
8. Composite the whiteboard background, grid, and ink into the output canvas.

## Development Priorities

- First priority: reduce perceived latency.
- Second priority: improve tracking stability.
- Third priority: improve board cleanliness and professional UI.
- Fourth priority: add advanced AI features such as OCR, shape cleanup, hand masking, and gesture commands.

## Implementation Notes

- Use bright colored pens or marker caps for marker tracking.
- Preserve dependency-free startup unless a library adds real value.
- If adding model-based hand or pen detection, load it asynchronously and keep the current color tracker as a fallback.
- If adding OCR or summarization, make it optional and do not send camera frames without explicit user action.
- Keep camera permissions scoped to localhost usage.

## Definition of Done

- `npm start` launches the local app.
- `npm run check` passes.
- Camera start/stop works in a modern browser.
- Writing, erasing, clearing, undo, grid, mirror, save, and calibration remain functional.
- README explains how to run and use the app.
