"""
QwenMultiangle Camera Node for ComfyUI
3D camera angle control node that outputs formatted prompt strings
for multi-angle image generation with Qwen-Image-Edit-2511-Multiple-Angles-LoRA
"""

import hashlib
import base64
import io
import logging
from collections import OrderedDict

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

_cache = OrderedDict()
_MAX_CACHE_SIZE = 50

AZIMUTH_RULES = [
    (337.5, "front view"),
    (22.5, "front view"),
    (67.5, "front-right quarter view"),
    (112.5, "right side view"),
    (157.5, "back-right quarter view"),
    (202.5, "back view"),
    (247.5, "back-left quarter view"),
    (292.5, "left side view"),
    (337.5, "front-left quarter view"),
]

ELEVATION_RULES = [
    (-15, "low-angle shot"),
    (15, "eye-level shot"),
    (45, "elevated shot"),
]

DISTANCE_RULES = [
    (2, "wide shot"),
    (6, "medium shot"),
]


def _resolve_direction(angle, rules, wrap360=False):
    if wrap360:
        angle = ((angle % 360) + 360) % 360
        for i, (bound, label) in enumerate(rules):
            if i == 0:
                if angle >= bound:
                    return label
            else:
                if angle < bound:
                    return label
        return rules[-1][1]
    for bound, label in reversed(rules):
        if angle < bound:
            continue
        return label
    return rules[0][1]


def generate_prompt(azimuth, elevation, distance):
    h_dir = _resolve_direction(azimuth, AZIMUTH_RULES, wrap360=True)
    v_dir = _resolve_direction(elevation, ELEVATION_RULES)
    dist = _resolve_direction(distance, DISTANCE_RULES)
    return f"<sks> {h_dir} {v_dir} {dist}"


PROMPT_RULES = {
    "azimuth": AZIMUTH_RULES,
    "elevation": ELEVATION_RULES,
    "distance": DISTANCE_RULES,
}


class QwenMultiangleCameraNode:
    """
    3D Camera Angle Control Node
    Provides a 3D scene to adjust camera angles and outputs a formatted prompt string.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "horizontal_angle": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 360,
                    "step": 1,
                    "display": "slider",
                }),
                "vertical_angle": ("INT", {
                    "default": 0,
                    "min": -30,
                    "max": 60,
                    "step": 1,
                    "display": "slider",
                }),
                "zoom": ("FLOAT", {
                    "default": 5.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider",
                }),
                "camera_view": ("BOOLEAN", {
                    "default": False,
                    "display": "checkbox",
                }),
            },
            "optional": {
                "image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "generate_prompt"
    CATEGORY = "❤️‍🩹炮哥Nodes/实用工具"
    OUTPUT_NODE = True

    @staticmethod
    def _to_numpy(image):
        if image is None:
            return None
        if hasattr(image, 'cpu'):
            img_tensor = image[0] if len(image.shape) == 4 else image
            return img_tensor.cpu().numpy()
        if hasattr(image, 'numpy'):
            img_np = image.numpy()
            if len(img_np.shape) == 4:
                img_np = img_np[0]
            return img_np
        if hasattr(image, 'shape') and len(image.shape) == 4:
            return image[0]
        return image

    @staticmethod
    def _compute_image_hash(image):
        """Compute a hash of the image tensor for cache key comparison."""
        if image is None:
            return None
        try:
            img_np = QwenMultiangleCameraNode._to_numpy(image)
            return hashlib.md5(img_np.tobytes()).hexdigest()
        except Exception:
            return str(hash(str(image)))

    def generate_prompt(self, horizontal_angle, vertical_angle, zoom,
                        camera_view=False, image=None, unique_id=None):
        # Validate input ranges
        horizontal_angle = max(0, min(360, int(horizontal_angle)))
        vertical_angle = max(-30, min(60, int(vertical_angle)))
        zoom = max(0.0, min(10.0, float(zoom)))

        # Check cache for unchanged inputs
        cache_key = str(unique_id) if unique_id else "default"
        image_hash = self._compute_image_hash(image)
        cached = _cache.get(cache_key, {})
        if (cached.get('horizontal_angle') == horizontal_angle
                and cached.get('vertical_angle') == vertical_angle
                and cached.get('zoom') == zoom
                and cached.get('image_hash') == image_hash):
            _cache.move_to_end(cache_key)
            return cached['result']

        h_angle = horizontal_angle % 360

        prompt = generate_prompt(h_angle, vertical_angle, zoom)

        # Convert image to base64 for frontend display
        image_base64 = ""
        if image is not None:
            try:
                img_np = self._to_numpy(image)

                img_np = (np.clip(img_np, 0, 1) * 255).astype(np.uint8)

                if img_np.ndim == 3:
                    if img_np.shape[0] in (1, 3, 4):
                        img_np = np.transpose(img_np, (1, 2, 0))
                    if img_np.shape[-1] == 1:
                        img_np = np.concatenate([img_np] * 3, axis=-1)
                    elif img_np.shape[-1] == 4:
                        img_np = img_np[..., :3]

                pil_image = Image.fromarray(img_np)
                buffer = io.BytesIO()
                pil_image.save(buffer, format="PNG")
                image_base64 = "data:image/png;base64," + base64.b64encode(
                    buffer.getvalue()
                ).decode("utf-8")
            except Exception:
                logger.warning("Failed to convert image to base64", exc_info=True)

        result = {
            "ui": {"image_base64": [image_base64]},
            "result": (prompt,),
        }

        # Cache the result
        _cache[cache_key] = {
            'horizontal_angle': horizontal_angle,
            'vertical_angle': vertical_angle,
            'zoom': zoom,
            'image_hash': image_hash,
            'result': result,
        }
        _cache.move_to_end(cache_key)

        # Limit cache size
        if len(_cache) > _MAX_CACHE_SIZE:
            _cache.popitem(last=False)

        return result

    @classmethod
    def IS_CHANGED(cls, horizontal_angle, vertical_angle, zoom,
                   camera_view=False, image=None, unique_id=None):
        try:
            img_hash = ""
            if image is not None:
                img_np = cls._to_numpy(image)
                img_hash = hashlib.md5(img_np.tobytes()).hexdigest()
            return f"{horizontal_angle}_{vertical_angle}_{zoom}_{img_hash}"
        except Exception:
            return f"{horizontal_angle}_{vertical_angle}_{zoom}"


NODE_CLASS_MAPPINGS = {
    "BrotherPao_QwenMultiangleCamera": QwenMultiangleCameraNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BrotherPao_QwenMultiangleCamera": "多角度相机控制",
}
