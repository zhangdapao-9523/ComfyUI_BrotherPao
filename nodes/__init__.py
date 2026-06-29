from comfy_api.latest import ComfyExtension, io

from .BaiduTranslate import BaiduTransDevApi
from .DictionaryNodes import DictionaryGet, DictionaryNew, DictionaryUpdate
from .FramesEditor import FramesEditor
from .ImageColorMatch import ImageColorMatch
from .ImageCompare import ImageCompareNode
from .ImageTileNodes import ImageAssemble, ImageResolutionDivider, ImageTileBatch
from .InpaintCropAndStitch import InpaintCropImproved, InpaintStitchImproved
from .IsNoInput import IsNoInput
from .QwenMultiangle import QwenMultiangleCameraNode
from .VisualVideoEditor import VisualVideoEditor
from .YoloDetect import YoloDetect


BROTHERPAO_NODE_CLASSES: list[type[io.ComfyNode]] = [
    BaiduTransDevApi,
    DictionaryUpdate,
    DictionaryGet,
    DictionaryNew,
    FramesEditor,
    ImageCompareNode,
    ImageTileBatch,
    ImageResolutionDivider,
    ImageAssemble,
    ImageColorMatch,
    InpaintCropImproved,
    InpaintStitchImproved,
    IsNoInput,
    YoloDetect,
    QwenMultiangleCameraNode,
    VisualVideoEditor,
]


class BrotherPaoExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return BROTHERPAO_NODE_CLASSES


async def comfy_entrypoint() -> BrotherPaoExtension:
    return BrotherPaoExtension()


__all__ = ["BROTHERPAO_NODE_CLASSES", "BrotherPaoExtension", "comfy_entrypoint"]
