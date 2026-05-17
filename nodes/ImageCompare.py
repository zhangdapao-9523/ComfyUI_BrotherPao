import base64
import gc
import io
import logging

import numpy
from PIL import Image

logger = logging.getLogger(__name__)

BASE64_CHUNK_SIZE = 65536


class ImageCompareNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "compare"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"
    OUTPUT_NODE = True

    def compare(self, image_a, image_b):
        if image_a is None or image_b is None or len(image_a) == 0 or len(image_b) == 0:
            return {}

        if image_a.shape[0] > 1 or image_b.shape[0] > 1:
            logger.warning("图像对比节点仅处理第一帧，批次中的其余帧将被忽略")

        try:
            pil_a = self._tensor_to_pil(image_a)
            pil_b = self._tensor_to_pil(image_b)

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


IMAGE_COMPARE_CLASS_MAPPINGS = {"BrotherPao_ImageCompare": ImageCompareNode}
IMAGE_COMPARE_DISPLAY_NAME_MAPPINGS = {"BrotherPao_ImageCompare": "图像对比"}
