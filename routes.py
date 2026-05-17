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
