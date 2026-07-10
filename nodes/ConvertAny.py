import math
from collections.abc import Sequence

from comfy_api.latest import io


TRUE_TEXT = {"true", "yes", "y", "on", "1", "是", "真"}
FALSE_TEXT = {"false", "no", "n", "off", "0", "none", "null", "", "否", "假"}


def _unwrap_scalar(value):
    if isinstance(value, (str, bytes, bytearray)):
        return value
    if isinstance(value, Sequence) and value:
        return value[0]
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            return value
    return value


def _stringify(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _to_float(value, default=0.0):
    value = _unwrap_scalar(value)

    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        result = float(value)
    elif isinstance(value, str):
        text = value.strip()
        lowered = text.lower()
        if lowered in TRUE_TEXT:
            return 1.0
        if lowered in FALSE_TEXT:
            return 0.0
        try:
            result = float(text)
        except ValueError:
            return default
    else:
        try:
            result = float(value)
        except (TypeError, ValueError):
            return default

    if not math.isfinite(result):
        return default
    return result


def _to_int(value, default=0):
    value = _unwrap_scalar(value)

    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) else default
    if isinstance(value, str):
        text = value.strip()
        lowered = text.lower()
        if lowered in TRUE_TEXT:
            return 1
        if lowered in FALSE_TEXT:
            return 0
        try:
            return int(text, 0)
        except ValueError:
            parsed = _to_float(text, None)
            return int(parsed) if parsed is not None else default

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_bool(value):
    value = _unwrap_scalar(value)

    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(value) and value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in TRUE_TEXT:
            return True
        if lowered in FALSE_TEXT:
            return False
        parsed = _to_float(value, None)
        if parsed is not None:
            return parsed != 0
        return bool(lowered)

    try:
        return bool(value)
    except Exception:
        return True


class ConvertAny(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_ConvertAny",
            display_name="转换数据类型",
            category="❤️‍🩹炮哥Nodes/实用工具",
            description="将任意输入转换为下拉框选择的目标类型。",
            search_aliases=[
                "转换任何",
                "Convert Any",
                "convert anything",
                "type cast",
                "string to combo",
            ],
            inputs=[
                io.AnyType.Input(
                    "*",
                    display_name="输入任何",
                    tooltip="任意类型输入。",
                ),
                io.Combo.Input(
                    "output_type",
                    options=["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"],
                    default="STRING",
                    tooltip="选择输出接口的数据类型。COMBO 是 ComfyUI 下拉框/名称参数的底层类型。",
                ),
            ],
            outputs=[
                io.AnyType.Output("output", display_name="STRING"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs):
        value = kwargs.get("*")
        output_type = str(kwargs.get("output_type", "STRING")).upper()
        converters = {
            "STRING": _stringify,
            "INT": _to_int,
            "FLOAT": _to_float,
            "BOOLEAN": _to_bool,
            "COMBO": _stringify,
        }
        return io.NodeOutput(converters.get(output_type, _stringify)(value))
