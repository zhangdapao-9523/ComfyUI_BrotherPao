import json
import logging
import math
import os
from fractions import Fraction

import av
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F

from comfy_api.latest import Input, InputImpl, Types, io

logger = logging.getLogger(__name__)

DEFAULT_DIVISOR = 16
DIVISOR_MIN = 4
DIVISOR_MAX = 128
DIMENSION_MIN = 320
DIMENSION_MAX = 4096
FPS_MIN = 8.0
FPS_MAX = 128.0
DEFAULT_PREVIEW_FRAMES = 1
MAX_PREVIEW_FRAMES = 1000
MIN_INTERNAL_FPS = 0.001

VISUAL_VIDEO_EDITOR_DESCRIPTION = (
    "导入视频并在节点内可视化裁剪、截取时间轴和设置输出帧率。"
    "宽高就是最终输出视频分辨率；蓝色拉框选择源视频区域，输出时缩放到该分辨率。"
)


def _video_files() -> list[str]:
    input_dir = folder_paths.get_input_directory()
    try:
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
    except OSError:
        logger.warning("[BrotherPao] Failed to list input videos", exc_info=True)
        return []
    return sorted(folder_paths.filter_files_content_types(files, ["video"]))


class VisualVideoEditor(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_VisualVideoEditor",
            display_name="可视化视频编辑",
            category="❤️‍🩹炮哥Nodes/视频操作",
            description=VISUAL_VIDEO_EDITOR_DESCRIPTION,
            search_aliases=["video editor", "visual video crop", "trim video", "import video"],
            inputs=[
                io.Combo.Input(
                    "file",
                    display_name="视频",
                    options=_video_files(),
                    upload=io.UploadType.video,
                    tooltip="从 ComfyUI input 目录选择或上传视频。",
                ),
                io.Int.Input(
                    "width",
                    display_name="输出宽度",
                    default=DIMENSION_MIN,
                    min=DIMENSION_MIN,
                    max=DIMENSION_MAX,
                    step=DEFAULT_DIVISOR,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出视频宽度，范围 320-4096；会按分辨率倍率对齐。",
                ),
                io.Int.Input(
                    "height",
                    display_name="输出高度",
                    default=DIMENSION_MIN,
                    min=DIMENSION_MIN,
                    max=DIMENSION_MAX,
                    step=DEFAULT_DIVISOR,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出视频高度，范围 320-4096；会按分辨率倍率对齐。",
                ),
                io.Int.Input(
                    "divisor",
                    display_name="分辨率倍率",
                    default=DEFAULT_DIVISOR,
                    min=DIVISOR_MIN,
                    max=DIVISOR_MAX,
                    step=1,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出宽高和拉框宽高都会按该倍率对齐，范围 4-128，默认 16。",
                ),
                io.Float.Input(
                    "fps",
                    display_name="输出帧率",
                    default=FPS_MIN,
                    min=FPS_MIN,
                    max=FPS_MAX,
                    step=0.01,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="输出视频帧率，范围 8-128；前端读取到源 fps 后会自动填入并限制到该范围。",
                ),
                io.Int.Input(
                    "preview_frames",
                    display_name="图像帧数",
                    optional=True,
                    default=DEFAULT_PREVIEW_FRAMES,
                    min=1,
                    max=MAX_PREVIEW_FRAMES,
                    step=1,
                    display_mode=io.NumberDisplay.slider,
                    advanced=True,
                    tooltip="images 输出返回前 N 帧图像，范围 1-1000，默认 1。",
                ),
                io.String.Input(
                    "state",
                    display_name="编辑状态",
                    optional=True,
                    default="",
                    multiline=False,
                    advanced=True,
                    tooltip="内部状态字段，由前端可视化视频编辑器自动维护，通常不要手动编辑。",
                ),
            ],
            outputs=[
                io.Video.Output("video", display_name="video", tooltip="按拉框裁剪并缩放到指定分辨率后的 VIDEO。"),
                io.Image.Output("images", display_name="images", tooltip="最终输出视频的前几帧预览 IMAGE 批次，不再输出完整视频帧以避免内存爆炸。"),
                io.Float.Output("fps", display_name="fps", tooltip="实际输出帧率。"),
                io.Int.Output("frame_count", display_name="frame_count", tooltip="实际输出帧数。"),
                io.String.Output("crop_info", display_name="crop_info", tooltip="实际裁剪、时间轴和源视频信息 JSON。"),
            ],
        )

    @classmethod
    def execute(cls, file, width=0, height=0, divisor=DEFAULT_DIVISOR, fps=0.0, preview_frames=DEFAULT_PREVIEW_FRAMES, state="") -> io.NodeOutput:
        if not file:
            raise ValueError("请选择或上传一个视频文件。")

        video_path = folder_paths.get_annotated_filepath(file)
        video = InputImpl.VideoFromFile(video_path)
        source_fps = _safe_float(video.get_frame_rate(), fallback=1.0)
        source_duration = _safe_float(video.get_duration(), fallback=0.0)
        source_width, source_height = video.get_dimensions()

        state_payload = _load_state(state)
        start_time, end_time = _resolve_timeline(state_payload, source_duration)
        duration = max(0.0, end_time - start_time)
        if duration <= 0:
            raise ValueError("视频截取范围无效。")

        divisor = _clamp_int(divisor or DEFAULT_DIVISOR, DIVISOR_MIN, DIVISOR_MAX)
        output_width, output_height = _resolve_output_size(width, height, source_width, source_height, divisor)
        output_fps = _clamp_float(fps or source_fps or FPS_MIN, FPS_MIN, FPS_MAX)
        source_crop = _resolve_source_crop(state_payload, source_width, source_height, output_width, output_height, divisor)
        frame_count = _output_frame_count(duration, output_fps)
        preview_frame_count = max(1, min(MAX_PREVIEW_FRAMES, int(preview_frames or DEFAULT_PREVIEW_FRAMES)))

        images = _load_preview_frames(
            video_path,
            start_time,
            duration,
            source_fps,
            output_fps,
            source_crop,
            output_width,
            output_height,
            preview_frame_count,
        )
        output_video = _StreamedEditedVideo(
            video_path,
            start_time,
            duration,
            source_fps,
            output_fps,
            source_crop,
            output_width,
            output_height,
        )
        crop_info = {
            "source": {
                "file": file,
                "width": source_width,
                "height": source_height,
                "fps": source_fps,
                "duration": source_duration,
            },
            "output": {
                "width": output_width,
                "height": output_height,
                "fps": output_fps,
                "frame_count": frame_count,
                "images_output": f"preview_first_{int(images.shape[0])}_frames",
            },
            "timeline": {
                "start": start_time,
                "end": end_time,
                "duration": duration,
            },
            "crop": source_crop,
        }
        return io.NodeOutput(output_video, images, output_fps, frame_count, json.dumps(crop_info, ensure_ascii=False))

    @classmethod
    def validate_inputs(cls, file, **kwargs):
        if not file:
            return "请选择或上传一个视频文件。"
        if not folder_paths.exists_annotated_filepath(file):
            return f"视频文件不存在: {file}"
        return True

    @classmethod
    def fingerprint_inputs(cls, file, width=0, height=0, divisor=DEFAULT_DIVISOR, fps=0.0, preview_frames=DEFAULT_PREVIEW_FRAMES, state=""):
        video_path = folder_paths.get_annotated_filepath(file)
        try:
            mod_time = os.path.getmtime(video_path)
        except OSError:
            mod_time = 0
        return (file, mod_time, width, height, divisor, fps, preview_frames, state)


class _StreamedEditedVideo(Input.Video):
    def __init__(
        self,
        video_path: str,
        start_time: float,
        duration: float,
        source_fps: float,
        output_fps: float,
        source_crop: dict,
        output_width: int,
        output_height: int,
    ):
        self.video_path = video_path
        self.start_time = float(start_time)
        self.duration = float(duration)
        self.source_fps = max(MIN_INTERNAL_FPS, float(source_fps or 1.0))
        self.output_fps = _clamp_float(output_fps or self.source_fps, FPS_MIN, FPS_MAX)
        self.source_crop = dict(source_crop)
        self.output_width = int(output_width)
        self.output_height = int(output_height)

    def get_components(self) -> Types.VideoComponents:
        images = _load_processed_frames(
            self.video_path,
            self.start_time,
            self.duration,
            self.source_fps,
            self.output_fps,
            self.source_crop,
            self.output_width,
            self.output_height,
            max_frames=None,
        )
        audio = _load_audio_components(self.video_path, self.start_time, self.duration)
        metadata = {
            "source_path": self.video_path,
            "start_time": self.start_time,
            "duration": self.duration,
            "source_crop": self.source_crop,
            "output_width": self.output_width,
            "output_height": self.output_height,
        }
        return Types.VideoComponents(images=images, frame_rate=_fps_fraction(self.output_fps), audio=audio, metadata=metadata)

    def get_dimensions(self) -> tuple[int, int]:
        return self.output_width, self.output_height

    def get_duration(self) -> float:
        return self.duration

    def get_frame_count(self) -> int:
        return _output_frame_count(self.duration, self.output_fps)

    def get_bit_depth(self) -> int:
        return 8

    def save_to(
        self,
        path,
        format: Types.VideoContainer = Types.VideoContainer.AUTO,
        codec: Types.VideoCodec = Types.VideoCodec.AUTO,
        metadata: dict | None = None,
        bit_depth: int | None = None,
    ):
        _stream_save_processed_video(
            self.video_path,
            path,
            format,
            codec,
            metadata,
            bit_depth,
            self.start_time,
            self.duration,
            self.source_fps,
            self.output_fps,
            self.source_crop,
            self.output_width,
            self.output_height,
        )

    def as_trimmed(self, start_time: float | None = None, duration: float | None = None, strict_duration: bool = True):
        offset = max(0.0, float(start_time or 0.0))
        if offset >= self.duration:
            return None if strict_duration else self
        next_duration = self.duration - offset if not duration else min(float(duration), self.duration - offset)
        return _StreamedEditedVideo(
            self.video_path,
            self.start_time + offset,
            next_duration,
            self.source_fps,
            self.output_fps,
            self.source_crop,
            self.output_width,
            self.output_height,
        )


def _load_state(state: str) -> dict:
    if not state:
        return {}
    try:
        payload = json.loads(state)
    except json.JSONDecodeError:
        logger.warning("[BrotherPao] VisualVideoEditor state JSON parse failed", exc_info=True)
        return {}
    return payload if isinstance(payload, dict) else {}


def _safe_float(value, fallback: float) -> float:
    try:
        result = float(value)
        if math.isfinite(result) and result > 0:
            return result
    except (TypeError, ValueError):
        pass
    return fallback


def _positive_int(value) -> int | None:
    try:
        result = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _clamp_float(value, minimum: float, maximum: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        result = minimum
    if not math.isfinite(result):
        result = minimum
    return max(minimum, min(maximum, result))


def _clamp_int(value, minimum: int, maximum: int) -> int:
    return int(round(_clamp_float(value, minimum, maximum)))


def _resolve_timeline(payload: dict, source_duration: float) -> tuple[float, float]:
    timeline = payload.get("timeline") if isinstance(payload.get("timeline"), dict) else {}
    try:
        start = float(timeline.get("start", 0.0) or 0.0)
    except (TypeError, ValueError):
        start = 0.0
    try:
        end = float(timeline.get("end", source_duration) or source_duration)
    except (TypeError, ValueError):
        end = source_duration

    if source_duration > 0:
        start = max(0.0, min(start, source_duration))
        end = max(0.0, min(end, source_duration))
    else:
        start = max(0.0, start)
        end = max(start, end)

    if end <= start:
        start = 0.0
        end = source_duration
    return start, end


def _align_dimension(value, divisor: int) -> int:
    try:
        raw = int(round(float(value)))
    except (TypeError, ValueError):
        raw = 1
    if divisor <= 1:
        return max(1, raw)
    rounded = int(round(raw / divisor) * divisor)
    return max(divisor, rounded)


def _align_output_dimension(value, divisor: int) -> int:
    return _clamp_int(_align_dimension(value, divisor), DIMENSION_MIN, DIMENSION_MAX)


def _align_down_dimension(value, divisor: int) -> int:
    try:
        raw = int(math.floor(float(value)))
    except (TypeError, ValueError):
        raw = 1
    if divisor <= 1:
        return max(1, raw)
    return max(1, int(math.floor(raw / divisor) * divisor))


def _resolve_output_size(width, height, source_width: int, source_height: int, divisor: int) -> tuple[int, int]:
    width_value = _positive_int(width) or source_width
    height_value = _positive_int(height) or source_height
    return _align_output_dimension(width_value, divisor), _align_output_dimension(height_value, divisor)


def _read_crop(raw_crop) -> dict | None:
    if not isinstance(raw_crop, dict):
        return None
    try:
        return {
            "x": float(raw_crop.get("x", 0.0) or 0.0),
            "y": float(raw_crop.get("y", 0.0) or 0.0),
            "w": float(raw_crop.get("w", 0.0) or 0.0),
            "h": float(raw_crop.get("h", 0.0) or 0.0),
        }
    except (TypeError, ValueError):
        return None


def _fit_crop_size(output_width: int, output_height: int, desired_w: float, desired_h: float, max_w: int, max_h: int, divisor: int) -> tuple[int, int]:
    ratio = max(0.001, float(output_width) / max(1, float(output_height)))
    limit_w = max(1, int(max_w))
    limit_h = max(1, int(max_h))
    raw_w = max(1.0, float(desired_w or 1.0))
    raw_h = max(1.0, float(desired_h or 1.0))
    use_width = raw_w / raw_h >= ratio
    crop_w = _align_dimension(raw_w if use_width else raw_h * ratio, divisor)
    crop_h = _align_dimension(crop_w / ratio, divisor)

    if crop_w > limit_w or crop_h > limit_h:
        crop_w = _align_down_dimension(min(limit_w, limit_h * ratio), divisor)
        crop_h = _align_down_dimension(crop_w / ratio, divisor)
        while (crop_w > limit_w or crop_h > limit_h) and crop_w > divisor:
            crop_w = _align_down_dimension(crop_w - divisor, divisor)
            crop_h = _align_down_dimension(crop_w / ratio, divisor)

    return max(1, min(limit_w, int(crop_w))), max(1, min(limit_h, int(crop_h)))


def _normalize_source_crop(crop: dict, source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    x = max(0, min(source_width - 1, int(round(float(crop["x"])))))
    y = max(0, min(source_height - 1, int(round(float(crop["y"])))))
    crop_w, crop_h = _fit_crop_size(
        output_width,
        output_height,
        max(1.0, float(crop["w"])),
        max(1.0, float(crop["h"])),
        source_width - x,
        source_height - y,
        divisor,
    )

    return {
        "x": x,
        "y": y,
        "w": crop_w,
        "h": crop_h,
    }


def _default_source_crop(source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    crop_w, crop_h = _fit_crop_size(output_width, output_height, source_width, source_height, source_width, source_height, divisor)
    crop = {
        "x": (source_width - crop_w) / 2,
        "y": (source_height - crop_h) / 2,
        "w": crop_w,
        "h": crop_h,
    }
    return _normalize_source_crop(crop, source_width, source_height, output_width, output_height, divisor)


def _resolve_source_crop(payload: dict, source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    crop = _read_crop(payload.get("crop") if isinstance(payload.get("crop"), dict) else None)
    if crop is None:
        return _default_source_crop(source_width, source_height, output_width, output_height, divisor)
    return _normalize_source_crop(crop, source_width, source_height, output_width, output_height, divisor)


def _output_frame_count(duration: float, fps: float) -> int:
    return max(1, int(round(max(0.0, float(duration)) * max(MIN_INTERNAL_FPS, float(fps)))))


def _fps_fraction(fps: float) -> Fraction:
    return Fraction(round(max(MIN_INTERNAL_FPS, float(fps)) * 1000), 1000)


def _frame_time(frame, stream, fallback: float) -> float:
    if frame.time is not None:
        return float(frame.time)
    if frame.pts is not None and stream.time_base:
        return float(frame.pts * stream.time_base)
    return fallback


def _processed_frame_from_av_frame(frame, source_crop: dict, output_width: int, output_height: int) -> torch.Tensor:
    image = torch.from_numpy(frame.to_ndarray(format="rgb24")).float() / 255.0
    rotation = int(round(getattr(frame, "rotation", 0) or 0))
    if rotation:
        image = torch.rot90(image, k=rotation // 90, dims=(0, 1)).contiguous()
    image = _crop_and_resize(image.unsqueeze(0), source_crop, output_width, output_height)
    return image[0].contiguous()


def _iter_processed_frames(
    video_path: str,
    start_time: float,
    duration: float,
    source_fps: float,
    output_fps: float,
    source_crop: dict,
    output_width: int,
    output_height: int,
    max_frames: int | None = None,
):
    target_count = _output_frame_count(duration, output_fps)
    next_index = 0
    emitted = 0
    decoded = 0
    last_processed = None
    end_time = start_time + duration

    with av.open(video_path, mode="r") as container:
        if not container.streams.video:
            return
        stream = container.streams.video[0]
        if start_time > 0 and stream.time_base:
            try:
                container.seek(max(0, int(start_time / stream.time_base)), stream=stream, any_frame=False, backward=True)
            except Exception:
                logger.debug("[BrotherPao] Video seek failed, decoding from start", exc_info=True)

        for packet in container.demux(stream):
            try:
                frames = packet.decode()
            except av.error.InvalidDataError:
                logger.debug("[BrotherPao] Skipping invalid video packet", exc_info=True)
                continue

            for frame in frames:
                fallback_time = start_time + decoded / max(MIN_INTERNAL_FPS, source_fps)
                decoded += 1
                abs_time = _frame_time(frame, stream, fallback_time)
                if abs_time + 1e-6 < start_time:
                    continue
                if abs_time > end_time + 1e-6:
                    if last_processed is not None:
                        while next_index < target_count:
                            yield last_processed
                            emitted += 1
                            next_index += 1
                            if max_frames is not None and emitted >= max_frames:
                                return
                    return

                rel_time = max(0.0, min(duration, abs_time - start_time))
                target_index = min(target_count - 1, int(round(rel_time * output_fps)))
                if target_index < next_index:
                    continue

                last_processed = _processed_frame_from_av_frame(frame, source_crop, output_width, output_height)
                while next_index <= target_index:
                    yield last_processed
                    emitted += 1
                    next_index += 1
                    if next_index >= target_count or (max_frames is not None and emitted >= max_frames):
                        return

    if last_processed is not None:
        while next_index < target_count:
            yield last_processed
            emitted += 1
            next_index += 1
            if max_frames is not None and emitted >= max_frames:
                return


def _load_processed_frames(
    video_path: str,
    start_time: float,
    duration: float,
    source_fps: float,
    output_fps: float,
    source_crop: dict,
    output_width: int,
    output_height: int,
    max_frames: int | None = None,
) -> torch.Tensor:
    frames = list(_iter_processed_frames(
        video_path,
        start_time,
        duration,
        source_fps,
        output_fps,
        source_crop,
        output_width,
        output_height,
        max_frames=max_frames,
    ))
    if not frames:
        return torch.zeros((1, output_height, output_width, 3), dtype=torch.float32)
    return torch.stack(frames).clamp(0.0, 1.0)


def _load_preview_frames(
    video_path: str,
    start_time: float,
    duration: float,
    source_fps: float,
    output_fps: float,
    source_crop: dict,
    output_width: int,
    output_height: int,
    max_frames: int,
) -> torch.Tensor:
    return _load_processed_frames(
        video_path,
        start_time,
        duration,
        source_fps,
        output_fps,
        source_crop,
        output_width,
        output_height,
        max_frames=max_frames,
    )


def _coerce_video_container(value) -> Types.VideoContainer:
    if isinstance(value, Types.VideoContainer):
        return value
    return Types.VideoContainer(value or Types.VideoContainer.AUTO)


def _coerce_video_codec(value) -> Types.VideoCodec:
    if isinstance(value, Types.VideoCodec):
        return value
    return Types.VideoCodec(value or Types.VideoCodec.AUTO)


def _write_metadata(container, metadata: dict | None):
    if not metadata:
        return
    for key, value in metadata.items():
        container.metadata[key] = value if isinstance(value, str) else json.dumps(value)


def _audio_stream_info(video_path: str):
    with av.open(video_path, mode="r") as container:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[-1]
        sample_rate = int(
            getattr(stream, "sample_rate", None)
            or getattr(stream, "rate", None)
            or getattr(stream.codec_context, "sample_rate", None)
            or 44100
        )
        layout = stream.layout.name if stream.layout else "stereo"
        return sample_rate, layout


def _load_audio_components(video_path: str, start_time: float, duration: float) -> Input.Audio | None:
    end_time = start_time + duration
    audio_chunks = []

    with av.open(video_path, mode="r") as container:
        if not container.streams.audio:
            return None

        stream = container.streams.audio[-1]
        sample_rate = int(
            getattr(stream, "sample_rate", None)
            or getattr(stream, "rate", None)
            or getattr(stream.codec_context, "sample_rate", None)
            or 44100
        )
        resampler = av.audio.resampler.AudioResampler(format="fltp")
        has_first_audio_frame = False
        audio_done = False

        if start_time > 0 and stream.time_base:
            try:
                container.seek(max(0, int(start_time / stream.time_base)), stream=stream, any_frame=False, backward=True)
            except Exception:
                logger.debug("[BrotherPao] Audio component seek failed, decoding from start", exc_info=True)

        for packet in container.demux(stream):
            if audio_done:
                break
            try:
                decoded_frames = packet.decode()
            except av.error.InvalidDataError:
                logger.debug("[BrotherPao] Skipping invalid audio packet while loading components", exc_info=True)
                continue

            for decoded in decoded_frames:
                for frame in resampler.resample(decoded):
                    frame_time = _frame_time(frame, stream, 0.0)
                    if frame_time > end_time:
                        audio_done = True
                        break

                    data = frame.to_ndarray()
                    if not has_first_audio_frame:
                        offset_seconds = max(0.0, start_time - frame_time)
                        to_skip = max(0, int(offset_seconds * sample_rate))
                        if to_skip >= data.shape[-1]:
                            continue
                        data = data[..., to_skip:]
                        has_first_audio_frame = True

                    audio_chunks.append(data)
                if audio_done:
                    break

    if not audio_chunks:
        return None

    audio_data = np.concatenate(audio_chunks, axis=1)
    expected_samples = max(1, int(round(duration * sample_rate)))
    audio_data = audio_data[..., :expected_samples]
    if audio_data.shape[-1] <= 0:
        return None

    waveform = torch.from_numpy(np.ascontiguousarray(audio_data)).unsqueeze(0).float()
    return {"waveform": waveform, "sample_rate": sample_rate}


def _copy_trimmed_audio(video_path: str, output_container, output_stream, start_time: float, duration: float):
    end_time = start_time + duration
    with av.open(video_path, mode="r") as container:
        if not container.streams.audio:
            return
        input_stream = container.streams.audio[-1]
        if start_time > 0 and input_stream.time_base:
            try:
                container.seek(max(0, int(start_time / input_stream.time_base)), stream=input_stream, any_frame=False, backward=True)
            except Exception:
                logger.debug("[BrotherPao] Audio seek failed, decoding from start", exc_info=True)

        for packet in container.demux(input_stream):
            try:
                frames = packet.decode()
            except av.error.InvalidDataError:
                logger.debug("[BrotherPao] Skipping invalid audio packet", exc_info=True)
                continue
            for frame in frames:
                frame_start = _frame_time(frame, input_stream, 0.0)
                frame_duration = frame.samples / max(1, int(frame.sample_rate or output_stream.rate or 44100))
                if frame_start + frame_duration < start_time:
                    continue
                if frame_start > end_time:
                    for encoded in output_stream.encode(None):
                        output_container.mux(encoded)
                    return
                frame.pts = None
                for encoded in output_stream.encode(frame):
                    output_container.mux(encoded)

    for encoded in output_stream.encode(None):
        output_container.mux(encoded)


def _stream_save_processed_video(
    video_path: str,
    path,
    format,
    codec,
    metadata: dict | None,
    bit_depth: int | None,
    start_time: float,
    duration: float,
    source_fps: float,
    output_fps: float,
    source_crop: dict,
    output_width: int,
    output_height: int,
):
    container_format = _coerce_video_container(format)
    video_codec = _coerce_video_codec(codec)
    if container_format not in (Types.VideoContainer.AUTO, Types.VideoContainer.MP4):
        raise ValueError("可视化视频编辑节点当前只支持保存 MP4。")
    if video_codec not in (Types.VideoCodec.AUTO, Types.VideoCodec.H264):
        raise ValueError("可视化视频编辑节点当前只支持 H.264 编码。")

    if bit_depth is None:
        bit_depth = 8
    is_10bit = int(bit_depth) >= 10
    extra_kwargs = {}
    if container_format != Types.VideoContainer.AUTO:
        extra_kwargs["format"] = container_format.value
    elif not isinstance(path, (str, bytes, os.PathLike)):
        extra_kwargs["format"] = "mp4"

    with av.open(path, mode="w", options={"movflags": "use_metadata_tags"}, **extra_kwargs) as output:
        _write_metadata(output, metadata)

        frame_rate = _fps_fraction(output_fps)
        video_stream = output.add_stream("h264", rate=frame_rate)
        video_stream.width = output_width
        video_stream.height = output_height
        video_stream.pix_fmt = "yuv420p10le" if is_10bit else "yuv420p"

        audio_info = _audio_stream_info(video_path)
        audio_stream = None
        if audio_info is not None:
            sample_rate, layout = audio_info
            try:
                audio_stream = output.add_stream("aac", rate=sample_rate, layout=layout)
            except Exception:
                logger.warning("[BrotherPao] Failed to create output audio stream; exporting video without audio", exc_info=True)

        wrote_frame = False
        for frame in _iter_processed_frames(
            video_path,
            start_time,
            duration,
            source_fps,
            output_fps,
            source_crop,
            output_width,
            output_height,
            max_frames=None,
        ):
            if is_10bit:
                array = (frame.float() * 65535).clamp(0, 65535).cpu().numpy().astype("uint16")
                av_frame = av.VideoFrame.from_ndarray(array, format="rgb48le")
            else:
                array = (frame * 255).clamp(0, 255).byte().cpu().numpy()
                av_frame = av.VideoFrame.from_ndarray(array, format="rgb24")
            av_frame = av_frame.reformat(format=video_stream.pix_fmt)
            for packet in video_stream.encode(av_frame):
                output.mux(packet)
            wrote_frame = True

        if not wrote_frame:
            array = torch.zeros((output_height, output_width, 3), dtype=torch.uint8).numpy()
            av_frame = av.VideoFrame.from_ndarray(array, format="rgb24").reformat(format=video_stream.pix_fmt)
            for packet in video_stream.encode(av_frame):
                output.mux(packet)

        for packet in video_stream.encode(None):
            output.mux(packet)

        if audio_stream is not None:
            _copy_trimmed_audio(video_path, output, audio_stream, start_time, duration)


def _crop_and_resize(images: torch.Tensor, crop: dict, target_width: int, target_height: int) -> torch.Tensor:
    source_height = int(images.shape[1])
    source_width = int(images.shape[2])
    x = max(0, min(source_width - 1, int(crop["x"])))
    y = max(0, min(source_height - 1, int(crop["y"])))
    w = max(1, min(source_width - x, int(crop["w"])))
    h = max(1, min(source_height - y, int(crop["h"])))

    cropped = images[:, y:y + h, x:x + w, :]
    resized = F.interpolate(
        cropped.movedim(-1, 1),
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    return resized.clamp(0.0, 1.0)
