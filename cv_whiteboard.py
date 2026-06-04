#!/usr/bin/env python3
"""OpenCV pen-tracking whiteboard.

This is a standalone computer-vision app. It opens the system camera, tracks the
tip of a pen held in the hand, and draws the live trajectory onto a digital
whiteboard window.
"""

from __future__ import annotations

import argparse
import math
import time
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

import cv2
import numpy as np


Point = Tuple[int, int]


@dataclass
class TrackerConfig:
    camera_index: int = 0
    width: int = 1280
    height: int = 720
    mirror: bool = True
    ink_thickness: int = 6
    eraser_thickness: int = 38
    min_area: int = 18
    max_area: int = 9000
    bridge_seconds: float = 0.12
    jump_ratio: float = 0.28


@dataclass
class Candidate:
    tip: Point
    center: Tuple[float, float]
    contour: np.ndarray
    score: float
    area: float
    box: Tuple[int, int, int, int]


class PenWhiteboard:
    def __init__(self, config: TrackerConfig) -> None:
        self.config = config
        self.cap = cv2.VideoCapture(config.camera_index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.height)
        self.cap.set(cv2.CAP_PROP_FPS, 60)

        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open camera index {config.camera_index}")

        ok, frame = self.cap.read()
        if not ok:
            raise RuntimeError("Camera opened but did not return frames")

        if config.mirror:
            frame = cv2.flip(frame, 1)

        self.height, self.width = frame.shape[:2]
        self.board = np.full((self.height, self.width, 3), 255, dtype=np.uint8)
        self.ink_layer = np.zeros((self.height, self.width, 4), dtype=np.uint8)
        self.snapshots: list[np.ndarray] = []
        self.hsv_range: Optional[Tuple[np.ndarray, np.ndarray]] = None
        self.last_tip: Optional[Point] = None
        self.last_seen = 0.0
        self.drawing = True
        self.erase_mode = False
        self.show_masks = False
        self.ink_color = (20, 20, 20, 255)
        self.background = cv2.createBackgroundSubtractorMOG2(
            history=220,
            varThreshold=24,
            detectShadows=False,
        )
        self.kalman = self._create_kalman()
        self.kalman_ready = False

    def _create_kalman(self) -> cv2.KalmanFilter:
        kalman = cv2.KalmanFilter(4, 2)
        kalman.transitionMatrix = np.array(
            [[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]],
            dtype=np.float32,
        )
        kalman.measurementMatrix = np.array(
            [[1, 0, 0, 0], [0, 1, 0, 0]],
            dtype=np.float32,
        )
        kalman.processNoiseCov = np.eye(4, dtype=np.float32) * 0.035
        kalman.measurementNoiseCov = np.eye(2, dtype=np.float32) * 2.2
        kalman.errorCovPost = np.eye(4, dtype=np.float32)
        return kalman

    def run(self) -> None:
        cv2.namedWindow("Camera Tracker", cv2.WINDOW_NORMAL)
        cv2.namedWindow("Digital Board", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Camera Tracker", 960, 540)
        cv2.resizeWindow("Digital Board", 960, 540)

        while True:
            ok, frame = self.cap.read()
            if not ok:
                break

            if self.config.mirror:
                frame = cv2.flip(frame, 1)

            now = time.monotonic()
            candidate, debug = self.detect_pen(frame)
            tip = self.update_tracker(candidate, now)

            if tip is not None:
                self.draw_tip(frame, tip)
                self.write_to_board(tip, now)
            else:
                self.last_tip = None

            camera_view = self.compose_camera_view(frame, debug, tip)
            board_view = self.compose_board()

            cv2.imshow("Camera Tracker", camera_view)
            cv2.imshow("Digital Board", board_view)

            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                break
            self.handle_key(key, frame)

        self.cap.release()
        cv2.destroyAllWindows()

    def detect_pen(self, frame: np.ndarray) -> Tuple[Optional[Candidate], dict[str, np.ndarray]]:
        blurred = cv2.GaussianBlur(frame, (5, 5), 0)
        hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
        ycrcb = cv2.cvtColor(blurred, cv2.COLOR_BGR2YCrCb)

        skin_mask = self.make_skin_mask(hsv, ycrcb)
        color_mask = self.make_color_mask(hsv)
        motion_mask = self.make_motion_mask(frame)
        dark_mask = self.make_dark_pen_mask(hsv, motion_mask)

        pen_mask = cv2.bitwise_or(color_mask, dark_mask)
        pen_mask = cv2.bitwise_and(pen_mask, cv2.bitwise_not(skin_mask))
        pen_mask = cv2.morphologyEx(pen_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        pen_mask = cv2.morphologyEx(pen_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

        contours, _ = cv2.findContours(pen_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = [
            self.score_contour(contour, hsv, skin_mask, motion_mask)
            for contour in contours
        ]
        candidates = [candidate for candidate in candidates if candidate is not None]

        best = max(candidates, key=lambda item: item.score, default=None)
        debug = {
            "pen_mask": pen_mask,
            "skin_mask": skin_mask,
            "motion_mask": motion_mask,
        }
        return best, debug

    def make_skin_mask(self, hsv: np.ndarray, ycrcb: np.ndarray) -> np.ndarray:
        hsv_skin = cv2.inRange(hsv, np.array([0, 20, 45]), np.array([35, 255, 255]))
        ycrcb_skin = cv2.inRange(ycrcb, np.array([0, 133, 77]), np.array([255, 173, 127]))
        skin = cv2.bitwise_and(hsv_skin, ycrcb_skin)
        skin = cv2.medianBlur(skin, 5)
        skin = cv2.dilate(skin, np.ones((5, 5), np.uint8), iterations=1)
        return skin

    def make_color_mask(self, hsv: np.ndarray) -> np.ndarray:
        if self.hsv_range is not None:
            low, high = self.hsv_range
            if low[0] <= high[0]:
                return cv2.inRange(hsv, low, high)
            low_a = np.array([0, low[1], low[2]], dtype=np.uint8)
            high_a = high.copy()
            low_b = low.copy()
            high_b = np.array([179, high[1], high[2]], dtype=np.uint8)
            return cv2.bitwise_or(cv2.inRange(hsv, low_a, high_a), cv2.inRange(hsv, low_b, high_b))

        saturated = cv2.inRange(hsv, np.array([0, 85, 70]), np.array([179, 255, 255]))
        red_a = cv2.inRange(hsv, np.array([0, 75, 70]), np.array([12, 255, 255]))
        red_b = cv2.inRange(hsv, np.array([165, 75, 70]), np.array([179, 255, 255]))
        blue = cv2.inRange(hsv, np.array([88, 70, 55]), np.array([135, 255, 255]))
        green = cv2.inRange(hsv, np.array([36, 70, 55]), np.array([88, 255, 255]))
        vivid = cv2.bitwise_or(cv2.bitwise_or(red_a, red_b), cv2.bitwise_or(blue, green))
        return cv2.bitwise_or(saturated, vivid)

    def make_motion_mask(self, frame: np.ndarray) -> np.ndarray:
        foreground = self.background.apply(frame)
        foreground = cv2.threshold(foreground, 180, 255, cv2.THRESH_BINARY)[1]
        foreground = cv2.medianBlur(foreground, 5)
        return cv2.morphologyEx(foreground, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    def make_dark_pen_mask(self, hsv: np.ndarray, motion_mask: np.ndarray) -> np.ndarray:
        dark = cv2.inRange(hsv, np.array([0, 0, 0]), np.array([179, 95, 92]))
        return cv2.bitwise_and(dark, motion_mask)

    def score_contour(
        self,
        contour: np.ndarray,
        hsv: np.ndarray,
        skin_mask: np.ndarray,
        motion_mask: np.ndarray,
    ) -> Optional[Candidate]:
        area = cv2.contourArea(contour)
        if area < self.config.min_area or area > self.config.max_area:
            return None

        x, y, w, h = cv2.boundingRect(contour)
        if w <= 1 or h <= 1:
            return None

        aspect = max(w, h) / max(1, min(w, h))
        if area > 220 and aspect < 1.08:
            return None

        mask = np.zeros((self.height, self.width), dtype=np.uint8)
        cv2.drawContours(mask, [contour], -1, 255, -1)
        mean_hsv = cv2.mean(hsv, mask=mask)
        saturation_score = mean_hsv[1] / 255.0
        motion_score = cv2.countNonZero(cv2.bitwise_and(mask, motion_mask)) / max(1.0, area)
        density = area / max(1.0, w * h)
        tip = self.choose_tip(contour, mask, skin_mask)
        proximity = self.proximity_score(tip)

        score = (
            saturation_score * 1.35
            + min(1.0, motion_score) * 0.75
            + min(1.0, aspect / 5.0) * 0.45
            + proximity * 0.9
            + density * 0.2
        )

        return Candidate(
            tip=tip,
            center=(x + w / 2.0, y + h / 2.0),
            contour=contour,
            score=score,
            area=area,
            box=(x, y, w, h),
        )

    def choose_tip(self, contour: np.ndarray, mask: np.ndarray, skin_mask: np.ndarray) -> Point:
        points = contour.reshape(-1, 2)
        moments = cv2.moments(contour)
        if moments["m00"] > 0:
            center = np.array([moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]])
        else:
            center = points.mean(axis=0)

        skin_distance = cv2.distanceTransform(cv2.bitwise_not(skin_mask), cv2.DIST_L2, 5)
        component_distance = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
        velocity = self.current_velocity()
        velocity_norm = np.linalg.norm(velocity)
        best_point = points[0]
        best_score = -1e9

        for point in points:
            px, py = int(point[0]), int(point[1])
            away_from_hand = skin_distance[py, px]
            edge_strength = 1.0 / (1.0 + component_distance[py, px])
            elongated_tip = np.linalg.norm(point.astype(np.float32) - center)
            lead = 0.0
            if velocity_norm > 0.5:
                lead = float(np.dot(point.astype(np.float32) - center, velocity / velocity_norm))
            score = away_from_hand * 1.6 + edge_strength * 18.0 + elongated_tip * 0.45 + lead * 1.25
            if score > best_score:
                best_score = score
                best_point = point

        return int(best_point[0]), int(best_point[1])

    def proximity_score(self, tip: Point) -> float:
        if self.last_tip is None:
            return 0.0
        distance = math.hypot(tip[0] - self.last_tip[0], tip[1] - self.last_tip[1])
        return max(0.0, 1.0 - distance / 180.0)

    def current_velocity(self) -> np.ndarray:
        if not self.kalman_ready:
            return np.array([0.0, 0.0], dtype=np.float32)
        state = self.kalman.statePost.flatten()
        return np.array([state[2], state[3]], dtype=np.float32)

    def update_tracker(self, candidate: Optional[Candidate], now: float) -> Optional[Point]:
        prediction = self.kalman.predict()

        if candidate is None:
            if self.kalman_ready and now - self.last_seen <= self.config.bridge_seconds:
                return int(prediction[0, 0]), int(prediction[1, 0])
            self.kalman_ready = False
            return None

        measurement = np.array([[np.float32(candidate.tip[0])], [np.float32(candidate.tip[1])]])
        if not self.kalman_ready:
            self.kalman.statePost = np.array(
                [[measurement[0, 0]], [measurement[1, 0]], [0.0], [0.0]],
                dtype=np.float32,
            )
            self.kalman_ready = True
            corrected = self.kalman.statePost
        else:
            corrected = self.kalman.correct(measurement)

        self.last_seen = now
        return int(corrected[0, 0]), int(corrected[1, 0])

    def write_to_board(self, tip: Point, now: float) -> None:
        if not self.drawing:
            self.last_tip = tip
            return

        if self.last_tip is None:
            self.snapshot()
            self.last_tip = tip
            return

        jump_limit = self.width * self.config.jump_ratio
        distance = math.hypot(tip[0] - self.last_tip[0], tip[1] - self.last_tip[1])
        if distance > jump_limit:
            self.snapshot()
            self.last_tip = tip
            return

        color = (0, 0, 0, 0) if self.erase_mode else self.ink_color
        thickness = self.config.eraser_thickness if self.erase_mode else self.config.ink_thickness

        if self.erase_mode:
            cv2.line(self.ink_layer, self.last_tip, tip, color, thickness, cv2.LINE_AA)
        else:
            cv2.line(self.ink_layer, self.last_tip, tip, color, thickness, cv2.LINE_AA)
        self.last_tip = tip

    def snapshot(self) -> None:
        self.snapshots.append(self.ink_layer.copy())
        if len(self.snapshots) > 24:
            self.snapshots.pop(0)

    def compose_board(self) -> np.ndarray:
        board = self.board.copy()
        alpha = self.ink_layer[:, :, 3:4].astype(np.float32) / 255.0
        ink_rgb = self.ink_layer[:, :, :3].astype(np.float32)
        board = (board.astype(np.float32) * (1 - alpha) + ink_rgb * alpha).astype(np.uint8)
        return board

    def compose_camera_view(
        self,
        frame: np.ndarray,
        debug: dict[str, np.ndarray],
        tip: Optional[Point],
    ) -> np.ndarray:
        view = frame.copy()
        if tip is not None:
            cv2.circle(view, tip, 9, (0, 255, 255), 2)
            cv2.circle(view, tip, 3, (0, 0, 255), -1)

        self.draw_hud(view)
        if self.show_masks:
            mask_preview = cv2.cvtColor(debug["pen_mask"], cv2.COLOR_GRAY2BGR)
            mask_preview = cv2.resize(mask_preview, (260, 150))
            view[12:162, self.width - 272:self.width - 12] = mask_preview
        return view

    def draw_tip(self, frame: np.ndarray, tip: Point) -> None:
        cv2.circle(frame, tip, 10, (0, 255, 255), 2)
        cv2.circle(frame, tip, 3, (0, 0, 255), -1)

    def draw_hud(self, view: np.ndarray) -> None:
        lines = [
            "q/esc: quit | c: calibrate pen at center | space: draw on/off",
            "e: erase | u: undo | x: clear | m: masks | s: save",
            f"mode: {'erase' if self.erase_mode else 'draw'} | drawing: {'on' if self.drawing else 'off'} | calibrated: {'yes' if self.hsv_range else 'auto'}",
        ]
        y = 28
        for line in lines:
            cv2.putText(view, line, (16, y), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 0), 4, cv2.LINE_AA)
            cv2.putText(view, line, (16, y), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)
            y += 26

        cx, cy = self.width // 2, self.height // 2
        cv2.rectangle(view, (cx - 22, cy - 22), (cx + 22, cy + 22), (255, 255, 0), 2)

    def handle_key(self, key: int, frame: np.ndarray) -> None:
        if key == ord(" "):
            self.drawing = not self.drawing
            self.last_tip = None
        elif key == ord("e"):
            self.erase_mode = not self.erase_mode
            self.last_tip = None
        elif key == ord("u") and self.snapshots:
            self.ink_layer = self.snapshots.pop()
            self.last_tip = None
        elif key == ord("x"):
            self.snapshot()
            self.ink_layer[:] = 0
            self.last_tip = None
        elif key == ord("m"):
            self.show_masks = not self.show_masks
        elif key == ord("s"):
            filename = f"opencv-whiteboard-{int(time.time())}.png"
            cv2.imwrite(filename, self.compose_board())
            print(f"Saved {filename}")
        elif key == ord("c"):
            self.calibrate_from_center(frame)

    def calibrate_from_center(self, frame: np.ndarray) -> None:
        cx, cy = self.width // 2, self.height // 2
        roi = frame[cy - 22:cy + 22, cx - 22:cx + 22]
        hsv_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV).reshape(-1, 3)
        median = np.median(hsv_roi, axis=0).astype(np.int16)
        hue, saturation, value = int(median[0]), int(median[1]), int(median[2])
        hue_margin = 14
        sat_margin = 70
        val_margin = 80
        low = np.array(
            [
                (hue - hue_margin) % 180,
                max(35, saturation - sat_margin),
                max(25, value - val_margin),
            ],
            dtype=np.uint8,
        )
        high = np.array(
            [
                (hue + hue_margin) % 180,
                min(255, saturation + sat_margin),
                min(255, value + val_margin),
            ],
            dtype=np.uint8,
        )
        self.hsv_range = (low, high)
        print(f"Calibrated HSV low={low.tolist()} high={high.tolist()}")


def parse_args(argv: Optional[Sequence[str]] = None) -> TrackerConfig:
    parser = argparse.ArgumentParser(description="OpenCV pen-tracking AI whiteboard")
    parser.add_argument("--camera", type=int, default=0, help="camera index")
    parser.add_argument("--width", type=int, default=1280, help="requested camera width")
    parser.add_argument("--height", type=int, default=720, help="requested camera height")
    parser.add_argument("--no-mirror", action="store_true", help="disable mirrored selfie view")
    parser.add_argument("--thickness", type=int, default=6, help="ink thickness")
    args = parser.parse_args(argv)
    return TrackerConfig(
        camera_index=args.camera,
        width=args.width,
        height=args.height,
        mirror=not args.no_mirror,
        ink_thickness=args.thickness,
    )


def main() -> None:
    app = PenWhiteboard(parse_args())
    app.run()


if __name__ == "__main__":
    main()
