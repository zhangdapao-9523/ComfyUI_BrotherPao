import base64
import gc
import io

import numpy
from PIL import Image

BASE64_CHUNK_SIZE = 65536


class ImageCompareNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE",),
                "对比图": ("IMAGE",),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "compare"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"
    OUTPUT_NODE = True

    def compare(self, 原图, 对比图):
        if 原图 is None or 对比图 is None or len(原图) == 0 or len(对比图) == 0:
            return {}

        try:
            pil_a = self._tensor_to_pil(原图)
            pil_b = self._tensor_to_pil(对比图)

            b64_a = self._pil_to_base64_chunks(pil_a)
            b64_b = self._pil_to_base64_chunks(pil_b)

            return {"ui": {"b64_a": b64_a, "b64_b": b64_b}}
        finally:
            gc.collect()

    @staticmethod
    def _tensor_to_pil(img_tensor):
        try:
            arr = (
                img_tensor[0].cpu().numpy() * 255
            ).clip(0, 255).astype(numpy.uint8)
            return Image.fromarray(arr)
        except Exception as e:
            raise ValueError(f"图像张量转换失败: {e}") from e

    @staticmethod
    def _pil_to_base64_chunks(img):
        buffer = io.BytesIO()
        try:
            img.save(buffer, format="PNG")
            buffer.seek(0)
            encoded = base64.b64encode(buffer.read()).decode("utf-8")
        finally:
            buffer.close()

        return [
            encoded[i:i + BASE64_CHUNK_SIZE]
            for i in range(0, len(encoded), BASE64_CHUNK_SIZE)
        ]


IMAGE_COMPARE_CLASS_MAPPINGS = {"ImageCompareNode": ImageCompareNode}
IMAGE_COMPARE_DISPLAY_NAME_MAPPINGS = {"ImageCompareNode": "图像对比"}
