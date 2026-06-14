import hashlib
import json
import logging
import random

import numpy as np
import torch
from PIL import Image

from comfy_api.latest import io, ui
from comfy_api.latest._io import FolderType

logger = logging.getLogger(__name__)
RESAMPLE_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
_PREVIEW_CACHE_KEY: str | None = None
_PREVIEW_CACHE_VALUE: str | None = None

FRAMES_EDITOR_DESCRIPTION = (
    "在图像批次或视频帧批次上进行交互式标注。支持正向点、负向点和边界框，"
    "标注按 frame_index 独立保存，切换帧不会串帧。旧四个输出返回当前滑块所在帧的数据，"
    "frames_data 输出所有已标注帧的数据，便于多帧提示词工作流使用。"
)


def _tensor_to_pil_batch(images: torch.Tensor) -> list[Image.Image]:
    if not isinstance(images, torch.Tensor):
        raise ValueError(f"Expected torch.Tensor, got {type(images)}")

    images = images.detach().cpu()
    if images.dim() == 3:
        images = images.unsqueeze(0)
    elif images.dim() != 4:
        raise ValueError(f"Expected image tensor shape [B,H,W,C] or [H,W,C], got {tuple(images.shape)}")

    if images.max().item() <= 1.0:
        images = images * 255.0
    images = images.clamp(0, 255).byte()

    result = []
    for image in images:
        array = image.numpy()
        channels = array.shape[-1]
        if channels == 1:
            result.append(Image.fromarray(array[:, :, 0], mode="L"))
        elif channels == 3:
            result.append(Image.fromarray(array, mode="RGB"))
        elif channels == 4:
            result.append(Image.fromarray(array, mode="RGBA"))
        else:
            raise ValueError(f"Unsupported image channel count: {channels}")
    return result


def _pil_batch_to_tensor(images: list[Image.Image]) -> torch.Tensor:
    tensors = []
    for image in images:
        if image.mode != "RGB":
            image = image.convert("RGB")
        tensors.append(torch.from_numpy(np.array(image).astype(np.float32) / 255.0))
    return torch.stack(tensors)


class FramesEditor(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_FramesEditor",
            display_name="帧编辑器",
            category="❤️‍🩹炮哥Nodes/图像操作",
            description=FRAMES_EDITOR_DESCRIPTION,
            inputs=[
                io.Image.Input(
                    "images",
                    tooltip=(
                        "输入 IMAGE 批次。单张图像时显示单帧；视频帧批次时可用预览下方滑块切换帧，"
                        "每一帧的正向点、负向点和边界框都会按帧独立保存。"
                    ),
                ),
                io.String.Input(
                    "info",
                    default="",
                    multiline=False,
                    tooltip=(
                        "内部状态字段，由前端帧编辑器自动维护。内容包含 current_frame_index 和 frames 列表；"
                        "通常不要手动编辑。点击该单行控件或工具栏信息按钮可查看格式化后的完整标注内容。"
                    ),
                ),
                io.Float.Input(
                    "preview_rescale",
                    default=1.0,
                    min=0.05,
                    max=1.0,
                    step=0.05,
                    tooltip=(
                        "预览缩放比例。降低该值可减小前端预览图尺寸和临时文件体积；"
                        "所有输出坐标会按该比例自动换算回原始输入分辨率。"
                    ),
                ),
            ],
            outputs=[
                io.String.Output(
                    "positive_coords",
                    display_name="positive_coords",
                    tooltip=(
                        "当前滑块所在帧的正向点，JSON 字符串，格式为 [{\"x\": float, \"y\": float}, ...]。"
                        "坐标已换算到原始输入图像分辨率。没有正向点时输出 None。"
                    ),
                ),
                io.String.Output(
                    "negative_coords",
                    display_name="negative_coords",
                    tooltip=(
                        "当前滑块所在帧的负向点，JSON 字符串，格式为 [{\"x\": float, \"y\": float}, ...]。"
                        "坐标已换算到原始输入图像分辨率。没有负向点时输出 None。"
                    ),
                ),
                io.BBOX.Output(
                    "bboxes",
                    display_name="bboxes",
                    tooltip=(
                        "当前滑块所在帧的边界框列表，格式为 [[x1, y1, x2, y2], ...]。"
                        "前端绘制的 xywh 框会在这里转换为 xyxy，并换算到原始输入图像分辨率。没有边界框时输出 None。"
                    ),
                ),
                io.Int.Output(
                    "frame_index",
                    display_name="frame_index",
                    tooltip="当前滑块所在帧的索引，从 0 开始。旧接口输出均以该帧为准。",
                ),
                io.String.Output(
                    "frames_data",
                    display_name="frames_data",
                    tooltip=(
                        "所有已标注帧的 JSON 字符串，按 frame_index 升序排列。每项格式为 "
                        "{\"frame_index\": int, \"positive_coords\": [...], \"negative_coords\": [...], \"bbox\": [...]}，"
                        "用于需要多帧隔离标注的工作流。"
                    ),
                ),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, images, info="", preview_rescale=1.0) -> io.NodeOutput:
        global _PREVIEW_CACHE_KEY, _PREVIEW_CACHE_VALUE

        preview_rescale = max(0.05, min(1.0, float(preview_rescale)))
        needs_scaling = preview_rescale < 1.0
        scale_factor = 1.0 / preview_rescale if needs_scaling else 1.0
        payload = _load_info_payload(info)
        current_frame_index = _current_frame_index(payload)
        frames_data = _parse_frames_data(payload, scale_factor)
        current_frame = _find_frame(frames_data, current_frame_index)
        positive_coords = current_frame.get("positive_coords", [])
        negative_coords = current_frame.get("negative_coords", [])
        bboxes = current_frame.get("bbox", [])

        preview_images = images
        if needs_scaling:
            _, height, width, _ = images.shape
            new_width = max(1, int(width * preview_rescale))
            new_height = max(1, int(height * preview_rescale))
            pil_images = _tensor_to_pil_batch(images)
            resized = [image.resize((new_width, new_height), RESAMPLE_LANCZOS) for image in pil_images]
            preview_images = _pil_batch_to_tensor(resized)

        preview_key = f"{hashlib.md5(preview_images.detach().cpu().numpy().tobytes()).hexdigest()}_{preview_rescale}"
        if _PREVIEW_CACHE_KEY == preview_key and _PREVIEW_CACHE_VALUE:
            preview_str = _PREVIEW_CACHE_VALUE
            is_init = False
        else:
            preview = ui.ImageSaveHelper.save_images(
                preview_images,
                filename_prefix="ComfyUI_temp_" + "".join(random.choice("abcdefghijklmnopqrstupvxyz") for _ in range(5)),
                folder_type=FolderType.temp,
                cls=cls,
                compress_level=4,
            )
            preview_str = json.dumps(preview, ensure_ascii=False)
            _PREVIEW_CACHE_KEY = preview_key
            _PREVIEW_CACHE_VALUE = preview_str
            is_init = True

        return io.NodeOutput(
            json.dumps(positive_coords, ensure_ascii=False) if positive_coords else None,
            json.dumps(negative_coords, ensure_ascii=False) if negative_coords else None,
            bboxes if bboxes else None,
            current_frame_index,
            json.dumps(frames_data, ensure_ascii=False),
            ui={"preview": [{"preview_str": preview_str, "is_init": is_init}]},
        )


def _load_info_payload(info: str):
    if not info:
        return {}

    try:
        payload = json.loads(info)
    except json.JSONDecodeError:
        logger.warning("帧编辑器 info JSON 解析失败，忽略当前标注", exc_info=True)
        return {}

    return payload if isinstance(payload, dict) else {}


def _current_frame_index(payload: dict):
    try:
        return int(payload.get("current_frame_index", payload.get("frame_index", 0)) or 0)
    except (TypeError, ValueError):
        return 0


def _parse_frames_data(payload: dict, scale_factor: float):
    if not payload:
        return []

    raw_frames = payload.get("frames")
    if not isinstance(raw_frames, list):
        raw_frames = [_legacy_payload_to_frame(payload)]

    frames_data = []
    for raw_frame in raw_frames:
        frame = _normalize_frame(raw_frame, scale_factor)
        if frame is not None:
            frames_data.append(frame)

    frames_data.sort(key=lambda item: item["frame_index"])
    return frames_data


def _find_frame(frames_data: list[dict], frame_index: int):
    for frame in frames_data:
        if frame.get("frame_index") == frame_index:
            return frame
    return {"frame_index": frame_index, "positive_coords": [], "negative_coords": [], "bbox": []}


def _legacy_payload_to_frame(payload: dict):
    return {
        "frame_index": payload.get("frame_index", payload.get("current_frame_index", 0)),
        "positive_coords": payload.get("positive_coords", []),
        "negative_coords": payload.get("negative_coords", []),
        "bbox": payload.get("bbox", []),
    }


def _normalize_frame(raw_frame, scale_factor: float):
    if not isinstance(raw_frame, dict):
        return None

    try:
        frame_index = int(raw_frame.get("frame_index", 0) or 0)
    except (TypeError, ValueError):
        return None

    positive_coords = _scale_points(raw_frame.get("positive_coords"), scale_factor)
    negative_coords = _scale_points(raw_frame.get("negative_coords"), scale_factor)
    bboxes = _scale_bboxes(raw_frame.get("bbox"), scale_factor)

    if not positive_coords and not negative_coords and not bboxes:
        return None

    return {
        "frame_index": frame_index,
        "positive_coords": positive_coords,
        "negative_coords": negative_coords,
        "bbox": bboxes,
    }


def _scale_points(points, scale_factor: float):
    if not isinstance(points, list):
        return []

    scaled = []
    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            scaled.append({
                "x": float(point["x"]) * scale_factor,
                "y": float(point["y"]) * scale_factor,
            })
        except (KeyError, TypeError, ValueError):
            continue
    return scaled


def _scale_bboxes(boxes, scale_factor: float):
    if not isinstance(boxes, list):
        return []

    scaled = []
    for box in boxes:
        try:
            if isinstance(box, dict):
                x = float(box["x"]) * scale_factor
                y = float(box["y"]) * scale_factor
                w = float(box["w"]) * scale_factor
                h = float(box["h"]) * scale_factor
                x2 = x + w
                y2 = y + h
            elif isinstance(box, (list, tuple)) and len(box) == 4:
                x = float(box[0]) * scale_factor
                y = float(box[1]) * scale_factor
                x2 = float(box[2]) * scale_factor
                y2 = float(box[3]) * scale_factor
            else:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        if x2 <= x or y2 <= y:
            continue
        scaled.append([x, y, x2, y2])
    return scaled
