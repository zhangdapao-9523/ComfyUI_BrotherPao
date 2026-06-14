import base64
import gc
import io as std_io
import logging

from comfy_api.latest import io

from .utils import tensor2pil

logger = logging.getLogger(__name__)

BASE64_CHUNK_SIZE = 65536


class ImageCompareNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_ImageCompare",
            display_name="图像对比",
            category="❤️‍🩹炮哥Nodes/图像操作",
            inputs=[
                io.Image.Input("image_a"),
                io.Image.Input("image_b"),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, image_a=None, image_b=None):
        if image_a is None or image_b is None or len(image_a) == 0 or len(image_b) == 0:
            return io.NodeOutput()

        if image_a.shape[0] > 1 or image_b.shape[0] > 1:
            logger.warning("图像对比节点仅处理第一帧，批次中的其余帧将被忽略")

        try:
            pil_a = tensor2pil(image_a)
            pil_b = tensor2pil(image_b)

            b64_a = cls._pil_to_base64_chunks(pil_a)
            b64_b = cls._pil_to_base64_chunks(pil_b)

            return io.NodeOutput(ui={"b64_a": b64_a, "b64_b": b64_b})
        finally:
            gc.collect()

    @staticmethod
    def _pil_to_base64_chunks(img):
        buffer = std_io.BytesIO()
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
