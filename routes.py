import logging

from aiohttp import web
from server import PromptServer

from .config_manager import load_config, save_config

logger = logging.getLogger(__name__)


@PromptServer.instance.routes.get("/brotherpao/config")
async def get_config(request):
    try:
        config = load_config()
        return web.json_response(config)
    except Exception as e:
        logger.error("[BrotherPao] get_config failed: %s", e)
        return web.json_response({"error": "读取配置失败"}, status=500)


@PromptServer.instance.routes.post("/brotherpao/config")
async def update_config(request):
    try:
        post = await request.json()
        config = load_config()
        config.update(post)
        save_config(config)
        return web.json_response({"status": "success"})
    except Exception as e:
        logger.error("[BrotherPao] update_config failed: %s", e)
        return web.json_response({"error": "更新配置失败"}, status=500)


@PromptServer.instance.routes.get("/brotherpao/prompt_rules")
async def get_prompt_rules(request):
    try:
        from .nodes.QwenMultiangle import PROMPT_RULES
        return web.json_response(PROMPT_RULES)
    except Exception as e:
        logger.error("[BrotherPao] get_prompt_rules failed: %s", e)
        return web.json_response({"error": "读取提示词规则失败"}, status=500)


@PromptServer.instance.routes.get("/brotherpao/video_metadata")
async def get_video_metadata(request):
    try:
        file = request.rel_url.query.get("file", "")
        if not file:
            return web.json_response({"error": "缺少视频文件参数"}, status=400)

        import folder_paths
        from comfy_api.latest import InputImpl

        if not folder_paths.exists_annotated_filepath(file):
            return web.json_response({"error": f"视频文件不存在: {file}"}, status=404)

        video = InputImpl.VideoFromFile(folder_paths.get_annotated_filepath(file))
        width, height = video.get_dimensions()
        return web.json_response({
            "file": file,
            "width": width,
            "height": height,
            "duration": float(video.get_duration()),
            "fps": float(video.get_frame_rate()),
            "frame_count": int(video.get_frame_count()),
            "bit_depth": int(video.get_bit_depth()),
        })
    except Exception as e:
        logger.error("[BrotherPao] get_video_metadata failed: %s", e, exc_info=True)
        return web.json_response({"error": "读取视频元数据失败"}, status=500)


@PromptServer.instance.routes.get("/brotherpao/image_metadata")
async def get_image_metadata(request):
    try:
        file = request.rel_url.query.get("file", "")
        if not file:
            return web.json_response({"error": "缺少图像文件参数"}, status=400)

        import folder_paths
        from PIL import Image, ImageOps

        if not folder_paths.exists_annotated_filepath(file):
            return web.json_response({"error": f"图像文件不存在: {file}"}, status=404)

        image_path = folder_paths.get_annotated_filepath(file)
        with Image.open(image_path) as raw:
            try:
                raw.seek(0)
            except EOFError:
                pass
            image = ImageOps.exif_transpose(raw)
            width, height = image.size
            mode = image.mode
            has_alpha = "A" in image.getbands() or "transparency" in image.info

        return web.json_response({
            "file": file,
            "width": int(width),
            "height": int(height),
            "mode": mode,
            "has_alpha": bool(has_alpha),
        })
    except Exception as e:
        logger.error("[BrotherPao] get_image_metadata failed: %s", e, exc_info=True)
        return web.json_response({"error": "读取图像元数据失败"}, status=500)
