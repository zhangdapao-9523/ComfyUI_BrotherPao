import os
import json
import tempfile
import threading

_config_dir = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(_config_dir, "config.json")
CONFIG_EXAMPLE = os.path.join(_config_dir, "config.json.example")
_lock = threading.RLock()


def _read_json(path):
    try:
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except (json.JSONDecodeError, OSError):
        pass
    return None


def load_config():
    with _lock:
        config = _read_json(CONFIG_FILE)
        if config is not None:
            return config
        config = _read_json(CONFIG_EXAMPLE)
        if config is not None:
            return config
        return {}


def save_config(config):
    with _lock:
        dirpath = os.path.dirname(CONFIG_FILE)
        tmpname = None
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', encoding='utf-8',
                dir=dirpath, delete=False, suffix='.tmp'
            ) as tf:
                json.dump(config, tf, indent=4, ensure_ascii=False)
                tmpname = tf.name
            os.replace(tmpname, CONFIG_FILE)
        except Exception:
            if tmpname and os.path.exists(tmpname):
                os.unlink(tmpname)
            raise


def get_baidu_credentials():
    config = load_config()
    baidu_cfg = config.get('baidu_translate', {})
    appid = baidu_cfg.get('appid', '')
    appkey = baidu_cfg.get('appkey', '')
    if not appid or not appkey:
        return None, None
    return appid, appkey
